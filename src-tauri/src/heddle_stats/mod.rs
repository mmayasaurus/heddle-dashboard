//! heddle orchestration stats — read-only views powering the Fleet drawer.
//!
//! Three independent, best-effort data sources exposed as Tauri commands:
//!   - **ccusage** (external CLI) → true rolling 5-hour / weekly provider-cap usage across every
//!     coding CLI it detects (claude, codex, gemini, …). We render its JSON verbatim.
//!   - **the heddle dispatch ledger** (`~/.heddle/ledger.db`) → what heddle itself dispatched and
//!     how it turned out (orchestrator, task class, model, tokens, pass/fail, in-flight).
//!   - **provider rate-limit caps** (`heddle_provider_limits`) → the TRUE per-provider cap numbers,
//!     one source per provider (see `docs/USAGE_TAP.md`): Claude from the statusline tap
//!     (`~/.heddle/usage/claude.json`), Codex from the claudex-usage cache (`codex.rs`).
//!
//! Everything here is read-only and best-effort: a missing ccusage or ledger yields an empty/typed
//! result rather than an error, so the drawer degrades gracefully instead of failing the whole app.
//!
//! CONTRACT NOTE: `heddle_provider_limits` → `Vec<ProviderLimit>` is consumed by
//! `src/layout/CenterPane/FleetDrawer.tsx`. It is additive-only: new providers are new entries, new
//! fields are `Option` — never rename/remove/retype an existing field.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;

mod codex;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

// ─────────────────────────── ccusage (provider caps) ───────────────────────────

/// GUI apps launched from Finder/Dock don't inherit the shell PATH, so `ccusage` (installed via
/// bun/npm/brew) won't resolve by bare name. Prepend the usual install homes; `ccusage` also needs
/// `bun`/`node`, which live in the same dirs.
fn augmented_path() -> String {
    let h = home();
    let extra = [
        h.join(".bun/bin"),
        h.join(".npm-global/bin"),
        h.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    let mut path = std::env::var("PATH").unwrap_or_default();
    for p in extra {
        path.push(':');
        path.push_str(&p.to_string_lossy());
    }
    path
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

/// Most recent dispatches, newest first (default 25, capped 200).
#[tauri::command]
pub fn heddle_recent(limit: Option<i64>) -> Result<Vec<Dispatch>, String> {
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
pub fn heddle_in_flight() -> Result<Vec<Dispatch>, String> {
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
pub fn heddle_provider_usage() -> Result<Vec<ProviderUsage>, String> {
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
    pub label: String,
    pub plan: Option<String>,
    pub five_hour: LimitWindow,
    pub seven_day: LimitWindow,
    pub windows: Vec<NamedWindow>,
    pub limit_reached: Option<bool>,
    pub note: Option<String>,
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
    /// Human-readable caveat about the payload (e.g. a window the provider stopped exposing).
    pub note: Option<String>,
    /// Per-account rows for multi-account providers. `None` when the provider has no such notion.
    pub accounts: Option<Vec<AccountLimit>>,
    /// Extra named windows beyond 5h/7d, binding (max) across accounts. `None` when N/A.
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
        accounts: None,
        windows: None,
    })
}

/// Read every tap snapshot in `dir`. Best-effort: unreadable/non-tap files are skipped. Codex is
/// deliberately not read from a tap file — its source is the claudex-usage cache (`codex.rs`).
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
        if provider == "codex" {
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
/// (claude) plus Codex from the claudex-usage cache. Best-effort — absent sources simply yield
/// fewer entries. Cheap (file reads only); slow sources refresh themselves out-of-band.
#[tauri::command]
pub fn heddle_provider_limits() -> Result<Vec<ProviderLimit>, String> {
    let now = now_secs();
    let mut out = tap_limits(&home().join(".heddle").join("usage"), now);
    if let Some(c) = codex::limit(now) {
        out.push(c);
    }
    sort_limits(&mut out);
    Ok(out)
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
            accounts: None,
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
            "accounts",
            "windows",
        ] {
            assert!(j[k].is_null(), "additive key {k} must be null when absent");
        }
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
            accounts: None,
            windows: None,
        };
        let mut v = vec![mk("gemini"), mk("codex"), mk("cursor"), mk("claude")];
        sort_limits(&mut v);
        let order: Vec<&str> = v.iter().map(|l| l.provider.as_str()).collect();
        assert_eq!(order, ["claude", "codex", "cursor", "gemini"]);
    }
}
