//! Fleet chatroom composer — the write path (HED-74c). Beside `reader.rs` (read-only comms.db
//! views), this is the ONLY thing in the app that ever changes fleet comms state, and unlike
//! `reader.rs` it never touches `comms.db` directly: every write crosses the wire to heddle's
//! `heddle-comms` MCP broker (`src/comms/server.ts`), spawned and owned here under the OPERATOR
//! role, over the official `rmcp` client SDK's (crates.io, client + child-process-transport
//! features only) stdio child-process transport — never hand-rolled JSON-RPC. The broker is the
//! only thing that ever writes `comms.db`; this module only ever writes to the broker's stdin.
//!
//! SECURITY CONTRACT (non-negotiable — this is the point of the module): the operator token
//! (`~/.heddle/operator.token`) reaches the child ONLY via its environment
//! (`HEDDLE_COMMS_OPERATOR_TOKEN`) — never argv, never a log line, never a string returned to the
//! frontend, never inside an error. [`redact`] scrubs it — both its raw and JSON-escaped form —
//! from every `Err` this module returns. `HEDDLE_COMMS_PUSH` is explicitly removed from the
//! child's environment (not merely left unset), so it can never leak in from this process's own
//! environment (the operator stays pull-only; see the fleet comms contract); the standard AppImage/
//! loader env vars (`SCRUBBED_LOADER_ENV_VARS`) are removed the same way — see `build_command`.
//!
//! BINARY RESOLUTION, in order (see `resolve_binary`): (1) an explicit override at
//! `vlx-settings.comms.operatorBinPath` — the same `app_settings` blob and shape
//! `pty::manager::agent_bin_path` reads for per-agent executable overrides, just a new top-level
//! `comms` key (not yet surfaced in `PersistedSettings`/any settings UI — that is a follow-up);
//! (2) `heddle-comms` on `PATH`, augmented the same way `heddle_stats` augments it for `ccusage`/
//! `agy` so a Dock/Finder-launched GUI (no shell PATH) can still find an npm/bun/brew install;
//! (3) `vlx-settings.comms.heddleCoreRoot` → `node <root>/dist/comms/channel-server.js`, only when
//! that file actually exists; (4) auto-detect: the same `node <root>/dist/comms/channel-server.js`
//! check against a fixed, home-relative list of CONVENTIONAL heddle-core checkout locations (see
//! `conventional_core_roots`), so a Dock-launched app with no settings/env configured yet can still
//! find a conventional dev checkout; (5) none of the above → `"no-binary"`.
//!
//! "KILL ON APP EXIT" is wired: [`shutdown`] is called from `tauri::RunEvent::Exit` in `lib.rs`
//! (outside this dispatch's file scope — command registration only), so a quitting app cancels the
//! live child instead of relying solely on `Drop`. `RunningService`'s own `Drop` cancels its task
//! and `TokioChildProcess`'s `Drop` kills the OS child — both still fire as a fallback net if this
//! module's state is ever dropped some other way — but a `'static` `OnceLock` is never dropped at
//! normal process exit (Rust does not run destructors for statics), which is exactly why the
//! explicit `RunEvent::Exit` call is the one that matters.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::{RunningService, ServiceExt};
use rmcp::transport::{ConfigureCommandExt, TokioChildProcess};
use rmcp::RoleClient;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::heddle_stats::augmented_path;
use crate::host::AppCtx;
use crate::models::Project;

/// Minimum time between spawn RETRY attempts after a spawn attempt itself just failed, so a
/// persistently broken binary/root setting cannot be re-attempted on every single composer action.
/// This does NOT throttle recovery from a crash of a previously-*working* child — see `ensure_client`.
const SPAWN_BACKOFF: Duration = Duration::from_secs(10);

/// Bounds a single broker round-trip (`call_tool`) and the spawn/handshake (`ensure_client`) alike
/// — a hung child must surface as an ordinary `"spawn-failed"` result, never block its caller (or,
/// before this fix, every OTHER caller sharing the state lock) forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// `{available, revoked, reason}` — see the module doc for the resolution/backoff this reflects.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperatorStatus {
    available: bool,
    revoked: bool,
    reason: Option<&'static str>,
}

/// The lazily-spawned operator child and its retry bookkeeping, held for the app's lifetime.
struct OperatorState {
    /// `Arc`-wrapped so `call_tool` can clone the handle out and release this struct's lock BEFORE
    /// awaiting the broker round-trip (see `call_tool`/`ensure_client`) — the lock must never be
    /// held across an unbounded `.await`.
    client: Option<Arc<RunningService<RoleClient, ()>>>,
    /// The token last handed to a live (or most recently attempted) child — kept only so any
    /// error string this module returns can be scrubbed of it; never logged, never exposed.
    token: Option<String>,
    last_spawn_failure: Option<Instant>,
    last_reason: Option<&'static str>,
}

impl OperatorState {
    const fn new() -> Self {
        Self {
            client: None,
            token: None,
            last_spawn_failure: None,
            last_reason: None,
        }
    }
}

static STATE: OnceLock<AsyncMutex<OperatorState>> = OnceLock::new();

fn state() -> &'static AsyncMutex<OperatorState> {
    STATE.get_or_init(|| AsyncMutex::new(OperatorState::new()))
}

/// Serializes actual spawn ATTEMPTS only — deliberately a DIFFERENT lock than `state()`'s, so an
/// in-flight spawn/handshake (bounded by `CALL_TIMEOUT`) never blocks a concurrent status poll or
/// another caller's fast "is a client already live?" check (see `ensure_client`). Without this,
/// releasing `state()`'s lock across the spawn/handshake — required to fix B2 — would let two
/// concurrent callers race into spawning two children for one operator token; this makes the
/// second one queue behind the first instead.
static SPAWN_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn spawn_lock() -> &'static AsyncMutex<()> {
    SPAWN_LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// Every string this module hands back — Ok payload text or Err — is passed through this once a
/// token has been read this session, so a token that leaked into a spawn/IO/protocol error message
/// (never expected, but not something every current and future error `Display` impl can be proven
/// to avoid) can never reach the frontend. Replaces BOTH the raw token AND its JSON-escaped
/// rendering: a value serialized via `serde_json` (see `redact_value`, which routes through here)
/// differs from the raw token whenever the token contains a character JSON escapes (`"`, `\`, a
/// control char), so a raw-substring replace alone would miss it there.
fn redact(s: String, token: Option<&str>) -> String {
    match token {
        Some(t) if !t.is_empty() => {
            let s = s.replace(t, "[REDACTED]");
            match json_escaped(t) {
                Some(escaped) if escaped != t => s.replace(&escaped, "[REDACTED]"),
                _ => s,
            }
        }
        _ => s,
    }
}

/// `token`'s JSON string-escaped rendering, WITHOUT the surrounding quotes — e.g. `a"b` becomes
/// `a\"b`. `serde_json::to_string` on a `&str` cannot fail; the opening/closing `"` are always
/// exactly one ASCII byte each, so slicing them off is always on a valid char boundary.
fn json_escaped(token: &str) -> Option<String> {
    let quoted = serde_json::to_string(token).ok()?;
    quoted.get(1..quoted.len() - 1).map(str::to_string)
}

/// Run a blocking read (settings DB + token file) on the blocking pool — same rationale as
/// `reader::blocking`: synchronous work must never stall the UI thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

fn operator_token_path() -> Option<PathBuf> {
    Some(crate::host::home_dir()?.join(".heddle").join("operator.token"))
}

/// Trimmed contents of the token file at `path`, or `None` when absent/empty/unreadable — all
/// three collapse to the same "no-token" status. Split from `read_operator_token` so tests can
/// inject a fixture path without touching the real `$HOME` (global env mutation is unsafe across
/// this binary's parallel test threads).
fn token_from_file(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Matches `heddle-comms --init-operator-token`'s single output file (49 bytes, mode 0600, per the
/// verified fixture facts) — unless `vlx-settings.comms.operatorTokenPath` overrides the location
/// (same override shape as the binary tiers; also the seam tests use instead of the real
/// `$HOME`/`~/.heddle/operator.token`, since mutating global env across this binary's parallel
/// test threads would be unsafe).
fn read_operator_token(settings: Option<&Value>) -> Option<String> {
    match setting_str(settings, "operatorTokenPath") {
        Some(p) => token_from_file(std::path::Path::new(&p)),
        None => token_from_file(&operator_token_path()?),
    }
}

/// Expands a leading `~/` (and a manually entered `~\`), the same way
/// `pty::manager::agent_bin_path` does for agent executable overrides; every other path is
/// returned unchanged.
fn expand_tilde(p: &str) -> String {
    let rest = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\"));
    match rest.zip(crate::host::home_dir()) {
        Some((rest, home)) => home.join(rest).to_string_lossy().into_owned(),
        None => p.to_string(),
    }
}

/// `vlx-settings`'s parsed JSON blob — the same `app_settings` key `PersistedSettings` and
/// `agy_bin` read — or `None` on any missing/unreadable/malformed step; every step degrades to
/// "keep resolving" rather than failing the whole lookup.
fn settings_json(ctx: &AppCtx) -> Option<Value> {
    let raw = {
        let conn = ctx.db().conn.lock().ok()?;
        crate::db::repo::get_app_settings(&conn)
            .ok()?
            .remove("vlx-settings")?
    };
    serde_json::from_str(&raw).ok()
}

/// A trimmed, tilde-expanded string at `vlx-settings.comms.<key>`, or `None` when absent/blank.
fn setting_str(settings: Option<&Value>, key: &str) -> Option<String> {
    let s = settings?.get("comms")?.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| expand_tilde(s))
}

/// Whether `name` resolves to a file somewhere on `path` — mirrors
/// `pty::manager::find_on_path`'s scan (that one is Windows-only and private; this needs every
/// platform and a caller-supplied augmented `PATH`).
fn on_path(name: &str, path: &std::ffi::OsStr) -> bool {
    std::env::split_paths(path).any(|dir| dir.join(name).is_file())
}

/// Every `node <script>` tier shares this: it only counts as resolved when `node` itself is on the
/// augmented PATH. Without this, a `heddleCoreRoot`/`HEDDLE_HOME`/auto-detected root with the script
/// present but no `node` binary anywhere would report itself available and fail confusingly at spawn
/// time instead of status honestly reporting `"no-binary"`.
fn node_tier(script: String) -> Option<(String, Vec<String>)> {
    node_tier_with_path(script, &augmented_path())
}

/// The path-injectable half of [`node_tier`], kept pure so tests can prove a discovered core script
/// is skipped when the child interpreter is unavailable.
fn node_tier_with_path(script: String, path: &std::ffi::OsStr) -> Option<(String, Vec<String>)> {
    on_path("node", path).then(|| ("node".to_string(), vec![script]))
}

/// The four-tier binary search from the module doc, plus the implicit fifth (`None`) — tier logic
/// lives in `resolve_binary_with_roots`; this just supplies the real conventional-root list
/// (`conventional_core_roots`, this machine's actual `$HOME`) for tier 4's auto-detect.
fn resolve_binary(settings: Option<&Value>) -> Option<(String, Vec<String>)> {
    resolve_binary_with_roots(settings, &conventional_core_roots())
}

/// Where the broker binary can come from, most explicit first. Tier 1 is trusted as typed, exactly
/// like `agy_bin`'s own explicit-override tier; tiers 2 through 4 are only returned once this
/// function has itself confirmed the candidate file exists, so a merely-set `heddleCoreRoot` — or an
/// auto-detected conventional root — can never masquerade as "available" when nothing is actually
/// there. Env tiers exist because the two settings tiers currently have no UI: heddle is not
/// published to npm, not a dependency of this app, and (measured on this machine) `heddle-comms` is
/// on no PATH the app searches — so without them the composer would be permanently "no-binary" with
/// no in-app way to fix it. Tier 4 (auto-detect) is checked strictly LAST, after every explicit
/// tier, so a real override or install always wins; it is never a single unconditionally-trusted
/// hardcoded path, only a fixed, home-relative list that still must pass the same existence check
/// as tier 3.
///
/// `conventional_roots` is passed in (rather than this function calling `conventional_core_roots`
/// itself) purely so `operator_tests.rs` can prove tier ordering against an injected temp root —
/// this machine's real `$HOME` may legitimately already have a real heddle checkout in it (that's
/// the whole point of tier 4), which would make a test that relied on the real home directory flaky.
fn resolve_binary_with_roots(
    settings: Option<&Value>,
    conventional_roots: &[PathBuf],
) -> Option<(String, Vec<String>)> {
    if let Some(p) = setting_str(settings, "operatorBinPath") {
        return Some((p, Vec::new()));
    }
    if let Some(p) = env_nonempty("HEDDLE_COMMS_BIN") {
        return Some((p, Vec::new()));
    }
    if on_path("heddle-comms", &augmented_path()) {
        return Some(("heddle-comms".to_string(), Vec::new()));
    }
    for root in [
        setting_str(settings, "heddleCoreRoot"),
        env_nonempty("HEDDLE_HOME"),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(script) = core_script(&root) {
            if let Some(tier) = node_tier(script) {
                return Some(tier);
            }
        }
    }
    if let Some(script) = first_core_root(conventional_roots) {
        return node_tier(script);
    }
    None
}

/// `<root>/dist/comms/channel-server.js`, only if it actually exists on disk.
fn core_script(root: &str) -> Option<String> {
    let script = PathBuf::from(root)
        .join("dist")
        .join("comms")
        .join("channel-server.js");
    script
        .is_file()
        .then(|| script.to_string_lossy().into_owned())
}

/// Conventional locations a heddle core checkout lives in, checked ONLY as a last resort after every
/// explicit tier (settings/env/PATH) so a real install or an operator override always wins. Each is
/// accepted only if its channel-server.js actually exists, so this can never resolve to a wrong path;
/// it just spares the common dev setup (heddle beside heddle-dashboard) from needing any config.
fn conventional_core_roots() -> Vec<PathBuf> {
    let home = crate::host::home_dir();
    let mut roots = Vec::new();
    if let Some(h) = home {
        roots.push(h.join("Developer").join("heddle"));
        roots.push(h.join("heddle"));
    }
    roots
}

/// The first of `roots` whose `core_script` exists, tried in order. Split out as a pure function —
/// no `$HOME` lookup of its own — so `operator_tests.rs` can exercise the auto-detect tier's search
/// logic against temp dirs instead of the real home directory (see `resolve_binary_with_roots`).
fn first_core_root(roots: &[PathBuf]) -> Option<String> {
    roots.iter().find_map(|root| core_script(&root.to_string_lossy()))
}

/// An env var that is set AND non-empty — an empty override must not shadow a later tier.
fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// One settings+token read, off the async task. `Err` carries the exact status `reason` this
/// attempt stops at (`"no-binary"` / `"no-token"`), so `ensure_client` can record and later replay it.
async fn resolve_spawn_plan(ctx: &AppCtx) -> Result<(String, Vec<String>, String), &'static str> {
    let ctx = ctx.clone();
    let (binary, token) = blocking(move || {
        let settings = settings_json(&ctx);
        (
            resolve_binary(settings.as_ref()),
            read_operator_token(settings.as_ref()),
        )
    })
    .await
    .map_err(|_| "spawn-failed")?;
    let (program, args) = binary.ok_or("no-binary")?;
    let token = token.ok_or("no-token")?;
    Ok((program, args, token))
}

/// Loader/interpreter env vars a packaged Linux app (e.g. an AppImage) can have set in ITS OWN
/// process — inherited by a spawned child by default — which could redirect the `node`/
/// `heddle-comms` child's dynamic linker, Python interpreter, or GTK module search path and break
/// or subvert it. Scrubbed unconditionally before every spawn: removing an already-unset var is a
/// no-op, so this is harmless on every other platform/packaging.
const SCRUBBED_LOADER_ENV_VARS: &[&str] = &["LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "PYTHONHOME", "GTK_PATH"];

/// Fleet worker/agent identity stamps that must NEVER reach the operator child. The broker's
/// `resolveCommsIdentity` (heddle `src/comms/server.ts`) binds `HEDDLE_COMMS_ROLE=operator` as the
/// operator ONLY when neither `HEDDLE_WORKER` nor `HEDDLE_COMMS_ADDRESS` is present; if either is set
/// it silently "binds as the worker instead" and the app's operator messages are DOWNGRADED from
/// tier=operator to agent-message — the composer's send appears to go out but never posts with
/// operator authority (HED-183). A Dock/Finder-launched app can inherit these stamps from whatever
/// context started it, and `tokio::process::Command` passes this process's full environment to the
/// child, so they are scrubbed here alongside `HEDDLE_COMMS_PUSH`. `HEDDLE_AGENT`/`FLEET_AGENT` are stripped too
/// (defense-in-depth): they can never bind the operator, but leaving them would let the child bind as
/// that agent on any fall-through — the exact silent mis-binding this guards against.
const SCRUBBED_FLEET_IDENTITY_VARS: &[&str] =
    &["HEDDLE_WORKER", "HEDDLE_COMMS_ADDRESS", "HEDDLE_AGENT", "FLEET_AGENT"];

/// Builds the child's `Command`: `PATH` augmented the same way `ccusage`/`agy` launches are (a
/// Dock/Finder-launched GUI app does not inherit a shell `PATH`), plus EXACTLY the two mandated
/// env vars — nothing else is ever ADDED here, and neither is ever passed as an argument.
/// `HEDDLE_COMMS_PUSH`, `SCRUBBED_LOADER_ENV_VARS`, and `SCRUBBED_FLEET_IDENTITY_VARS` are explicitly
/// REMOVED (not merely left unset), so none can leak in from this process's own environment — see the
/// module doc. Scrubbing the fleet-identity stamps is what lets the child actually bind as the
/// OPERATOR (HED-183) instead of being silently downgraded to a worker/agent by the broker.
fn build_command(program: &str, args: &[String], token: &str) -> tokio::process::Command {
    tokio::process::Command::new(program).configure(|cmd| {
        cmd.args(args)
            .env("PATH", augmented_path())
            .env("HEDDLE_COMMS_ROLE", "operator")
            .env("HEDDLE_COMMS_OPERATOR_TOKEN", token)
            .env_remove("HEDDLE_COMMS_PUSH");
        for var in SCRUBBED_LOADER_ENV_VARS {
            cmd.env_remove(var);
        }
        for var in SCRUBBED_FLEET_IDENTITY_VARS {
            cmd.env_remove(var);
        }
    })
}

/// Spawns the child and completes the MCP handshake. Any failure here — an OS spawn error or a
/// handshake that never completes — is reported as the single `"spawn-failed"` reason; the token
/// never appears in either error variant (it was passed as an env var, never interpolated into
/// either message), so nothing here needs redaction of its own.
async fn spawn_and_serve(
    program: &str,
    args: &[String],
    token: &str,
) -> Result<RunningService<RoleClient, ()>, &'static str> {
    let transport =
        TokioChildProcess::new(build_command(program, args, token)).map_err(|_| "spawn-failed")?;
    ().serve(transport).await.map_err(|_| "spawn-failed")
}

/// Returns once `state().client` is a live session, spawning (or respawning) it first if needed.
/// Backoff applies ONLY to a spawn attempt that itself just failed — a session that was live and
/// then died (crash) is retried on the very next call, unthrottled: the fleet contract's "restart
/// with backoff on crash" is about not hammering a persistently broken binary, not about delaying
/// recovery from a transient crash of a previously-working one.
///
/// B2 fix: `state()`'s lock is only ever held for short, non-blocking checks/writes — never across
/// `resolve_spawn_plan`'s blocking-pool read or `spawn_and_serve`'s handshake, both bounded by
/// `CALL_TIMEOUT` below, so a hung child can no longer freeze every other caller of `state()` (a
/// status poll, or another write racing this one). `spawn_lock()` — a SEPARATE lock, held across
/// that same window — serializes the actual spawn attempt so two concurrent callers can't race
/// into spawning two children for one operator token.
async fn ensure_client(ctx: &AppCtx) -> Result<(), &'static str> {
    {
        let guard = state().lock().await;
        if guard.client.is_some() {
            return Ok(());
        }
        if let (Some(last), Some(reason)) = (guard.last_spawn_failure, guard.last_reason) {
            if last.elapsed() < SPAWN_BACKOFF {
                return Err(reason);
            }
        }
    }

    let _spawn_guard = spawn_lock().lock().await;
    // Re-check EVERYTHING the first guard checked, not just the client: a caller queued behind us on
    // the spawn lock may have finished spawning (client now Some) OR just failed and set the backoff.
    // Testing only `client.is_some()` here would let a burst of callers each spawn in turn behind a
    // single failure, defeating the backoff entirely (gitar, #39).
    {
        let guard = state().lock().await;
        if guard.client.is_some() {
            return Ok(());
        }
        if let (Some(last), Some(reason)) = (guard.last_spawn_failure, guard.last_reason) {
            if last.elapsed() < SPAWN_BACKOFF {
                return Err(reason);
            }
        }
    }

    let (program, args, token) = match resolve_spawn_plan(ctx).await {
        Ok(plan) => plan,
        Err(reason) => {
            let mut guard = state().lock().await;
            guard.last_spawn_failure = Some(Instant::now());
            guard.last_reason = Some(reason);
            return Err(reason);
        }
    };
    {
        let mut guard = state().lock().await;
        guard.token = Some(token.clone());
    }
    let spawned = tokio::time::timeout(CALL_TIMEOUT, spawn_and_serve(&program, &args, &token)).await;
    let mut guard = state().lock().await;
    match spawned {
        Ok(Ok(client)) => {
            guard.client = Some(Arc::new(client));
            guard.last_spawn_failure = None;
            guard.last_reason = None;
            Ok(())
        }
        Ok(Err(reason)) => {
            guard.last_spawn_failure = Some(Instant::now());
            guard.last_reason = Some(reason);
            Err(reason)
        }
        Err(_elapsed) => {
            // The spawn/handshake itself never returned within CALL_TIMEOUT — a hung child, not a
            // panic and not an indefinite hang for the caller. Reported as the existing
            // "spawn-failed" reason: callers already handle it, and nothing token-shaped is in it.
            guard.last_spawn_failure = Some(Instant::now());
            guard.last_reason = Some("spawn-failed");
            Err("spawn-failed")
        }
    }
}

/// Ensures a live client, calls `name` with `args`, and on ANY transport/service-level failure (or
/// a timeout) clears the cached client so the NEXT call respawns rather than replaying a dead pipe
/// forever (fleet contract). This function's own `Err` is always one of the four status-reason
/// strings — never a raw protocol error string — so nothing token-shaped can leak through it.
///
/// B2 fix: the state lock is held only long enough to clone the `Arc<RunningService>` handle out,
/// then released BEFORE the broker round-trip — never across it — and that round-trip is bounded
/// by `CALL_TIMEOUT` so a hung broker surfaces as an ordinary failure instead of hanging this call
/// (or blocking every other caller of `state()`, e.g. the status command) forever.
async fn call_tool(
    ctx: &AppCtx,
    name: &'static str,
    args: Option<Map<String, Value>>,
) -> Result<CallToolResult, &'static str> {
    ensure_client(ctx).await?;
    let client = state().lock().await.client.clone().ok_or("spawn-failed")?;
    let req = match args {
        Some(map) => CallToolRequestParams::new(name).with_arguments(map),
        None => CallToolRequestParams::new(name),
    };
    match tokio::time::timeout(CALL_TIMEOUT, client.call_tool(req)).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(_)) | Err(_) => {
            // Only clear the cache if it's still the SAME client this call used — a concurrent
            // caller may have already respawned a fresh one while this call was in flight (or
            // timing out), and this must never clobber that. Dropped here when cleared:
            // RunningService's DropGuard + TokioChildProcess's own Drop tear the dead child down;
            // the next call respawns fresh.
            let mut guard = state().lock().await;
            if guard.client.as_ref().is_some_and(|c| Arc::ptr_eq(c, &client)) {
                guard.client = None;
            }
            Err("spawn-failed")
        }
    }
}

/// The tool's JSON payload: `structured_content` when the server sent it, else the first text
/// content block parsed as JSON. heddle-comms's own `text()` helper (`src/comms/server.ts`) always
/// takes the latter path (it never sets `structuredContent`) — both are handled so this keeps
/// working if the broker adopts structured output later.
fn result_json(result: &CallToolResult) -> Option<Value> {
    if let Some(v) = &result.structured_content {
        return Some(v.clone());
    }
    let text = result.content.first()?.as_text()?;
    serde_json::from_str(&text.text).ok()
}

/// `comms_whoami`'s `revoked` field on the currently live session. Callers are responsible for
/// only invoking this when a client is already known to be live (see `heddle_comms_operator_status`)
/// — like every other tool call this goes through `ensure_client`, so calling it with nothing live
/// yet would spawn one, which the status command must never do on its own.
async fn whoami_revoked(ctx: &AppCtx) -> Result<bool, &'static str> {
    let result = call_tool(ctx, "comms_whoami", None).await?;
    let json = result_json(&result).ok_or("spawn-failed")?;
    Ok(json.get("revoked").and_then(Value::as_bool).unwrap_or(false))
}

/// Precondition-only status for when no session is live yet: never spawns. A cached
/// `"spawn-failed"` is only ever replayed from the LAST write call's attempt, and only while still
/// within `SPAWN_BACKOFF` of it (B1 fix) — once that window elapses this reports available again,
/// since the next write call is free to retry the spawn. Without this check, one transient failure
/// would latch the REPORTED status as unavailable until app restart, even though writes themselves
/// already recover once the backoff window passes (see `ensure_client`). Nothing here retries a
/// spawn just to answer a status poll.
async fn static_status(ctx: &AppCtx) -> OperatorStatus {
    let roots = conventional_core_roots();
    static_status_with_roots(ctx, &roots).await
}

/// `static_status`, with tier 4's conventional-root list passed in — same seam and rationale as
/// `resolve_binary_with_roots`, so `operator_tests.rs` can prove the "no-binary" status deterministically
/// instead of depending on whether this machine happens to have a real conventional heddle checkout.
async fn static_status_with_roots(ctx: &AppCtx, conventional_roots: &[PathBuf]) -> OperatorStatus {
    let ctx = ctx.clone();
    let roots = conventional_roots.to_vec();
    let (has_binary, has_token) = blocking(move || {
        let settings = settings_json(&ctx);
        (
            resolve_binary_with_roots(settings.as_ref(), &roots).is_some(),
            read_operator_token(settings.as_ref()).is_some(),
        )
    })
    .await
    .unwrap_or((false, false));
    if !has_binary {
        return unavailable("no-binary");
    }
    if !has_token {
        return unavailable("no-token");
    }
    let guard = state().lock().await;
    match (guard.last_reason, guard.last_spawn_failure) {
        (Some(reason), Some(failed_at)) if failed_at.elapsed() < SPAWN_BACKOFF => unavailable(reason),
        _ => OperatorStatus {
            available: true,
            revoked: false,
            reason: None,
        },
    }
}

fn unavailable(reason: &'static str) -> OperatorStatus {
    OperatorStatus {
        available: false,
        revoked: false,
        reason: Some(reason),
    }
}

/// Calls `tool`, redacts the live token out of anything before it leaves this module, and returns
/// the broker's JSON payload UNCHANGED — callers must not re-shape it (the "verbatim" contract).
/// An MCP-level `isError` (bad args, unbound identity, unknown tool) becomes `Err`; a well-formed
/// business refusal inside the payload (e.g. `outcome: "refused"`) is NOT `isError` and comes back
/// `Ok`, per the fleet contract: a refusal is a successful command, never auto-retried.
async fn passthrough(
    ctx: &AppCtx,
    tool: &'static str,
    args: Option<Map<String, Value>>,
) -> Result<Value, String> {
    let outcome = call_tool(ctx, tool, args).await;
    let token = state().lock().await.token.clone();
    let result = outcome.map_err(|reason| redact(reason.to_string(), token.as_deref()))?;
    if result.is_error == Some(true) {
        let msg = result
            .content
            .first()
            .and_then(|c| c.as_text())
            .map(|t| t.text.clone())
            .unwrap_or_else(|| format!("{tool} failed"));
        return Err(redact(msg, token.as_deref()));
    }
    let value = result_json(&result)
        .ok_or_else(|| redact(format!("{tool}: unparseable response"), token.as_deref()))?;
    Ok(redact_value(value, token.as_deref()))
}

/// Defense-in-depth for the `Ok` path: the broker never legitimately echoes the token back, but
/// nothing returned to the frontend is exempt from the "never any string returned to the
/// frontend" rule, so a would-be leak is scrubbed here too, not just from `Err`s.
///
/// FAILS CLOSED (A1): if the redacted JSON text can't be re-parsed, this returns a fixed
/// placeholder — NEVER the original `v`. The old `unwrap_or(v)` fallback defeated the entire
/// function on exactly the path where something had already gone wrong (a redaction that broke
/// the JSON), handing back the unredacted payload right when redaction mattered most.
fn redact_value(v: Value, token: Option<&str>) -> Value {
    let Some(t) = token.filter(|t| !t.is_empty()) else {
        return v;
    };
    let scrubbed = redact(v.to_string(), Some(t));
    serde_json::from_str(&scrubbed)
        .unwrap_or_else(|_| Value::String("[redacted: payload could not be safely re-encoded]".into()))
}

/// `{available, revoked, reason}` — never spawns a child on its own (poll-safe for C2's 30s
/// timer); only refreshes `revoked` by asking the broker when a session is already live.
#[tauri::command]
pub async fn heddle_comms_operator_status(app: tauri::AppHandle) -> Result<OperatorStatus, String> {
    let ctx = AppCtx::Tauri(app);
    let already_live = state().lock().await.client.is_some();
    if already_live {
        if let Ok(revoked) = whoami_revoked(&ctx).await {
            return Ok(OperatorStatus {
                available: !revoked,
                revoked,
                reason: revoked.then_some("revoked"),
            });
        }
        // whoami failed: call_tool already cleared the dead client above; fall through exactly as
        // if nothing had ever spawned.
    }
    Ok(static_status(&ctx).await)
}

/// The broker's `post_message` result verbatim (`outcome`/`code`/`reason`/…) — a refusal is a
/// SUCCESSFUL command return, never an `Err` (never auto-retried).
#[tauri::command]
pub async fn heddle_comms_send(
    app: tauri::AppHandle,
    target: String,
    body: String,
    reply_to: Option<i64>,
) -> Result<Value, String> {
    let mut args = Map::new();
    args.insert("to".into(), Value::String(target));
    args.insert("body".into(), Value::String(body));
    if let Some(id) = reply_to {
        args.insert("reply_to".into(), Value::from(id));
    }
    passthrough(&AppCtx::Tauri(app), "post_message", Some(args)).await
}

/// `open` always defaults to the broker's own default (closed) — never silently sent as `true`.
/// Split out so the default-closed rule (Test 4) is directly unit-testable without a live client.
fn create_room_args(name: String, topic: Option<String>, open: Option<bool>) -> Map<String, Value> {
    let mut args = Map::new();
    args.insert("name".into(), Value::String(name));
    if let Some(t) = topic {
        args.insert("topic".into(), Value::String(t));
    }
    args.insert("open".into(), Value::Bool(open.unwrap_or(false)));
    args
}

async fn create_room(
    ctx: &AppCtx,
    name: String,
    topic: Option<String>,
    open: Option<bool>,
) -> Result<Value, String> {
    let args = create_room_args(name, topic, open);
    passthrough(ctx, "create_room", Some(args)).await
}

#[tauri::command]
pub async fn heddle_comms_create_room(
    app: tauri::AppHandle,
    name: String,
    topic: Option<String>,
    open: Option<bool>,
) -> Result<Value, String> {
    create_room(&AppCtx::Tauri(app), name, topic, open).await
}

#[tauri::command]
pub async fn heddle_comms_add_member(
    app: tauri::AppHandle,
    room: String,
    address: String,
) -> Result<Value, String> {
    member_call(&AppCtx::Tauri(app), "join_room", room, address).await
}

#[tauri::command]
pub async fn heddle_comms_remove_member(
    app: tauri::AppHandle,
    room: String,
    address: String,
) -> Result<Value, String> {
    member_call(&AppCtx::Tauri(app), "leave_room", room, address).await
}

async fn member_call(
    ctx: &AppCtx,
    tool: &'static str,
    room: String,
    address: String,
) -> Result<Value, String> {
    let mut args = Map::new();
    args.insert("room".into(), Value::String(room));
    args.insert("address".into(), Value::String(address));
    passthrough(ctx, tool, Some(args)).await
}

/// Reduce arbitrary project labels and UUIDs to the broker's lowercase alphanumeric/hyphen room
/// alphabet.
fn broker_safe_room_fragment(value: &str) -> String {
    let mut slug = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}

/// Stable room name for a project's all-agent conversation, conforming to the broker's room-name
/// grammar (`ROOM_RE` in heddle `src/comms/address.ts`): a leading `#`, then 1–64 characters of
/// `[A-Za-z0-9_-]` beginning with an alphanumeric. A name that violates it is refused by
/// `create_room`, so this MUST emit a conforming string — the missing `#` and unbounded length of
/// the earlier form made every provisioning call a silent broker refusal.
///
/// Shape: `#<slug>-<id8>-all`. `<slug>` is the broker-safe project label, truncated to fit the
/// 64-char budget; `<id8>` is the first 8 broker-safe characters of the project UUID (its leading
/// hex segment). The UUID discriminator makes two projects with the same slug land on distinct
/// rooms; a real name collision would need the same slug AND the same leading 8 hex, and even then
/// the one-default-per-project unique index rejects the second association. Both parts fall back to
/// `project` when empty so the result always starts with an alphanumeric.
fn default_project_room_name(project_name: &str, project_id: &str) -> String {
    let id8: String = broker_safe_room_fragment(project_id).chars().take(8).collect();
    let id8 = if id8.is_empty() { "project".to_string() } else { id8 };
    // After `#` the broker allows 64 chars; reserve the fixed tail `-<id8>-all` for the slug budget.
    let slug_budget = 64usize.saturating_sub(1 + id8.len() + 4);
    let slug: String = broker_safe_room_fragment(project_name).chars().take(slug_budget).collect();
    let slug = slug.trim_end_matches('-');
    let head = if slug.is_empty() { "project" } else { slug };
    format!("#{head}-{id8}-all")
}

async fn default_room_for_project(ctx: &AppCtx, project_id: &str) -> Result<Option<String>, String> {
    let ctx = ctx.clone();
    let project_id = project_id.to_string();
    blocking(move || {
        Ok(crate::command_core::list_room_associations(&ctx)?
            .into_iter()
            .find(|association| association.project_id == project_id && association.is_default)
            .map(|association| association.room_name))
    })
    .await?
}

/// A broker business refusal is a successful MCP response, but never a successful provisioning
/// step. Keep it as an `Err` locally so no new default association is persisted after a refused
/// create or membership update.
fn require_broker_acceptance(operation: &str, response: &Value) -> Result<(), String> {
    if response.get("outcome").and_then(Value::as_str) == Some("refused") {
        let detail = response
            .get("code")
            .or_else(|| response.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or("refused");
        return Err(format!("Default project room {operation} was refused: {detail}"));
    }
    Ok(())
}

async fn associate_default_room(ctx: &AppCtx, room: String, project_id: String) -> Result<(), String> {
    let ctx = ctx.clone();
    blocking(move || {
        let conn = ctx.db().conn.lock().unwrap();
        let already_has_default = crate::db::repo::list_room_associations(&conn)?
            .iter()
            .any(|association| association.project_id == project_id && association.is_default);
        if already_has_default {
            return Ok(());
        }
        crate::db::repo::associate_room_to_project(&conn, &room, &project_id, true)
    })
    .await?
}

/// Creates the default room once, records the HED-168 default association, and converges the
/// closed room's membership to `project_agents`. The explicit membership inputs keep the broker
/// write sequence independently testable; production derives both sets in
/// [`provision_default_project_room`].
async fn provision_default_project_room_with_members(
    ctx: &AppCtx,
    project: &Project,
    project_agents: &BTreeSet<String>,
    existing_members: &BTreeSet<String>,
) -> Result<(), String> {
    let existing_default = default_room_for_project(ctx, &project.id).await?;
    let room = match existing_default.as_ref() {
        Some(room) => room.clone(),
        None => default_project_room_name(&project.name, &project.id),
    };

    // `create_room` is idempotent by room name at the broker (heddle log.ts: INSERT ... ON
    // CONFLICT(name) DO NOTHING), so re-creating a persisted room is a no-op that returns the
    // existing record. That idempotency is why calling it on every open is safe: concurrent first
    // opens converge on this project's stable ID-bearing name instead of racing to two rooms. The
    // room's `open` flag is write-once at first insert — it is created closed and the broker exposes
    // no path to reopen it — so this call cannot and need not re-close an already-persisted room.
    let created = create_room(ctx, room.clone(), None, Some(false)).await?;
    require_broker_acceptance("creation", &created)?;

    for address in project_agents.difference(existing_members) {
        let joined = member_call(ctx, "join_room", room.clone(), address.clone()).await?;
        require_broker_acceptance("member add", &joined)?;
    }
    for address in existing_members.difference(project_agents) {
        let left = member_call(ctx, "leave_room", room.clone(), address.clone()).await?;
        require_broker_acceptance("member removal", &left)?;
    }

    // Persist only after every broker operation was accepted. The database write is transactional
    // and has a partial unique index on one default per project; concurrent opens using the same
    // room name therefore converge on one association.
    if existing_default.is_none() {
        associate_default_room(ctx, room, project.id.clone()).await?;
    }
    Ok(())
}

/// Provisions the project's persisted default room on every project open. HED-167 supplies the
/// project agent addresses from registered worktrees; HED-168 supplies the persisted default-room
/// lookup and association, so reopening never creates a second room or association.
pub async fn provision_default_project_room(ctx: &AppCtx, project: &Project) -> Result<(), String> {
    let existing_members = match default_room_for_project(ctx, &project.id).await? {
        Some(room) => crate::comms::reader::room_members(&room).await?,
        None => BTreeSet::new(),
    };
    let root_path = project.root_path.clone();
    let project_agents = blocking(move || crate::heddle_stats::roster::project_agent_addresses(&root_path))
        .await??;
    provision_default_project_room_with_members(ctx, project, &project_agents, &existing_members).await
}

/// Ensures a project has exactly one default room — created closed, and closed for good because the
/// broker's `open` flag is write-once at first insert — and keeps its broker membership aligned with
/// HED-167's project-worktree agent set.
#[tauri::command]
pub async fn heddle_ensure_project_default_room(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<(), String> {
    let ctx = AppCtx::Tauri(app);
    let project = {
        let ctx = ctx.clone();
        blocking(move || {
            crate::command_core::list_tree(&ctx)?
                .projects
                .into_iter()
                .find(|project| project.id == project_id)
                .ok_or_else(|| format!("Project not found: {project_id}"))
        })
        .await??
    };
    provision_default_project_room(&ctx, &project).await
}

/// Cancels the live child (if any) so its process is killed rather than merely dropped. `pub`
/// because it's called from `RunEvent::Exit` in `lib.rs`, outside this dispatch's file scope
/// (`comms` is a private module, so `pub` alone does not silence rustc's dead-code lint here) —
/// see the module doc's "kill on app exit" section. Also exercised directly by `operator_tests.rs`.
pub async fn shutdown() {
    let Some(client) = state().lock().await.client.take() else {
        return;
    };
    match Arc::try_unwrap(client) {
        Ok(client) => {
            let _ = client.cancel().await;
        }
        Err(_still_shared) => {
            // A call is still in flight and holds its own clone of the SAME Arc (see call_tool's
            // B2 fix), bounded by CALL_TIMEOUT. `cancel(self)` needs exclusive ownership, which we
            // don't have here, so this reference is simply dropped: the child is still torn down
            // once the in-flight call finishes (or times out) and drops its own clone, via
            // TokioChildProcess's own Drop (see the module doc) — an acceptable narrow tradeoff at
            // exactly the moment the process is exiting anyway.
        }
    }
}

#[cfg(test)]
#[path = "operator_tests.rs"]
mod tests;
