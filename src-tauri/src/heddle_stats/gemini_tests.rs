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
    // …and that same group is NOT repeated as named windows (only the other group is).
    let l = parse_snapshot(&snap, 2).unwrap();
    let ids: Vec<String> = l.windows.unwrap().into_iter().map(|w| w.id).collect();
    assert_eq!(ids, ["renamed-weekly", "renamed-5h"]);
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
    assert!(force_refresh(started, "agy"), "refresh thread should start");
    // Wait for the detached refresh to land (agy takes a few seconds).
    for _ in 0..90 {
        std::thread::sleep(Duration::from_millis(500));
        if !GATE.in_flight() {
            break;
        }
    }
    let snap: Value =
        serde_json::from_str(&std::fs::read_to_string(snapshot_path()).unwrap()).unwrap();
    println!(
        "snapshot capturedAt={} lastError={}",
        snap["capturedAt"], snap["lastError"]
    );
    let l = limit(now_secs(), "agy").expect("snapshot present → entry");
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
    match run_agy_quota("agy") {
        Ok(data) => {
            let snap = snapshot_from_agy(&data, now_secs());
            let l = parse_snapshot(&snap, now_secs()).unwrap();
            println!("{}", serde_json::to_string_pretty(&l).unwrap());
        }
        Err(e) => println!("agy unavailable here: {e}"),
    }
}

// ── HED-114: a background refresh must never start a sign-in it cannot finish ──────────────────

#[test]
fn a_timeout_or_auth_shaped_failure_is_read_as_needing_a_human() {
    // A browser prompt an unattended child cannot answer shows up as the run hitting its budget.
    assert!(looks_like_auth_attempt("timed out after 45s"));
    // …and anything that names the flow directly.
    for err in [
        "agy exited non-zero: please sign in to continue",
        "Sign-In required",
        "not logged in",
        "starting OAuth flow",
        "opening browser to authenticate",
        "paste the code here",
        "no credential found",
    ] {
        assert!(looks_like_auth_attempt(err), "{err}");
    }
    // Ordinary failures must NOT arm the block — they retry normally.
    for err in [
        "agy /quota status ERROR",
        "agy printed no JSON",
        "agy JSON parse failed: expected value",
        "cannot create /Users/x/.heddle/usage: Permission denied",
    ] {
        assert!(!looks_like_auth_attempt(err), "{err}");
    }
}

#[test]
fn without_an_agy_profile_no_refresh_may_run_not_even_a_forced_one() {
    // The exact live incident: HOME pointed at a fixture with no ~/.gemini/antigravity-cli, so a
    // refresh would CREATE it by starting an OAuth flow at the user.
    let (code, why) =
        refresh_blocked_reason(None, false, false).expect("auto refresh must be blocked");
    assert_eq!(code, CODE_NO_PROFILE);
    assert!(why.contains("not starting a sign-in"), "{why}");
    // Even an explicit button press is refused: our child has piped stdio and could never finish it.
    let (code, why) =
        refresh_blocked_reason(None, false, true).expect("forced refresh must be blocked too");
    assert_eq!(code, CODE_NO_PROFILE);
    assert!(why.contains("run `agy` once in a terminal"), "{why}");
}

#[test]
fn a_sticky_auth_block_stops_the_timer_but_not_the_person() {
    let blocked: Value = serde_json::json!({
        "authBlocked": true,
        "lastError": "timed out after 45s",
    });
    // The 180s timer is silenced — this is what stops the repeat-prompt loop.
    let (code, why) =
        refresh_blocked_reason(Some(&blocked), true, false).expect("auto refresh must be blocked");
    assert_eq!(code, CODE_AUTH_BLOCKED);
    assert!(why.contains("timed out after 45s"), "{why}");
    assert!(why.contains("refresh button"), "{why}");
    // A person at the keyboard may retry once they have signed in.
    assert!(refresh_blocked_reason(Some(&blocked), true, true).is_none());
    // With a profile and no block, the timer runs normally.
    let clean: Value = serde_json::json!({"capturedAt": 1_786_830_000});
    assert!(refresh_blocked_reason(Some(&clean), true, false).is_none());
    // authBlocked absent/false behaves the same as clean.
    let unblocked: Value = serde_json::json!({"authBlocked": false});
    assert!(refresh_blocked_reason(Some(&unblocked), true, false).is_none());
}

#[test]
fn a_successful_refresh_clears_the_block_and_a_failed_one_re_arms_it() {
    // snapshot_from_agy is what a success writes: it carries no authBlocked flag at all, so the
    // next poll sees a clean snapshot and the timer resumes.
    let snap = snapshot_from_agy(&data(), 1_786_830_000);
    assert!(snap.get("authBlocked").is_none());
    assert!(refresh_blocked_reason(Some(&snap), true, false).is_none());
    // The failure path arms it only for auth-shaped errors (asserted directly above); the parse
    // side then surfaces the pause honestly rather than showing a silently-frozen gauge.
    let mut armed = snap.clone();
    armed["authBlocked"] = serde_json::json!(true);
    armed["lastError"] = serde_json::json!("timed out after 45s");
    let (code, _) = refresh_blocked_reason(Some(&armed), true, false).unwrap();
    assert_eq!(code, CODE_AUTH_BLOCKED);
}
