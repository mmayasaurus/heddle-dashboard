//! Gemini caps from the Antigravity CLI (`agy`), the CLI heddle drives Gemini workers with.
//!
//! SOURCE: `agy -p "/quota" --output-format json` — since agy 1.1.11 the read-only slash commands
//! (`/quota`, `/usage`, `/credits`, …) answer non-interactively in print mode "without starting an
//! agent turn, spending quota, or leaving a conversation behind" (agy changelog). It forces a quota
//! reload against Google's Code Assist endpoint using agy's own login, and returns
//! `command.data.groups[]`, each group holding `buckets[]`:
//!   `{id: "gemini-5h" | "gemini-weekly" | "3p-5h" | "3p-weekly", window: "5h" | "weekly",
//!     remaining_fraction: 0..1, reset_time: RFC3339}`
//! Two groups today: **"Gemini Models"** (Flash/Pro — what heddle routes to; becomes the entry's
//! 5h/7d) and **"Claude and GPT models"** (Antigravity's third-party bucket; surfaced as extra
//! `windows`). Live-verified 2026-08-15 (agy 1.1.13). A bucket without `remaining_fraction`
//! (agy shows such buckets as "Disabled") yields an empty window.
//!
//! COST: ~3s wall clock and a few Google round trips per run, so it never runs inline. The Tauri
//! command reads the snapshot `~/.heddle/usage/gemini.json` (tap format + extras) and, when it is
//! older than `REFRESH_AFTER_SECS`, kicks ONE detached refresh thread (`agy … --log-file /dev/null`
//! so it doesn't leave a log file per run) that rewrites the snapshot atomically. Failures are
//! recorded in the snapshot (`lastError` / `lastAttemptAt`) and backed off, so a missing/unauthed
//! agy shows up in the drawer as an explained gap rather than nothing.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    augmented_path, is_stale, now_secs, run_with_timeout, tap_limit, usage_dir, write_json_atomic,
    LimitWindow, NamedWindow, ProviderLimit,
};

/// Snapshot file name under `~/.heddle/usage/`.
const SNAPSHOT: &str = "gemini.json";
pub(super) const SOURCE: &str = "agy-quota";
// Note codes (the localizable key layer for `note`).
pub(super) const CODE_REFRESH_FAILED: &str = "gemini.refreshFailed";
pub(super) const CODE_NO_DATA_YET: &str = "gemini.noDataYet";
/// Refresh when the snapshot is older than this. Slow-changing gauge; the drawer's refresh button
/// (`heddle_refresh_provider_limits`) forces one on demand.
pub(super) const REFRESH_AFTER_SECS: i64 = 180;
/// Flag `stale` when the snapshot hasn't managed to refresh in this long (agy missing/unauthed,
/// network down) — see `lastError` in the snapshot for why.
pub(super) const STALE_AFTER_SECS: i64 = 600;
/// After a failed refresh, wait this long before trying again (don't hammer a broken agy).
const FAILURE_BACKOFF_SECS: i64 = 120;
/// Wall-clock budget for one `agy` run (observed ~3s; the language-server startup can be slow).
const AGY_TIMEOUT: Duration = Duration::from_secs(45);
/// The group whose buckets become the entry's 5h/7d — heddle's Gemini workers draw from it.
const PRIMARY_BUCKET_PREFIX: &str = "gemini-";

static REFRESHING: AtomicBool = AtomicBool::new(false);
static NEXT_ATTEMPT_AT: AtomicI64 = AtomicI64::new(0);

fn snapshot_path() -> std::path::PathBuf {
    usage_dir().join(SNAPSHOT)
}

/// Read the snapshot (kicking a refresh if it is old or missing) and return the Gemini entry.
/// `agy_bin` is the executable to refresh with (the app's configured Antigravity path, else a
/// located install, else bare `agy` on the augmented PATH). `None` only when there is no snapshot
/// yet — the very first poll after install.
pub(super) fn limit(now: i64, agy_bin: &str) -> Option<ProviderLimit> {
    let snap = std::fs::read_to_string(snapshot_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let captured_at = snap.as_ref().and_then(|v| v["capturedAt"].as_i64());
    if captured_at
        .map(|t| now - t > REFRESH_AFTER_SECS)
        .unwrap_or(true)
    {
        maybe_spawn_refresh(now, false, agy_bin);
    }
    parse_snapshot(&snap?, now)
}

/// Force a refresh regardless of snapshot age (respects the in-flight guard, ignores the failure
/// backoff). `true` when a refresh thread was started.
pub(super) fn force_refresh(now: i64, agy_bin: &str) -> bool {
    maybe_spawn_refresh(now, true, agy_bin)
}

/// Clears the in-flight flag when the refresh thread ends — including by panic — so a wedged
/// refresher can't silently stop Gemini from ever refreshing again.
struct RefreshGuard;
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        REFRESHING.store(false, Ordering::SeqCst);
    }
}

/// Start ONE detached refresh unless one is already running (or we're inside the failure backoff
/// and this isn't a forced refresh).
fn maybe_spawn_refresh(now: i64, force: bool, agy_bin: &str) -> bool {
    if !force && now < NEXT_ATTEMPT_AT.load(Ordering::SeqCst) {
        return false;
    }
    if REFRESHING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    let agy_bin = agy_bin.to_string();
    std::thread::spawn(move || {
        let _guard = RefreshGuard;
        let result = fetch_and_write(&agy_bin);
        let now = now_secs();
        NEXT_ATTEMPT_AT.store(
            if result.is_ok() {
                0
            } else {
                now + FAILURE_BACKOFF_SECS
            },
            Ordering::SeqCst,
        );
    });
    true
}

/// Run agy, build the snapshot, write it. On failure, keep whatever snapshot exists (its data and
/// `capturedAt` stay honest) but record `lastError` / `lastAttemptAt` so the reader can say why.
fn fetch_and_write(agy_bin: &str) -> Result<(), String> {
    let now = now_secs();
    let path = snapshot_path();
    match run_agy_quota(agy_bin) {
        Ok(data) => {
            let snap = snapshot_from_agy(&data, now);
            write_json_atomic(&path, &snap)
        }
        Err(e) => {
            let mut snap = std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .filter(Value::is_object)
                .unwrap_or_else(
                    || json!({"model": "antigravity", "rate_limits": {}, "source": SOURCE}),
                );
            snap["lastError"] = Value::String(e.clone());
            snap["lastAttemptAt"] = json!(now);
            // A failed snapshot write is a second, distinct failure — say so instead of hiding it
            // behind the agy error.
            match write_json_atomic(&path, &snap) {
                Ok(()) => Err(e),
                Err(w) => Err(format!(
                    "{e}; and the error snapshot could not be written: {w}"
                )),
            }
        }
    }
}

/// The OS null device for `--log-file` (agy writes a log file per run otherwise).
const NULL_LOG: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

/// `agy -p "/quota" --output-format json --log-file <null>` → `command.data`. Runs from the usage
/// dir (created first) so agy never picks up a project's config from the app's own cwd.
fn run_agy_quota(agy_bin: &str) -> Result<Value, String> {
    let dir = usage_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut cmd = std::process::Command::new(agy_bin);
    cmd.args([
        "-p",
        "/quota",
        "--output-format",
        "json",
        "--log-file",
        NULL_LOG,
    ])
    .env("PATH", augmented_path());
    if dir.is_dir() {
        cmd.current_dir(&dir);
    }
    let (ok, stdout, stderr) = run_with_timeout(cmd, AGY_TIMEOUT)?;
    if !ok {
        let tail: String = stderr
            .chars()
            .rev()
            .take(300)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!("agy exited non-zero: {}", tail.trim()));
    }
    // Print mode emits exactly one JSON object; tolerate leading noise by finding the first '{'.
    let start = stdout
        .find('{')
        .ok_or_else(|| "agy printed no JSON".to_string())?;
    let mut v: Value = serde_json::from_str(&stdout[start..])
        .map_err(|e| format!("agy JSON parse failed: {e}"))?;
    if v["status"].as_str() != Some("SUCCESS") {
        return Err(format!(
            "agy /quota status {}",
            v["status"].as_str().unwrap_or("?")
        ));
    }
    let data = v["command"]["data"].take();
    if !data["groups"].is_array() {
        return Err(
            "agy /quota answer has no command.data.groups (not logged in, or agy changed its shape)"
                .to_string(),
        );
    }
    Ok(data)
}

/// Build the snapshot: tap-format `model` / `rate_limits` / `capturedAt` (so anything reading
/// `~/.heddle/usage/*.json` sees Gemini in the same shape as Claude) plus `source`, the normalized
/// `groups`, and the raw agy `data` for inspection.
pub(super) fn snapshot_from_agy(data: &Value, now: i64) -> Value {
    let groups = normalize_groups(data);
    let (five, seven) = primary_windows(&groups);
    json!({
        "model": "antigravity",
        "rate_limits": {
            "five_hour": {"used_percentage": five.used_percentage, "resets_at": five.resets_at},
            "seven_day": {"used_percentage": seven.used_percentage, "resets_at": seven.resets_at},
        },
        "capturedAt": now,
        "source": SOURCE,
        "groups": groups.iter().map(|g| json!({
            "name": g.name,
            "buckets": g.buckets.iter().map(|b| json!({
                "id": b.id, "window": b.window, "used_percentage": b.used_percentage, "resets_at": b.resets_at,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "raw": data,
    })
}

struct Bucket {
    id: String,
    window: String,
    used_percentage: Option<f64>,
    resets_at: Option<i64>,
}
struct Group {
    name: String,
    buckets: Vec<Bucket>,
}

/// agy `groups[]` → percent-used + epoch reset per bucket. `remaining_fraction` absent (a bucket
/// agy shows as "Disabled") → `used_percentage: None`.
fn normalize_groups(data: &Value) -> Vec<Group> {
    let mut out = Vec::new();
    let Some(groups) = data["groups"].as_array() else {
        return out;
    };
    for g in groups {
        let name = g["name"].as_str().unwrap_or("?").to_string();
        let mut buckets = Vec::new();
        for b in g["buckets"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            buckets.push(Bucket {
                id: b["id"].as_str().unwrap_or("?").to_string(),
                window: b["window"].as_str().unwrap_or("?").to_string(),
                used_percentage: b["remaining_fraction"]
                    .as_f64()
                    .map(|r| ((1.0 - r) * 100.0).clamp(0.0, 100.0)),
                resets_at: b["reset_time"].as_str().and_then(parse_rfc3339),
            });
        }
        out.push(Group { name, buckets });
    }
    out
}

/// Index of the primary group: the one with "gemini-*" bucket ids, else the first group if agy
/// ever renames the ids (so the entry never silently goes blank). The SAME selection feeds the
/// 5h/7d slots and excludes that group from the named windows — no double counting on fallback.
fn primary_index(groups: &[Group]) -> Option<usize> {
    groups
        .iter()
        .position(|g| {
            g.buckets
                .iter()
                .any(|b| b.id.starts_with(PRIMARY_BUCKET_PREFIX))
        })
        .or(if groups.is_empty() { None } else { Some(0) })
}

/// The 5h/7d pair of the primary group.
fn primary_windows(groups: &[Group]) -> (LimitWindow, LimitWindow) {
    let primary = primary_index(groups).map(|i| &groups[i]);
    let mut five = LimitWindow::default();
    let mut seven = LimitWindow::default();
    if let Some(g) = primary {
        for b in &g.buckets {
            let w = LimitWindow {
                used_percentage: b.used_percentage,
                resets_at: b.resets_at,
            };
            match b.window.as_str() {
                "5h" => five = w,
                "weekly" | "7d" => seven = w,
                _ => {}
            }
        }
    }
    (five, seven)
}

/// "2026-08-21T22:08:38Z" → epoch seconds. RFC3339 with offset or fractional seconds also parses.
pub(super) fn parse_rfc3339(s: &str) -> Option<i64> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|t| t.unix_timestamp())
}

/// Snapshot → ProviderLimit: the tap-format base plus the non-primary groups as named windows,
/// staleness against `STALE_AFTER_SECS`, and the last refresh error (if any) as the note.
pub(super) fn parse_snapshot(snap: &Value, now: i64) -> Option<ProviderLimit> {
    let mut l = tap_limit("gemini", snap, now)?;
    l.source = Some(SOURCE.to_string());
    l.stale = is_stale(l.captured_at, now, STALE_AFTER_SECS);
    l.stale_after_secs = Some(STALE_AFTER_SECS);
    let groups = normalize_groups(&snap["raw"]);
    let primary = primary_index(&groups);
    let mut windows = Vec::new();
    for (i, g) in groups.iter().enumerate() {
        if Some(i) == primary {
            continue;
        }
        for b in &g.buckets {
            let tag = match b.window.as_str() {
                "weekly" => "7d",
                other => other,
            };
            windows.push(NamedWindow {
                id: b.id.clone(),
                label: format!("{} {tag}", g.name),
                used_percentage: b.used_percentage,
                resets_at: b.resets_at,
                used_amount: None,
                limit_amount: None,
                unit: None,
            });
        }
    }
    l.windows = Some(windows);
    l.note_codes = Some(Vec::new());
    if let Some(err) = snap["lastError"].as_str() {
        let when = snap["lastAttemptAt"].as_i64().unwrap_or(0);
        let (code, text) = if l.captured_at.is_some() {
            (
                CODE_REFRESH_FAILED,
                format!("last refresh failed ({}s ago): {err}", now - when),
            )
        } else {
            (
                CODE_NO_DATA_YET,
                format!("no data yet — agy /quota failed: {err}"),
            )
        };
        l.note = Some(text);
        l.note_codes = Some(vec![code.to_string()]);
    }
    Some(l)
}

#[cfg(test)]
#[path = "gemini_tests.rs"]
mod tests;
