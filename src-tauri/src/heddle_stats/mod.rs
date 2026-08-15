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

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;

mod claude;
mod codex;
mod cursor;
mod gemini;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

// ─────────────────────────── ccusage (provider caps) ───────────────────────────

/// GUI apps launched from Finder/Dock don't inherit the shell PATH, so `ccusage` / `claudex-usage` /
/// `agy` (installed via bun/npm/brew/curl) won't resolve by bare name. APPEND the usual install homes
/// (after the inherited PATH, so a user's own ordering still wins) using the platform's separator.
fn augmented_path() -> std::ffi::OsString {
    let h = home();
    let extra = [
        h.join(".bun/bin"),
        h.join(".npm-global/bin"),
        h.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&current).collect();
    for p in extra {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    // join_paths only fails if a dir contains the separator itself; keep the inherited PATH then.
    std::env::join_paths(dirs).unwrap_or(current)
}

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
fn ledger() -> Result<Option<Connection>, String> {
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
async fn blocking<T: Send + 'static>(
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
}

/// The statusline tap only writes when a Claude session renders its statusline, so an idle fleet
/// simply goes quiet. Ten minutes means "nobody rendered recently", flagged so the drawer doesn't
/// present an old number as live.
const TAP_STALE_AFTER_SECS: i64 = 600;

pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `Some(true)` when the capture is older than `after` seconds; `None` when there is nothing to
/// judge (no capture time).
pub(crate) fn is_stale(captured_at: Option<i64>, now: i64, after: i64) -> Option<bool> {
    captured_at.map(|t| now - t > after)
}

/// Mask an email for display: first character of the local part + the full domain
/// ("alice@example.com" → "a…@example.com"). Anything that isn't `local@domain` is returned as-is.
pub(crate) fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) if !local.is_empty() && !domain.is_empty() => {
            let first = local.chars().next().unwrap_or('?');
            format!("{first}…@{domain}")
        }
        _ => email.to_string(),
    }
}

/// `~/.heddle/usage/` — the statusline tap's snapshot dir; per-provider refreshers write here too.
pub(crate) fn usage_dir() -> PathBuf {
    home().join(".heddle").join("usage")
}

/// Write JSON atomically (tmp + rename) so a reader never sees a half-written snapshot.
pub(crate) fn write_json_atomic(path: &Path, v: &serde_json::Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

/// Run a command with a wall-clock budget, returning (exit success, stdout, stderr). The child is
/// killed on timeout. stdout/stderr are drained on threads so a chatty child can't deadlock us.
pub(crate) fn run_with_timeout(
    mut cmd: Command,
    budget: Duration,
) -> Result<(bool, String, String), String> {
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    let drain = |pipe: Option<std::process::ChildStdout>,
                 err: Option<std::process::ChildStderr>| {
        std::thread::spawn(move || {
            let mut out = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut out);
            }
            if let Some(mut e) = err {
                let _ = e.read_to_string(&mut out);
            }
            out
        })
    };
    let out_t = drain(child.stdout.take(), None);
    let err_t = drain(None, child.stderr.take());
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) if started.elapsed() >= budget => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("timed out after {}s", budget.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => break Err(format!("wait failed: {e}")),
        }
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    let st = status?;
    Ok((st.success(), stdout, stderr))
}

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
pub async fn heddle_provider_limits() -> Result<Vec<ProviderLimit>, String> {
    blocking(provider_limits_sync).await
}

fn provider_limits_sync() -> Result<Vec<ProviderLimit>, String> {
    let now = now_secs();
    let mut out = tap_limits(&usage_dir(), now);
    // Claude: the per-account view (registry + claude-<id>.json) replaces the plain tap entry.
    if let Some(c) = claude::limit(now) {
        out.retain(|l| l.provider != "claude");
        out.push(c);
    }
    if let Some(c) = codex::limit(now) {
        out.push(c);
    }
    if let Some(g) = gemini::limit(now) {
        out.push(g);
    }
    if let Some(c) = cursor::limit(now) {
        out.push(c);
    }
    sort_limits(&mut out);
    // Mirror the exact contract for out-of-process consumers (heddle-core's cap-aware router):
    // `{writtenAt, limits: Vec<ProviderLimit>}`. Best-effort; a failed write never fails the poll.
    if let Ok(v) = serde_json::to_value(&out) {
        let _ = write_json_atomic(
            &usage_dir().join("limits.json"),
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
    provider: Option<String>,
) -> Result<Vec<String>, String> {
    blocking(move || refresh_provider_limits_sync(provider)).await
}

fn refresh_provider_limits_sync(provider: Option<String>) -> Result<Vec<String>, String> {
    let want = |p: &str| provider.as_deref().map(|w| w == p).unwrap_or(true);
    let mut kicked = Vec::new();
    let now = now_secs();
    if want("codex") && codex::force_refresh(now) {
        kicked.push("codex".to_string());
    }
    if want("gemini") && gemini::force_refresh(now) {
        kicked.push("gemini".to_string());
    }
    if want("cursor") && cursor::force_refresh(now) {
        kicked.push("cursor".to_string());
    }
    Ok(kicked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_email_keeps_first_char_and_domain() {
        assert_eq!(mask_email("alice@example.com"), "a…@example.com");
        assert_eq!(
            mask_email("6@privaterelay.appleid.com"),
            "6…@privaterelay.appleid.com"
        );
        assert_eq!(mask_email("?"), "?");
        assert_eq!(mask_email("@example.com"), "@example.com");
        assert_eq!(mask_email(""), "");
    }

    #[test]
    fn staleness_is_judged_against_the_source_threshold() {
        assert_eq!(is_stale(Some(1_000), 1_100, 300), Some(false));
        assert_eq!(is_stale(Some(1_000), 1_301, 300), Some(true));
        assert_eq!(is_stale(None, 1_000, 300), None);
    }

    #[test]
    fn tap_snapshot_parses_to_the_original_shape_plus_source_and_staleness() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"model":"claude-fable-5","rate_limits":{"five_hour":{"used_percentage":20,"resets_at":1786828200},"seven_day":{"used_percentage":9,"resets_at":1786892400}},"capturedAt":1786822375}"#,
        )
        .unwrap();
        let l = tap_limit("claude", &v, 1786822375 + 60).unwrap();
        assert_eq!(l.provider, "claude");
        assert_eq!(l.model.as_deref(), Some("claude-fable-5"));
        assert_eq!(l.captured_at, Some(1786822375));
        assert_eq!(l.five_hour.used_percentage, Some(20.0));
        assert_eq!(l.five_hour.resets_at, Some(1786828200));
        assert_eq!(l.seven_day.used_percentage, Some(9.0));
        assert_eq!(l.source.as_deref(), Some("statusline-tap"));
        assert_eq!(l.stale, Some(false));
        assert!(l.accounts.is_none() && l.windows.is_none() && l.note.is_none());
        // Ten minutes later with no re-render: flagged, not hidden.
        let old = tap_limit("claude", &v, 1786822375 + 601).unwrap();
        assert_eq!(old.stale, Some(true));
    }

    #[test]
    fn non_tap_json_is_ignored_by_the_tap_reader() {
        let v: serde_json::Value = serde_json::json!({"anything": "else"});
        assert!(tap_limit("gemini", &v, 0).is_none());
    }

    #[test]
    fn provider_limit_json_keeps_the_original_keys_and_adds_only_optional_ones() {
        let l = ProviderLimit {
            provider: "claude".into(),
            model: None,
            captured_at: None,
            five_hour: LimitWindow::default(),
            seven_day: LimitWindow::default(),
            source: None,
            stale: None,
            stale_after_secs: None,
            note: None,
            note_codes: None,
            accounts: None,
            active_account: None,
            windows: None,
        };
        let j = serde_json::to_value(&l).unwrap();
        for k in ["provider", "model", "capturedAt", "fiveHour", "sevenDay"] {
            assert!(j.get(k).is_some(), "original key {k} must stay");
        }
        assert_eq!(
            j["fiveHour"],
            serde_json::json!({"usedPercentage": null, "resetsAt": null})
        );
        for k in [
            "source",
            "stale",
            "staleAfterSecs",
            "note",
            "noteCodes",
            "accounts",
            "activeAccount",
            "windows",
        ] {
            assert!(j[k].is_null(), "additive key {k} must be null when absent");
        }
    }

    /// The exact JSON `heddle_provider_limits` serves (and mirrors to `~/.heddle/usage/limits.json`),
    /// built from the fixtures — one entry per provider — and pinned to
    /// `tests/fixtures/heddle_stats/limits.golden.json`. Out-of-process consumers (heddle-core's
    /// router) build their fixture tests from that file, so a contract change shows up here first.
    /// Regenerate deliberately with `cargo test --lib heddle_stats::tests::write_golden -- --ignored`.
    fn golden_limits() -> serde_json::Value {
        let now = 1_786_831_200;
        let claude_tap: serde_json::Value = serde_json::json!({
            "model": "claude-fable-5",
            "rate_limits": {"five_hour": {"used_percentage": 32, "resets_at": 1786846200},
                             "seven_day": {"used_percentage": 24, "resets_at": 1786892400}},
            "capturedAt": now - 60, "account": "acct1", "configDir": null
        });
        let claude = tap_limit("claude", &claude_tap, now).unwrap();
        let codex_cache: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/heddle_stats/claudex-usage-cache.lb.json"
        ))
        .unwrap();
        let mut codex = codex::parse_cache(&codex_cache, now).unwrap();
        // The fixture's fetched_at is older than the staleness threshold at `now`; pin it fresh so
        // the golden shows the common case.
        codex.captured_at = Some(now - 30);
        codex.stale = Some(false);
        for a in codex.accounts.iter_mut().flatten() {
            a.captured_at = Some(now - 30);
            a.stale = Some(false);
        }
        let agy: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/heddle_stats/agy-quota.json"
        ))
        .unwrap();
        let gemini_snap = gemini::snapshot_from_agy(&agy["command"]["data"], now - 90);
        let gemini = gemini::parse_snapshot(&gemini_snap, now).unwrap();
        let summary: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/heddle_stats/cursor-usage-summary.json"
        ))
        .unwrap();
        let cursor_snap = serde_json::json!({
            "model": "cursor.com · 1 acct", "rate_limits": {}, "capturedAt": now - 45,
            "source": cursor::SOURCE, "lastAttemptAt": now - 45,
            "accounts": [{"label": "v…@example.com", "source": cursor::SOURCE_IDE,
                          "tokenExpiresAt": now + 30 * 86_400, "membershipHint": "ultra",
                          "fetchedAt": now - 45, "summary": summary, "error": null}]
        });
        let cursor = cursor::parse_snapshot(&cursor_snap, now).unwrap();
        let mut all = vec![gemini, cursor, codex, claude];
        sort_limits(&mut all);
        serde_json::json!({ "writtenAt": now, "limits": all })
    }

    const GOLDEN_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/heddle_stats/limits.golden.json"
    );

    #[test]
    fn contract_json_matches_the_golden_file() {
        let want: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(GOLDEN_PATH).unwrap()).unwrap();
        let got = golden_limits();
        assert_eq!(
            got,
            want,
            "heddle_provider_limits contract drifted from tests/fixtures/heddle_stats/limits.golden.json — \
             if the change is intended (additive!), regenerate with \
             `cargo test --lib heddle_stats::tests::write_golden -- --ignored` and tell the consumers"
        );
    }

    /// Regenerates the golden file. Ignored so it never runs by accident.
    #[test]
    #[ignore]
    fn write_golden() {
        std::fs::write(
            GOLDEN_PATH,
            serde_json::to_string_pretty(&golden_limits()).unwrap() + "\n",
        )
        .unwrap();
    }

    #[test]
    fn drawer_order_is_claude_codex_then_alphabetical() {
        let mk = |p: &str| ProviderLimit {
            provider: p.into(),
            model: None,
            captured_at: None,
            five_hour: LimitWindow::default(),
            seven_day: LimitWindow::default(),
            source: None,
            stale: None,
            stale_after_secs: None,
            note: None,
            note_codes: None,
            accounts: None,
            active_account: None,
            windows: None,
        };
        let mut v = vec![mk("gemini"), mk("codex"), mk("cursor"), mk("claude")];
        sort_limits(&mut v);
        let order: Vec<&str> = v.iter().map(|l| l.provider.as_str()).collect();
        assert_eq!(order, ["claude", "codex", "cursor", "gemini"]);
    }
}
