//! heddle orchestration stats — read-only views powering the Fleet drawer.
//!
//! Two independent, best-effort data sources exposed as Tauri commands:
//!   - **ccusage** (external CLI) → true rolling 5-hour / weekly provider-cap usage across every
//!     coding CLI it detects (claude, codex, gemini, …). We render its JSON verbatim.
//!   - **the heddle dispatch ledger** (`~/.heddle/ledger.db`) → what heddle itself dispatched and
//!     how it turned out (orchestrator, task class, model, tokens, pass/fail, in-flight).
//!
//! Everything here is read-only and best-effort: a missing ccusage or ledger yields an empty/typed
//! result rather than an error, so the drawer degrades gracefully instead of failing the whole app.

use std::path::PathBuf;
use std::process::Command;

use rusqlite::Connection;
use serde::Serialize;

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
    let rows = stmt.query_map([], map_dispatch).map_err(|e| e.to_string())?;
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

// ─────────────────── provider rate-limit caps (from the statusline tap) ───────────────────

/// One rate-limit window (5-hour or 7-day): percent used + reset time (epoch SECONDS).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    used_percentage: Option<f64>,
    resets_at: Option<i64>,
}

/// A provider's live rate-limit state, captured from its Claude Code statusline payload by the
/// `~/.heddle/usage-tap.mjs` passthrough tap. These are the TRUE cap numbers — the exact values the
/// statusline shows — not a spend estimate.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimit {
    provider: String,
    model: Option<String>,
    captured_at: Option<i64>,
    five_hour: LimitWindow,
    seven_day: LimitWindow,
}

/// Codex/GPT caps from `claudex-usage`'s cache (~/.local/state/claudex-usage-cache.json), which polls
/// chatgpt.com/backend-api/wham/usage per ChatGPT account. The claudex LB round-robins 2 accounts; we
/// surface the BINDING (max) usage per window across them — the account nearest a wall is what limits
/// you. Windows map to 5h/7d by length. Cache refreshes when claudex sessions render (TTL 60s), so
/// `capturedAt` reveals staleness.
fn codex_limit_from_claudex_cache() -> Option<ProviderLimit> {
    let path = home()
        .join(".local")
        .join("state")
        .join("claudex-usage-cache.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let accounts = v["payload"].as_array()?;
    if accounts.is_empty() {
        return None;
    }
    let mut five = LimitWindow {
        used_percentage: None,
        resets_at: None,
    };
    let mut seven = LimitWindow {
        used_percentage: None,
        resets_at: None,
    };
    for acct in accounts {
        let rl = &acct["data"]["rate_limit"];
        for wk in ["primary_window", "secondary_window"] {
            let w = &rl[wk];
            if w.is_null() {
                continue;
            }
            let secs = w["limit_window_seconds"].as_i64().unwrap_or(0);
            let pct = w["used_percent"].as_f64();
            let reset = w["reset_at"].as_i64();
            let target = if secs < 100_000 { &mut five } else { &mut seven };
            // Keep the max used_percent (the binding account) with that account's reset time.
            if pct.unwrap_or(-1.0) > target.used_percentage.unwrap_or(-1.0) {
                target.used_percentage = pct;
                target.resets_at = reset;
            }
        }
    }
    // Self-refresh: if the cache is stale (>90s), kick claudex-usage to update it (detached,
    // best-effort) so the next poll reads fresh data — render-independent, no claudex session needed.
    if let Some(fetched) = v["fetched_at"].as_f64() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        if now - fetched > 90.0 {
            let bin = home().join(".local").join("bin").join("claudex-usage");
            let _ = std::process::Command::new(&bin)
                .args(["--refresh", "lb"])
                .env("PATH", augmented_path())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
    Some(ProviderLimit {
        provider: "codex".to_string(),
        model: Some(format!("chatgpt · {} acct", accounts.len())),
        captured_at: v["fetched_at"].as_f64().map(|f| f as i64),
        five_hour: five,
        seven_day: seven,
    })
}

/// Read the per-provider rate-limit snapshots the statusline tap writes to
/// `~/.heddle/usage/<provider>.json` (claude), plus Codex from the claudex-usage cache. Best-effort:
/// absent sources simply yield fewer entries.
#[tauri::command]
pub fn heddle_provider_limits() -> Result<Vec<ProviderLimit>, String> {
    let dir = home().join(".heddle").join("usage");
    let mut out: Vec<ProviderLimit> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
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
        // Codex is sourced from the claudex-usage cache below, not a tap file.
        if provider == "codex" {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let rl = &v["rate_limits"];
        let win = |k: &str| LimitWindow {
            used_percentage: rl[k]["used_percentage"].as_f64(),
            resets_at: rl[k]["resets_at"].as_i64(),
        };
        out.push(ProviderLimit {
            provider,
            model: v["model"].as_str().map(str::to_string),
            captured_at: v["capturedAt"].as_i64(),
            five_hour: win("five_hour"),
            seven_day: win("seven_day"),
        });
    }
    // Codex/GPT caps come from claudex-usage's cache (per-account wham/usage), not the tap.
    if let Some(c) = codex_limit_from_claudex_cache() {
        out.push(c);
    }
    // Stable order: claude, codex, then the rest alphabetically.
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
    Ok(out)
}
