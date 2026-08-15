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
/// `None` only when there is no snapshot yet — the very first poll after install.
pub(super) fn limit(now: i64) -> Option<ProviderLimit> {
    let snap = std::fs::read_to_string(snapshot_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let captured_at = snap.as_ref().and_then(|v| v["capturedAt"].as_i64());
    if captured_at
        .map(|t| now - t > REFRESH_AFTER_SECS)
        .unwrap_or(true)
    {
        maybe_spawn_refresh(now, false);
    }
    parse_snapshot(&snap?, now)
}

/// Force a refresh regardless of snapshot age (respects the in-flight guard, ignores the failure
/// backoff). `true` when a refresh thread was started.
pub(super) fn force_refresh(now: i64) -> bool {
    maybe_spawn_refresh(now, true)
}

/// Start ONE detached refresh unless one is already running (or we're inside the failure backoff
/// and this isn't a forced refresh).
fn maybe_spawn_refresh(now: i64, force: bool) -> bool {
    if !force && now < NEXT_ATTEMPT_AT.load(Ordering::SeqCst) {
        return false;
    }
    if REFRESHING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    std::thread::spawn(|| {
        let result = fetch_and_write();
        let now = now_secs();
        NEXT_ATTEMPT_AT.store(
            if result.is_ok() {
                0
            } else {
                now + FAILURE_BACKOFF_SECS
            },
            Ordering::SeqCst,
        );
        REFRESHING.store(false, Ordering::SeqCst);
    });
    true
}

/// Run agy, build the snapshot, write it. On failure, keep whatever snapshot exists (its data and
/// `capturedAt` stay honest) but record `lastError` / `lastAttemptAt` so the reader can say why.
fn fetch_and_write() -> Result<(), String> {
    let now = now_secs();
    let path = snapshot_path();
    match run_agy_quota() {
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
            let _ = write_json_atomic(&path, &snap);
            Err(e)
        }
    }
}

/// `agy -p "/quota" --output-format json --log-file /dev/null` → `command.data`.
fn run_agy_quota() -> Result<Value, String> {
    let mut cmd = std::process::Command::new("agy");
    cmd.args([
        "-p",
        "/quota",
        "--output-format",
        "json",
        "--log-file",
        "/dev/null",
    ])
    .env("PATH", augmented_path())
    .current_dir(usage_dir());
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
    let v: Value = serde_json::from_str(&stdout[start..])
        .map_err(|e| format!("agy JSON parse failed: {e}"))?;
    if v["status"].as_str() != Some("SUCCESS") {
        return Err(format!(
            "agy /quota status {}",
            v["status"].as_str().unwrap_or("?")
        ));
    }
    let data = &v["command"]["data"];
    if !data["groups"].is_array() {
        return Err("agy /quota answer has no command.data.groups (not logged in, or agy changed its shape)".to_string());
    }
    Ok(data.clone())
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

/// The 5h/7d pair of the primary ("gemini-*") group; falls back to the first group if agy ever
/// renames the ids, so the entry never silently goes blank.
fn primary_windows(groups: &[Group]) -> (LimitWindow, LimitWindow) {
    let primary = groups
        .iter()
        .find(|g| {
            g.buckets
                .iter()
                .any(|b| b.id.starts_with(PRIMARY_BUCKET_PREFIX))
        })
        .or_else(|| groups.first());
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

fn is_primary(g: &Group) -> bool {
    g.buckets
        .iter()
        .any(|b| b.id.starts_with(PRIMARY_BUCKET_PREFIX))
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
    let mut windows = Vec::new();
    for g in groups.iter().filter(|g| !is_primary(g)) {
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
mod tests {
    use super::*;

    /// A real `agy -p /quota --output-format json` answer (agy 1.1.13, 2026-08-15; no PII in it).
    const AGY_QUOTA: &str = include_str!("../../tests/fixtures/heddle_stats/agy-quota.json");

    fn data() -> Value {
        let v: Value = serde_json::from_str(AGY_QUOTA).unwrap();
        v["command"]["data"].clone()
    }

    #[test]
    fn rfc3339_reset_times_become_epoch_seconds() {
        assert_eq!(parse_rfc3339("2026-08-21T22:08:38Z"), Some(1_787_350_118));
        assert_eq!(
            parse_rfc3339("2026-08-21T22:08:38.5+02:00"),
            Some(1_787_342_918)
        );
        assert_eq!(parse_rfc3339("garbage"), None);
    }

    #[test]
    fn snapshot_is_tap_format_with_the_gemini_group_as_five_hour_and_seven_day() {
        let snap = snapshot_from_agy(&data(), 1_786_824_000);
        assert_eq!(snap["model"], "antigravity");
        assert_eq!(snap["source"], SOURCE);
        assert_eq!(snap["capturedAt"], 1_786_824_000);
        // gemini-5h remaining 0.9606… → 3.93% used; gemini-weekly remaining 0.9925… → 0.75% used.
        let five = snap["rate_limits"]["five_hour"]["used_percentage"]
            .as_f64()
            .unwrap();
        let seven = snap["rate_limits"]["seven_day"]["used_percentage"]
            .as_f64()
            .unwrap();
        assert!((five - 3.931).abs() < 0.01, "{five}");
        assert!((seven - 0.749).abs() < 0.01, "{seven}");
        assert_eq!(
            snap["rate_limits"]["five_hour"]["resets_at"],
            parse_rfc3339("2026-08-16T00:30:40Z").unwrap()
        );
        assert_eq!(
            snap["rate_limits"]["seven_day"]["resets_at"],
            parse_rfc3339("2026-08-21T22:08:38Z").unwrap()
        );
        // The generic tap reader can read it as-is (that's the point of the tap format).
        let as_tap = tap_limit("gemini", &snap, 1_786_824_000).unwrap();
        assert_eq!(as_tap.five_hour.resets_at, Some(1_786_840_240));
    }

    #[test]
    fn parse_snapshot_adds_the_third_party_group_as_named_windows_and_staleness() {
        let snap = snapshot_from_agy(&data(), 1_786_824_000);
        let l = parse_snapshot(&snap, 1_786_824_000 + 60).unwrap();
        assert_eq!(l.provider, "gemini");
        assert_eq!(l.source.as_deref(), Some(SOURCE));
        assert_eq!(l.stale, Some(false));
        assert_eq!(l.stale_after_secs, Some(STALE_AFTER_SECS));
        assert!(l.note.is_none());
        assert_eq!(l.note_codes.as_deref(), Some(&[][..]));
        let windows = l.windows.unwrap();
        let ids: Vec<&str> = windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["3p-weekly", "3p-5h"]);
        assert_eq!(windows[0].label, "Claude and GPT models 7d");
        assert_eq!(windows[0].used_percentage, Some(0.0));
        assert_eq!(windows[1].label, "Claude and GPT models 5h");
        // Old snapshot → stale.
        let old = parse_snapshot(&snap, 1_786_824_000 + STALE_AFTER_SECS + 1).unwrap();
        assert_eq!(old.stale, Some(true));
    }

    #[test]
    fn a_bucket_without_remaining_fraction_is_an_empty_window_not_a_crash() {
        let mut d = data();
        d["groups"][0]["buckets"][1]
            .as_object_mut()
            .unwrap()
            .remove("remaining_fraction");
        let snap = snapshot_from_agy(&d, 1);
        assert!(snap["rate_limits"]["five_hour"]["used_percentage"].is_null());
        assert!(snap["rate_limits"]["seven_day"]["used_percentage"].is_number());
    }

    #[test]
    fn unknown_group_ids_fall_back_to_the_first_group() {
        let mut d = data();
        for g in d["groups"].as_array_mut().unwrap() {
            for b in g["buckets"].as_array_mut().unwrap() {
                b["id"] = json!(format!("renamed-{}", b["window"].as_str().unwrap()));
            }
        }
        let snap = snapshot_from_agy(&d, 1);
        // First group is still "Gemini Models" → its 5h bucket lands in five_hour.
        let five = snap["rate_limits"]["five_hour"]["used_percentage"]
            .as_f64()
            .unwrap();
        assert!((five - 3.931).abs() < 0.01);
    }

    #[test]
    fn a_failed_refresh_is_explained_in_the_note() {
        let mut snap = snapshot_from_agy(&data(), 1_000);
        snap["lastError"] = json!("agy exited non-zero: not logged in");
        snap["lastAttemptAt"] = json!(1_100);
        let l = parse_snapshot(&snap, 1_130).unwrap();
        assert_eq!(
            l.note.as_deref(),
            Some("last refresh failed (30s ago): agy exited non-zero: not logged in")
        );
        assert_eq!(
            l.note_codes.as_deref(),
            Some(&[CODE_REFRESH_FAILED.to_string()][..])
        );
        // Data from the last good run is still there.
        assert!(l.five_hour.used_percentage.is_some());
        // No data ever: the tap base still parses (empty windows) and the note says so.
        let empty = json!({"model": "antigravity", "rate_limits": {}, "source": SOURCE, "lastError": "spawn failed", "lastAttemptAt": 5});
        let l = parse_snapshot(&empty, 10).unwrap();
        assert!(l.note.as_deref().unwrap().starts_with("no data yet"));
        assert_eq!(
            l.note_codes.as_deref(),
            Some(&[CODE_NO_DATA_YET.to_string()][..])
        );
        assert_eq!(l.five_hour, LimitWindow::default());
        assert_eq!(l.stale, None);
    }

    /// Machine-dependent: exercises the real refresh thread + atomic snapshot write, then reads
    /// the snapshot back through `limit()` exactly as the Tauri command does.
    #[test]
    #[ignore]
    fn live_refresh_writes_snapshot_and_limit_reads_it() {
        let started = now_secs();
        assert!(force_refresh(started), "refresh thread should start");
        // Wait for the detached refresh to land (agy takes a few seconds).
        for _ in 0..90 {
            std::thread::sleep(Duration::from_millis(500));
            if !REFRESHING.load(Ordering::SeqCst) {
                break;
            }
        }
        let snap: Value =
            serde_json::from_str(&std::fs::read_to_string(snapshot_path()).unwrap()).unwrap();
        println!(
            "snapshot capturedAt={} lastError={}",
            snap["capturedAt"], snap["lastError"]
        );
        let l = limit(now_secs()).expect("snapshot present → entry");
        println!("{}", serde_json::to_string_pretty(&l).unwrap());
        assert!(
            l.captured_at.unwrap_or(0) >= started,
            "snapshot must be fresh"
        );
    }

    /// Machine-dependent: runs the real `agy -p /quota` (≈3s, needs an agy login) and prints the
    /// entry the drawer receives. `cargo test --lib heddle_stats::gemini -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_agy_smoke() {
        match run_agy_quota() {
            Ok(data) => {
                let snap = snapshot_from_agy(&data, now_secs());
                let l = parse_snapshot(&snap, now_secs()).unwrap();
                println!("{}", serde_json::to_string_pretty(&l).unwrap());
            }
            Err(e) => println!("agy unavailable here: {e}"),
        }
    }
}
