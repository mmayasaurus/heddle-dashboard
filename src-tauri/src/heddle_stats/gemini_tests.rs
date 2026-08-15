//! Unit tests for `gemini.rs` (kept in a sibling file so the source file stays readable).

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
