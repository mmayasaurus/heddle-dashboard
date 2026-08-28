//! heddle orchestration stats — read-only views powering the Fleet drawer.
//!
//! Three independent, best-effort data sources exposed as Tauri commands:
//!   - **ccusage** (external CLI) → true rolling 5-hour / weekly provider-cap usage across every
//!     coding CLI it detects (claude, codex, gemini, …). We render its JSON verbatim.
//!   - **the heddle dispatch ledger** (`~/.heddle/ledger.db`) → what heddle itself dispatched and
//!     how it turned out (orchestrator, task class, model, tokens, pass/fail, in-flight).
//!   - **provider rate-limit caps** (`heddle_provider_limits`) → the TRUE per-provider cap numbers,
//!     one source per provider (see `docs/USAGE_TAP.md`): Claude from the statusline tap
//!     (`~/.heddle/usage/claude.json`), Codex from the claudex-usage cache (`codex.rs`), Gemini
//!     from `agy -p /quota` cached to `~/.heddle/usage/gemini.json` (`gemini.rs`), Cursor from
//!     cursor.com's usage-summary API cached to `~/.heddle/usage/cursor.json` (`cursor.rs`).
//!     The assembled `Vec<ProviderLimit>` is also mirrored to `~/.heddle/usage/limits.json` on
//!     every poll so heddle-core's router reads the SAME contract as the drawer.
//!
//! Everything here is read-only and best-effort: a missing ccusage or ledger yields an empty/typed
//! result rather than an error, so the drawer degrades gracefully instead of failing the whole app.
//!
//! CONTRACT NOTE: `heddle_provider_limits` → `Vec<ProviderLimit>` is consumed by
//! `src/layout/CenterPane/FleetDrawer.tsx`. It is additive-only: new providers are new entries, new
//! fields are `Option` — never rename/remove/retype an existing field.

use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;
use serde::Serialize;

pub(crate) mod claude;
pub mod discipline;
pub mod route_mix;
mod codex;
mod cursor;
mod cursor_fetch;
mod fable_attrib;
mod gemini;
pub mod roster;
mod util;

pub(crate) use util::{
    augmented_path, is_stale, mask_email, now_secs, run_with_timeout, usage_dir, write_json_atomic,
    RefreshGate,
};

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

// ─────────────────────────── ccusage (provider caps) ───────────────────────────

/// Run `ccusage <args…> --json` and parse stdout. Best-effort: `Null` when ccusage is absent or
/// errors, so the UI shows "usage unavailable" instead of failing the whole drawer.
fn ccusage_json(args: &[&str]) -> serde_json::Value {
    let out = Command::new("ccusage")
        .args(args)
        .arg("--json")
        .env("PATH", augmented_path())
        .output();
    match out {
        Ok(o) if o.status.success() => {
            serde_json::from_slice(&o.stdout).unwrap_or(serde_json::Value::Null)
        }
        _ => serde_json::Value::Null,
    }
}

/// The cap view: the active 5-hour block (burn rate + projection) plus weekly totals, returned as
/// ccusage's own JSON so the frontend renders it directly. Runs on the blocking pool because
/// ccusage scans every session log (seconds, not milliseconds) — the drawer should poll on a timer.
#[tauri::command]
pub async fn heddle_caps() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        serde_json::json!({
            "activeBlock": ccusage_json(&["blocks", "--active"]),
            "weekly": ccusage_json(&["weekly"]),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

// ─────────────────────────── heddle dispatch ledger ───────────────────────────

/// One row of the heddle ledger — a sub-task heddle routed to a worker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    id: i64,
    orchestrator: Option<String>,
    task_class: String,
    provider: String,
    model: String,
    ok: i64,
    issue: Option<String>,
    input_tokens: Option<i64>,
    cached_input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    duration_ms: Option<i64>,
    fell_back_from: Option<String>,
    started_at: String,
    finished_at: Option<String>,
}

/// Per-provider rollup from the ledger (heddle's dispatched-worker tokens — distinct from ccusage's
/// account-wide caps).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    provider: String,
    dispatches: i64,
    succeeded: i64,
    input_tokens: i64,
    output_tokens: i64,
}

/// Open the heddle ledger read-only. `None` (not an error) when heddle has never run on this
/// machine, so the drawer simply shows "no dispatches yet".
pub(crate) fn ledger() -> Result<Option<Connection>, String> {
    let path = home().join(".heddle").join("ledger.db");
    if !path.exists() {
        return Ok(None);
    }
    let conn = Connection::open(&path).map_err(|e| format!("ledger open failed: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(3)).ok();
    // Read-only intent without the READ_ONLY-open + WAL pitfall (a fresh read-only handle can't
    // create the -shm file). query_only enforces no writes on a normally-opened WAL connection.
    conn.execute_batch("PRAGMA query_only = ON;").ok();
    Ok(Some(conn))
}

fn map_dispatch(r: &rusqlite::Row) -> rusqlite::Result<Dispatch> {
    Ok(Dispatch {
        id: r.get("id")?,
        orchestrator: r.get("orchestrator")?,
        task_class: r.get("task_class")?,
        provider: r.get("provider")?,
        model: r.get("model")?,
        ok: r.get("ok")?,
        issue: r.get("issue")?,
        input_tokens: r.get("input_tokens")?,
        cached_input_tokens: r.get("cached_input_tokens")?,
        output_tokens: r.get("output_tokens")?,
        duration_ms: r.get("duration_ms")?,
        fell_back_from: r.get("fell_back_from")?,
        started_at: r.get("started_at")?,
        finished_at: r.get("finished_at")?,
    })
}

/// Run a blocking read on the blocking pool. Every command here touches the filesystem or SQLite,
/// and synchronous Tauri commands run on the main thread (see README "Contributing"), so a slow
/// disk or a busy ledger must never stall the UI.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Most recent dispatches, newest first (default 25, capped 200).
#[tauri::command]
pub async fn heddle_recent(limit: Option<i64>) -> Result<Vec<Dispatch>, String> {
    blocking(move || recent_sync(limit)).await
}

fn recent_sync(limit: Option<i64>) -> Result<Vec<Dispatch>, String> {
    let Some(conn) = ledger()? else {
        return Ok(vec![]);
    };
    let limit = limit.unwrap_or(25).clamp(1, 200);
    let mut stmt = conn
        .prepare("SELECT * FROM dispatches ORDER BY id DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], map_dispatch)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Dispatches that started but never finished — the drawer's "running now" strip.
#[tauri::command]
pub async fn heddle_in_flight() -> Result<Vec<Dispatch>, String> {
    blocking(in_flight_sync).await
}

fn in_flight_sync() -> Result<Vec<Dispatch>, String> {
    let Some(conn) = ledger()? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT * FROM dispatches WHERE finished_at IS NULL ORDER BY id DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_dispatch)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Per-provider usage rollup for the "by provider" summary alongside the cap bars.
#[tauri::command]
pub async fn heddle_provider_usage() -> Result<Vec<ProviderUsage>, String> {
    blocking(provider_usage_sync).await
}

fn provider_usage_sync() -> Result<Vec<ProviderUsage>, String> {
    let Some(conn) = ledger()? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare(
            "SELECT provider, COUNT(*) AS dispatches, SUM(ok) AS succeeded, \
             SUM(COALESCE(input_tokens,0)) AS input_tokens, \
             SUM(COALESCE(output_tokens,0)) AS output_tokens \
             FROM dispatches GROUP BY provider ORDER BY dispatches DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProviderUsage {
                provider: r.get("provider")?,
                dispatches: r.get("dispatches")?,
                succeeded: r.get::<_, Option<i64>>("succeeded")?.unwrap_or(0),
                input_tokens: r.get::<_, Option<i64>>("input_tokens")?.unwrap_or(0),
                output_tokens: r.get::<_, Option<i64>>("output_tokens")?.unwrap_or(0),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

// ─────────────── provider rate-limit caps (statusline tap + per-provider sources) ───────────────

/// One rate-limit window (5-hour or 7-day): percent used + reset time (epoch SECONDS).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub used_percentage: Option<f64>,
    pub resets_at: Option<i64>,
}

/// A named window beyond the standard 5h/7d pair — a provider's extra per-model bucket, a monthly
/// plan pool, a metered spend pool. `id` is stable (key on it), `label` is display text. Absolute
/// amounts are filled in only when the provider reports them (then `unit` says what they are).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NamedWindow {
    pub id: String,
    pub label: String,
    pub used_percentage: Option<f64>,
    pub resets_at: Option<i64>,
    pub used_amount: Option<f64>,
    pub limit_amount: Option<f64>,
    pub unit: Option<String>,
}

/// One account's row for a multi-account provider. `label` is a MASKED email ("m…@example.com" —
/// the drawer gets screenshotted and streamed, never show the full address) or a positional
/// fallback like "acct 2".
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountLimit {
    /// Stable key for this row within its provider (claude: registry id `acct1`; codex: the wham
    /// `account_id`; cursor: the session source `cursor-ide` / `cursor-agent-keychain`).
    pub id: String,
    pub label: String,
    pub plan: Option<String>,
    /// Registry login state for providers that expose it (Claude); `None` when unavailable.
    pub logged_in: Option<bool>,
    /// When THIS account's numbers were captured, and whether that is older than the source's
    /// freshness threshold (`None` when unknown / not applicable).
    pub captured_at: Option<i64>,
    pub stale: Option<bool>,
    pub five_hour: LimitWindow,
    pub seven_day: LimitWindow,
    pub windows: Vec<NamedWindow>,
    pub limit_reached: Option<bool>,
    /// English diagnostic text (see `note_codes` for the localizable form).
    pub note: Option<String>,
    /// Stable, dot-namespaced codes for every condition in `note` (e.g. `codex.rateLimitReached`)
    /// so the frontend can localize instead of showing the English `note`.
    pub note_codes: Vec<String>,
    /// Provider-specific raw facts that don't fit the common fields (documented per source in
    /// `docs/USAGE_TAP.md`; e.g. Cursor's plan/onDemand objects in cents, billing cycle, token
    /// expiry). `None` when the source has nothing extra.
    pub detail: Option<serde_json::Value>,
    /// Claude only: estimated share of the WEEKLY cap consumed by Fable models on this account
    /// (percentage points; Fable's soft cap is 50%). `None` until enough samples exist, or N/A.
    /// An estimate by design — see `fable_attrib.rs`; exact when the payload has a Fable window.
    pub fable_weekly_estimate_pct: Option<f64>,
    /// Number of attributed samples behind the estimate (its confidence); `None` when N/A.
    pub fable_weekly_samples: Option<i64>,
}

/// A provider's live rate-limit state. These are the TRUE cap numbers — the exact values the
/// provider's own status surface shows — not a spend estimate.
///
/// CONTRACT (FleetDrawer.tsx): additive-only. `provider … seven_day` is the original shape; every
/// field after it was added later and is `Option`, so older readers ignore it. Do not rename,
/// remove, or retype existing fields.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimit {
    pub provider: String,
    pub model: Option<String>,
    pub captured_at: Option<i64>,
    pub five_hour: LimitWindow,
    pub seven_day: LimitWindow,
    /// Where the numbers came from: "statusline-tap" | "claudex-usage-cache" | …
    pub source: Option<String>,
    /// `captured_at` is older than `stale_after_secs` (computed at read time). Render dimmed /
    /// flagged rather than as live. `None` when there is no capture time to judge.
    pub stale: Option<bool>,
    /// The freshness expectation this source was judged against, so the UI can tick it live.
    pub stale_after_secs: Option<i64>,
    /// Human-readable (English) caveat about the payload, e.g. a window the provider stopped
    /// exposing. Diagnostic detail, same category as backend error strings; localize via
    /// `note_codes` when rendering as UI copy.
    pub note: Option<String>,
    /// Stable, dot-namespaced codes for every condition in `note` (e.g. `codex.no5hWindow`) —
    /// the translation-key layer for `note`. `None` when the source has no notes concept.
    pub note_codes: Option<Vec<String>>,
    /// Per-account rows for multi-account providers. `None` when the provider has no such notion.
    pub accounts: Option<Vec<AccountLimit>>,
    /// The `accounts[].id` whose numbers the top-level `fiveHour`/`sevenDay` show — the account
    /// this process is on (claude: `CLAUDE_CONFIG_DIR` → registry, else the default). `None` when
    /// the top level is a binding view rather than one account (codex, cursor) or N/A.
    pub active_account: Option<String>,
    /// Extra named windows beyond 5h/7d, binding (max) across accounts. `None` when the provider
    /// has no such notion; `[]` when it does but none are present right now.
    pub windows: Option<Vec<NamedWindow>>,
    /// Claude only (the active account's): Fable-attributed weekly usage estimate + its sample
    /// count — see `AccountLimit`. `None` for other providers.
    pub fable_weekly_estimate_pct: Option<f64>,
    pub fable_weekly_samples: Option<i64>,
}

/// The statusline tap only writes when a Claude session renders its statusline, so an idle fleet
/// simply goes quiet. Ten minutes means "nobody rendered recently", flagged so the drawer doesn't
/// present an old number as live.
const TAP_STALE_AFTER_SECS: i64 = 600;

/// Parse one statusline-tap snapshot (`~/.heddle/usage/<provider>.json`, written by
/// `~/.heddle/usage-tap.mjs`): `{model, rate_limits:{five_hour,seven_day}, capturedAt}` where
/// `capturedAt` / `resets_at` are epoch seconds. `None` when the file isn't a tap snapshot.
pub(crate) fn tap_limit(provider: &str, v: &serde_json::Value, now: i64) -> Option<ProviderLimit> {
    let rl = v.get("rate_limits")?;
    let win = |k: &str| LimitWindow {
        used_percentage: rl[k]["used_percentage"].as_f64(),
        resets_at: rl[k]["resets_at"].as_i64(),
    };
    let captured_at = v["capturedAt"].as_i64();
    Some(ProviderLimit {
        provider: provider.to_string(),
        model: v["model"].as_str().map(str::to_string),
        captured_at,
        five_hour: win("five_hour"),
        seven_day: win("seven_day"),
        source: Some("statusline-tap".to_string()),
        stale: is_stale(captured_at, now, TAP_STALE_AFTER_SECS),
        stale_after_secs: Some(TAP_STALE_AFTER_SECS),
        note: None,
        note_codes: None,
        accounts: None,
        active_account: None,
        windows: None,
        fable_weekly_estimate_pct: None,
        fable_weekly_samples: None,
    })
}

/// Providers whose snapshot in `~/.heddle/usage/` is owned by a dedicated source module rather than
/// the tap: `codex.json` (never written; Codex reads the claudex-usage cache directly),
/// `gemini.json` (`gemini.rs`) and `cursor.json` (`cursor.rs`), which write their snapshots and
/// read them back with their extras. `limits.json` is the assembled mirror, not a provider.
const DEDICATED_SOURCES: [&str; 4] = ["codex", "gemini", "cursor", "limits"];

/// Read every tap snapshot in `dir`. Best-effort: unreadable/non-tap files are skipped; providers
/// with a dedicated source module are skipped here and appended by that module.
fn tap_limits(dir: &Path, now: i64) -> Vec<ProviderLimit> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let provider = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        // Dedicated-source snapshots and per-account tap files (`claude-acct2.json`, read by
        // `claude.rs`) are not generic tap entries.
        if DEDICATED_SOURCES.contains(&provider.as_str()) || provider.contains('-') {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if let Some(l) = tap_limit(&provider, &v, now) {
            out.push(l);
        }
    }
    out
}

/// The binding view of one window across accounts: the highest used % wins (with that account's
/// reset time). Accounts without the window don't participate.
pub(crate) fn binding<'a>(windows: impl Iterator<Item = &'a LimitWindow>) -> LimitWindow {
    let mut best = LimitWindow::default();
    for w in windows {
        if w.used_percentage.unwrap_or(-1.0) > best.used_percentage.unwrap_or(-1.0) {
            best = w.clone();
        }
    }
    best
}

/// Binding view of named windows across accounts: per `id`, the account with the highest used %.
/// Order follows first appearance so the drawer is stable between polls.
pub(crate) fn binding_named(accounts: &[AccountLimit]) -> Vec<NamedWindow> {
    let mut out: Vec<NamedWindow> = Vec::new();
    for w in accounts.iter().flat_map(|a| a.windows.iter()) {
        match out.iter_mut().find(|o| o.id == w.id) {
            Some(existing) => {
                if w.used_percentage.unwrap_or(-1.0) > existing.used_percentage.unwrap_or(-1.0) {
                    *existing = w.clone();
                }
            }
            None => out.push(w.clone()),
        }
    }
    out
}

/// Stable drawer order: claude, codex, then the rest alphabetically.
pub(crate) fn sort_limits(out: &mut [ProviderLimit]) {
    out.sort_by(|a, b| {
        let rank = |p: &str| match p {
            "claude" => 0,
            "codex" => 1,
            _ => 2,
        };
        rank(&a.provider)
            .cmp(&rank(&b.provider))
            .then(a.provider.cmp(&b.provider))
    });
}

/// Every provider's live rate-limit snapshot: the statusline tap files in `~/.heddle/usage/`
/// (claude), Codex from the claudex-usage cache, Gemini from the agy snapshot. Best-effort — absent
/// sources simply yield fewer entries. Cheap (file reads only); slow sources refresh themselves
/// out-of-band (detached, never blocking this call) when their snapshot is getting old.
#[tauri::command]
pub async fn heddle_provider_limits(app: tauri::AppHandle) -> Result<Vec<ProviderLimit>, String> {
    blocking(move || provider_limits_sync(&crate::host::AppCtx::Tauri(app))).await
}

/// The Antigravity executable to refresh Gemini quota with: the path configured for Antigravity
/// sessions (Settings → agent defaults), else a located install, else bare `agy` resolved on the
/// augmented PATH — the same order session launches use, so the dashboard queries the SAME agy
/// (and login) as the terminals.
fn agy_bin(ctx: &crate::host::AppCtx) -> String {
    crate::pty::manager::agent_bin_path(ctx, crate::models::SessionKind::Antigravity)
        .unwrap_or_else(headless_agy_bin)
}

/// The non-GUI `agy` lookup shared by launchd and the GUI fallback.
fn headless_agy_bin() -> String {
    crate::agent::install::locate_installed_bin("antigravity").unwrap_or_else(|| "agy".to_string())
}

fn provider_limits_sync(ctx: &crate::host::AppCtx) -> Result<Vec<ProviderLimit>, String> {
    provider_limits_sync_with_paths(Some(ctx), &usage_dir(), None, now_secs())
}

/// Assemble provider limits from injected tap and Codex-cache paths. `ctx` is absent in unit tests
/// so they exercise the tap/Codex combine without reading or refreshing other live provider sources.
fn provider_limits_sync_with_paths(
    ctx: Option<&crate::host::AppCtx>,
    tap_dir: &Path,
    codex_cache_path: Option<&Path>,
    now: i64,
) -> Result<Vec<ProviderLimit>, String> {
    let mut out = tap_limits(tap_dir, now);
    if ctx.is_some() {
        // Claude: the per-account view (registry + claude-<id>.json) replaces the plain tap entry.
        if let Some(c) = claude::limit(now) {
            out.retain(|l| l.provider != "claude");
            out.push(c);
        }
    }
    let codex = match codex_cache_path {
        Some(path) => codex::limit_from_cache_path(path, now, ctx.is_some()),
        // A default-path codex read is a ctx-gated live source like claude/gemini/cursor: without a
        // ctx we neither read nor refresh it (tests always inject a path instead) — HED-49 review.
        None if ctx.is_some() => codex::limit(now),
        None => None,
    };
    if let Some(c) = codex {
        out.push(c);
    }
    if let Some(ctx) = ctx {
        if let Some(g) = gemini::limit(now, &agy_bin(ctx)) {
            out.push(g);
        }
        if let Some(c) = cursor::limit(now) {
            out.push(c);
        }
    }
    sort_limits(&mut out);
    // Mirror the exact contract for out-of-process consumers (heddle-core's cap-aware router):
    // `{writtenAt, limits: Vec<ProviderLimit>}`. Best-effort; a failed write never fails the poll.
    if let Ok(v) = serde_json::to_value(&out) {
        let _ = write_json_atomic(
            &tap_dir.join("limits.json"),
            &serde_json::json!({ "writtenAt": now, "limits": v }),
        );
    }
    Ok(out)
}

/// Force an out-of-band refresh of one provider's source (or every refreshable one when `provider`
/// is `None`), ignoring the staleness thresholds. Returns the providers a refresh was kicked for.
/// Non-blocking: re-poll `heddle_provider_limits` a few seconds later to read the result. Claude is
/// tap-driven (a session must render its statusline), so it is never in the list.
#[tauri::command]
pub async fn heddle_refresh_provider_limits(
    app: tauri::AppHandle,
    provider: Option<String>,
) -> Result<Vec<String>, String> {
    blocking(move || refresh_provider_limits_sync(&crate::host::AppCtx::Tauri(app), provider)).await
}

fn refresh_provider_limits_sync(
    ctx: &crate::host::AppCtx,
    provider: Option<String>,
) -> Result<Vec<String>, String> {
    let want = |p: &str| provider.as_deref().map(|w| w == p).unwrap_or(true);
    let mut kicked = Vec::new();
    let now = now_secs();
    if want("codex") && codex::force_refresh(now) {
        kicked.push("codex".to_string());
    }
    if want("gemini") && gemini::force_refresh(now, &agy_bin(ctx)) {
        kicked.push("gemini".to_string());
    }
    if want("cursor") && cursor::force_refresh(now) {
        kicked.push("cursor".to_string());
    }
    Ok(kicked)
}

/// Replace the Cursor entry in the out-of-process limits mirror while preserving every other
/// provider entry. Missing or malformed existing mirrors are treated as an empty limits list.
pub(crate) fn merge_cursor_into_limits(
    existing: serde_json::Value,
    fresh_cursor: Option<ProviderLimit>,
    now: i64,
) -> serde_json::Value {
    merge_provider_into_limits(existing, "cursor", fresh_cursor, now, true, |_| true)
}

/// Replace one provider in the limits mirror. Guarded providers retain an existing block when the
/// fresh candidate has no capture; Cursor intentionally retains its historical replace-on-None
/// behavior because its own fetch is the authoritative snapshot for this job.
fn merge_provider_into_limits(
    existing: serde_json::Value,
    provider: &str,
    fresh: Option<ProviderLimit>,
    now: i64,
    replace_on_none: bool,
    guard: impl Fn(&ProviderLimit) -> bool,
) -> serde_json::Value {
    let mut limits = existing["limits"].as_array().cloned().unwrap_or_default();
    if let Some(fresh) = fresh.filter(&guard) {
        if let Ok(value) = serde_json::to_value(fresh) {
            limits.retain(|limit| limit["provider"].as_str() != Some(provider));
            limits.push(value);
        }
    } else if replace_on_none {
        limits.retain(|limit| limit["provider"].as_str() != Some(provider));
    }
    serde_json::json!({ "writtenAt": now, "limits": limits })
}

/// Replace the Claude entry in the out-of-process limits mirror while preserving every other
/// provider entry. A rebuild is replace-worthy only when it actually carries capture data:
/// `claude::build` returns `Some(empty)` when the registry exists but no per-account captures do,
/// and replacing on that (or on `None`) would erase a still-useful stale-marked block for an empty
/// one — so with no captures anywhere the existing Claude entry is retained (HED-348, qodo/codeant).
pub(crate) fn merge_claude_into_limits(
    existing: serde_json::Value,
    fresh_claude: Option<ProviderLimit>,
    now: i64,
) -> serde_json::Value {
    let has_capture = |l: &ProviderLimit| {
        l.captured_at.is_some()
            || l.accounts
                .as_ref()
                .is_some_and(|rows| rows.iter().any(|r| r.captured_at.is_some()))
    };
    merge_provider_into_limits(existing, "claude", fresh_claude, now, false, has_capture)
}

/// Synchronously refresh Cursor, Codex, and Gemini then update `limits.json` once, without an
/// AppCtx. This launchd path must wait for its bounded Codex (20s) and Gemini (45s) children because
/// launchd kills the job's process group on exit; even the worst case stays far below the 300s interval.
/// Claude is re-derived from its captures (HED-348) but is never refreshed here.
pub(crate) fn refresh_cursor_limits() -> Result<bool, String> {
    let fetched = cursor_fetch::fetch_and_write();
    let now = now_secs();
    let path = usage_dir().join("limits.json");
    let existing = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Null);
    let active = existing["limits"]
        .as_array()
        .and_then(|limits| {
            limits
                .iter()
                .find(|limit| limit["provider"].as_str() == Some("claude"))
        })
        .and_then(|claude| claude["activeAccount"].as_str())
        .map(str::to_string);
    let merged = refresh_headless_limits_with_paths(
        existing,
        cursor::limit(now),
        claude::limit_preserving_active(active.as_deref(), now),
        &home().join(codex::CACHE_REL),
        &home().join(codex::HELPER_REL),
        &usage_dir().join("gemini.json"),
        gemini::agy_profile_exists(),
        &headless_agy_bin(),
        &usage_dir(),
        now,
    )?;
    write_json_atomic(&path, &merged)?;
    Ok(fetched)
}

#[allow(clippy::too_many_arguments)]
fn refresh_headless_limits_with_paths(
    existing: serde_json::Value,
    fresh_cursor: Option<ProviderLimit>,
    fresh_claude: Option<ProviderLimit>,
    codex_cache: &Path,
    codex_helper: &Path,
    gemini_snapshot: &Path,
    gemini_profile_exists: bool,
    gemini_bin: &str,
    gemini_work_dir: &Path,
    now: i64,
) -> Result<serde_json::Value, String> {
    let codex = match codex::refresh_and_limit_with_paths(codex_cache, codex_helper, now) {
        Ok(limit) => limit,
        Err(why) => {
            eprintln!("heddle: codex refresh skipped: {why}");
            None
        }
    };
    let gemini = match gemini::refresh_and_limit_with_paths(
        gemini_snapshot,
        gemini_profile_exists,
        gemini_bin,
        gemini_work_dir,
        now,
    ) {
        Ok(limit) => limit,
        Err(why) => {
            eprintln!("heddle: gemini refresh skipped: {why}");
            gemini::limit_from_snapshot_path(gemini_snapshot, gemini_profile_exists, now)
        }
    };
    let has_capture = |limit: &ProviderLimit| {
        limit.captured_at.is_some()
            || limit
                .accounts
                .as_ref()
                .is_some_and(|rows| rows.iter().any(|row| row.captured_at.is_some()))
    };
    let merged = merge_cursor_into_limits(existing, fresh_cursor, now);
    let merged = merge_claude_into_limits(merged, fresh_claude, now);
    let merged = merge_provider_into_limits(merged, "codex", codex, now, false, has_capture);
    Ok(merge_provider_into_limits(
        merged,
        "gemini",
        gemini,
        now,
        false,
        has_capture,
    ))
}

/// Reads the last mirrored Claude account caps without refreshing or writing any provider state.
/// The pocket host uses this out-of-process contract because its handlers must remain read-only.
pub(crate) fn mirrored_claude_account_usage(account_id: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(usage_dir().join("limits.json")).ok()?;
    let limits: serde_json::Value = serde_json::from_str(&text).ok()?;
    let account = limits["limits"]
        .as_array()?
        .iter()
        .find(|limit| limit["provider"].as_str() == Some("claude"))?["accounts"]
        .as_array()?
        .iter()
        .find(|account| account["id"].as_str() == Some(account_id))?;
    Some(serde_json::json!({
        "fiveHour": account["fiveHour"],
        "sevenDay": account["sevenDay"],
    }))
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
