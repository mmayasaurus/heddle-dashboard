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
fn an_auth_shaped_failure_is_read_as_needing_a_human() {
    // Anything that names the sign-in flow directly.
    for err in [
        "agy exited non-zero: please sign in to continue",
        "Sign-In required",
        "not logged in",
        "starting OAuth flow",
        "opening browser to authenticate",
        "paste the code here",
        "no credential found",
    ] {
        assert!(is_auth_shaped(err), "{err}");
    }
    // Ordinary failures must NOT arm the block — they retry normally.
    for err in [
        "agy /quota status ERROR",
        "agy printed no JSON",
        "agy JSON parse failed: expected value",
        "cannot create /Users/x/.heddle/usage: Permission denied",
    ] {
        assert!(!is_auth_shaped(err), "{err}");
        assert!(!is_timeout(err), "{err}");
    }
    // Nothing to go on is not evidence of a human being needed.
    assert!(!is_auth_shaped(""));
    assert!(!is_timeout(""));
}

/// The detector is deliberately OVER-inclusive, and this pins that boundary so a later "cleanup"
/// cannot narrow it by accident. Each of these is a plausible non-auth failure that still contains
/// a marker word, and each is classified as auth-shaped on purpose: the two mistakes have wildly
/// different costs. A false positive pauses automatic refresh until someone clicks the refresh
/// button — one stale gauge, one click. A false negative re-runs `agy` every 180s against a CLI
/// that wants a human, which is HED-114 itself: a browser prompt every three minutes, forever.
/// Buying the cheap mistake to avoid the expensive one is the whole design; if you tighten these
/// markers, you are trading in the direction that produced the incident.
///
/// "timed out" is deliberately NOT in this list (HED-188): a timeout is bounded-retry-then-sticky
/// (see `is_timeout` / `TIMEOUT_STREAK_STICKY`), not immediately auth-shaped — see the HED-188
/// test block below.
#[test]
fn ambiguous_wording_is_treated_as_auth_shaped_because_the_two_mistakes_cost_differently() {
    for err in ["browser cache corrupted", "credential file parse error"] {
        assert!(
            is_auth_shaped(err),
            "deliberately over-inclusive, see doc comment: {err}"
        );
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
    // timeoutStreak at the sticky threshold: a genuine (non-legacy) block reached via three
    // consecutive timeouts — see the HED-188 migration tests below for the legacy shape.
    let blocked: Value = serde_json::json!({
        "authBlocked": true,
        "lastError": "timed out after 45s",
        "timeoutStreak": TIMEOUT_STREAK_STICKY,
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
    armed["timeoutStreak"] = serde_json::json!(TIMEOUT_STREAK_STICKY);
    let (code, _) = refresh_blocked_reason(Some(&armed), true, false).unwrap();
    assert_eq!(code, CODE_AUTH_BLOCKED);
}

#[test]
fn a_blocked_refresh_with_no_snapshot_still_shows_the_row_and_the_way_out() {
    // The first-run incident itself: no profile in this HOME, and no gemini.json was ever written
    // (we refuse to spawn, so not even an error snapshot exists). The provider must NOT vanish —
    // a missing row tells the operator nothing, and the whole point is the instruction.
    let entry = empty_entry();
    assert_eq!(entry.provider, "gemini");
    assert_eq!(entry.five_hour, LimitWindow::default());
    assert_eq!(entry.captured_at, None);
    assert_eq!(entry.source.as_deref(), Some(SOURCE));
    // …and the blocked reason is what gets attached to it (same shape limit() builds).
    let (code, why) = refresh_blocked_reason(None, false, false).unwrap();
    assert_eq!(code, CODE_NO_PROFILE);
    assert!(why.contains("run `agy` once in a terminal"), "{why}");
}

#[test]
fn an_ordinary_failure_after_signing_in_lifts_a_stale_block() {
    // Reported by review: sign in for real, click refresh, hit a transient network error — the old
    // authBlocked must not survive and disable the timer forever.
    assert!(!is_auth_shaped("agy JSON parse failed: expected value"));
    assert!(!is_timeout("agy JSON parse failed: expected value"));
    // record_failure clears a previously-set flag on a non-auth, non-timeout failure rather than
    // leaving it latched.
    let mut snap = snapshot_from_agy(&data(), 1_786_830_000);
    snap["authBlocked"] = serde_json::json!(true);
    assert!(refresh_blocked_reason(Some(&snap), true, false).is_some());
    record_failure(
        &mut snap,
        "agy JSON parse failed: expected value",
        1_786_830_100,
    );
    assert!(
        refresh_blocked_reason(Some(&snap), true, false).is_none(),
        "an ordinary failure must hand the timer back"
    );
}

#[test]
fn the_detector_boundary_is_pinned_including_awkward_cases() {
    // Empty/no-message failures are NOT auth — they retry on the normal backoff.
    assert!(!is_auth_shaped(""));
    assert!(!is_auth_shaped("   "));
    // Deliberately accepted over-blocking: these mention auth words without being login flows, and
    // we still pause. A stale gauge until someone clicks refresh is the cheap failure; a browser
    // prompt every 180s is the expensive one, so the detector leans this way ON PURPOSE.
    assert!(is_auth_shaped("browser cache corrupted"));
    assert!(is_auth_shaped("credential file parse error"));
    // Case and surrounding text do not matter.
    assert!(is_auth_shaped("FATAL: Please SIGN IN again"));
    assert!(is_auth_shaped(
        "agy exited non-zero: OAuth token refresh failed"
    ));
}

// ── HED-188: a transient timeout must not permanently pause background refresh ─────────────────
//
// The live incident: a one-off 45s agy timeout ~15h earlier set the sticky flag, which then
// blocked every background refresh until someone clicked the refresh button. `is_timeout` is
// still detected, but a single occurrence must not read as auth-shaped — only a run of
// `TIMEOUT_STREAK_STICKY` consecutive timeouts (a persistent hang) may arm the sticky block.

/// Shared setup for the streak tests below: a fresh snapshot run through `n` consecutive
/// `record_failure` timeouts, `AGY_TIMEOUT` apart (matching the real cadence).
fn setup_timeout_streak_snap(n: i64) -> Value {
    let mut snap = snapshot_from_agy(&data(), 1_000);
    for i in 1..=n {
        record_failure(&mut snap, "timed out after 45s", 1_000 + i * 45);
    }
    snap
}

#[test]
fn a_timeout_is_recognized_but_is_not_auth_shaped_on_its_own() {
    // The exact HED-188 split: a timeout is how an unanswerable browser prompt manifests, but
    // it's also how an ordinary slow round trip manifests, so on its own it must not be treated
    // as auth-shaped — only a persistent run of them (TIMEOUT_STREAK_STICKY) escalates to sticky.
    assert!(is_timeout("timed out after 45s"));
    assert!(!is_auth_shaped("timed out after 45s"));
}

#[test]
fn is_timeout_matches_only_the_exact_budget_timeout_string_not_any_mention_of_timed_out() {
    // The real wall-clock-budget kill, byte-for-byte what run_with_timeout produces.
    assert!(is_timeout("timed out after 45s"));
    // agy itself answering with wording that happens to mention a timeout is NOT our timeout —
    // agy responded, it didn't hang — so a loose "contains" match would misclassify it.
    assert!(!is_timeout("agy exited non-zero: request timed out"));
    assert!(!is_timeout(
        "agy exited non-zero: request timed out reading /quota"
    ));
    assert!(!is_timeout("TIMED OUT AFTER 45S"));
    assert!(!is_timeout("timed out after 46s"));
}

#[test]
fn a_non_budget_timeout_mention_is_treated_as_an_ordinary_failure() {
    // Seeded as already-blocked with a live streak (e.g. from a prior persistent hang or an
    // auth-shaped error) — agy answering (even with wording that mentions a timeout) proves the
    // sign-in question is settled, so this must fall through to the ordinary-failure branch and
    // clear both, exactly like any other non-timeout, non-auth-shaped failure.
    let mut snap = snapshot_from_agy(&data(), 1_000);
    snap["authBlocked"] = json!(true);
    snap["timeoutStreak"] = json!(2);
    record_failure(&mut snap, "agy exited non-zero: request timed out", 1_045);
    assert_eq!(snap["authBlocked"], false);
    assert_eq!(snap["timeoutStreak"], 0);
}

#[test]
fn a_transient_timeout_does_not_block_the_next_refresh() {
    // The exact live incident: one 45s agy timeout with no prior streak.
    let snap = setup_timeout_streak_snap(1);
    assert_ne!(
        snap["authBlocked"], true,
        "a sub-threshold timeout must not arm the block"
    );
    assert_eq!(snap["timeoutStreak"], 1);
    assert_eq!(snap["lastError"], "timed out after 45s");
    // A subsequent non-forced refresh with a profile present is NOT blocked.
    assert!(refresh_blocked_reason(Some(&snap), true, false).is_none());
}

#[test]
fn a_sub_threshold_timeout_does_not_clear_an_existing_auth_block() {
    // A timeout is not proof auth is resolved — only a success or a non-timeout failure clears an
    // existing block. Seeded pre-armed (as if by a prior auth-shaped error or persistent streak).
    let mut snap = snapshot_from_agy(&data(), 1_000);
    snap["authBlocked"] = json!(true);
    record_failure(&mut snap, "timed out after 45s", 1_045);
    assert_eq!(
        snap["authBlocked"], true,
        "a sub-threshold timeout must not clear the block"
    );
    assert_eq!(snap["timeoutStreak"], 1);
}

#[test]
fn three_consecutive_timeouts_escalate_to_a_sticky_block() {
    let mut snap = setup_timeout_streak_snap(TIMEOUT_STREAK_STICKY - 1);
    assert!(
        refresh_blocked_reason(Some(&snap), true, false).is_none(),
        "still below the streak threshold"
    );
    record_failure(
        &mut snap,
        "timed out after 45s",
        1_000 + TIMEOUT_STREAK_STICKY * 45,
    );
    assert_eq!(snap["authBlocked"], true);
    assert_eq!(snap["timeoutStreak"], TIMEOUT_STREAK_STICKY);
    let (code, _) = refresh_blocked_reason(Some(&snap), true, false)
        .expect("a persistent hang must block automatic refresh");
    assert_eq!(code, CODE_AUTH_BLOCKED);
}

#[test]
fn a_timeout_gap_longer_than_the_window_restarts_the_streak() {
    // gemini.json persists across app restarts, so two timeouts separated by a real idle gap
    // (not just normal back-to-back retries) must not compound into the same streak.
    let mut snap = setup_timeout_streak_snap(TIMEOUT_STREAK_STICKY - 1);
    assert_eq!(snap["timeoutStreak"], TIMEOUT_STREAK_STICKY - 1);
    let last_attempt = snap["lastAttemptAt"].as_i64().unwrap();
    record_failure(
        &mut snap,
        "timed out after 45s",
        last_attempt + TIMEOUT_STREAK_WINDOW_SECS + 1,
    );
    assert_eq!(
        snap["timeoutStreak"], 1,
        "a gap past the window restarts the streak instead of incrementing it"
    );
    assert_ne!(snap["authBlocked"], true);
}

#[test]
fn an_auth_shaped_error_blocks_immediately_and_resets_any_timeout_streak() {
    // A prior transient timeout must not delay an auth-shaped block once one actually arrives.
    let mut snap = setup_timeout_streak_snap(1);
    assert_eq!(snap["timeoutStreak"], 1);
    record_failure(
        &mut snap,
        "agy exited non-zero: please sign in to continue",
        1_090,
    );
    assert_eq!(snap["authBlocked"], true);
    assert_eq!(snap["timeoutStreak"], 0);
}

#[test]
fn a_success_after_a_timeout_streak_resets_it() {
    let snap = setup_timeout_streak_snap(2);
    assert_eq!(snap["timeoutStreak"], 2);
    // A success builds a wholly fresh snapshot (see snapshot_from_agy) — it never reads the old
    // one, so authBlocked/timeoutStreak cannot carry forward regardless of the prior streak.
    let fresh = snapshot_from_agy(&data(), 1_200);
    assert!(fresh.get("authBlocked").is_none());
    assert!(fresh.get("timeoutStreak").is_none());
    assert!(refresh_blocked_reason(Some(&fresh), true, false).is_none());
}

#[test]
fn a_non_timeout_failure_clears_the_streak_too() {
    // agy responded (just not usefully) — this is not a hang, so it must not count toward the
    // timeout streak, and it clears the block exactly as an ordinary failure always has.
    let mut snap = setup_timeout_streak_snap(1);
    assert_eq!(snap["timeoutStreak"], 1);
    record_failure(&mut snap, "agy JSON parse failed: expected value", 1_090);
    assert_eq!(snap["authBlocked"], false);
    assert_eq!(snap["timeoutStreak"], 0);
}

#[test]
fn a_legacy_timeout_only_block_self_heals_instead_of_staying_stuck_forever() {
    // The exact reported bug: a snapshot written by the OLD code (before timeoutStreak existed)
    // set authBlocked=true on a single timeout and never cleared it. refresh_blocked_reason gates
    // the only path back to a refresh, so without migration record_failure would never run again
    // to correct it — the gauge would stay dark forever. timeoutStreak absent (as here) or 0
    // alongside a timeout-shaped lastError is only ever this legacy shape (current code's minimum
    // write for a timeout is streak=1), so it's safe to treat as unblocked and let it self-heal.
    let legacy: Value = json!({
        "authBlocked": true,
        "lastError": "timed out after 45s",
        "lastAttemptAt": 500,
    });
    assert!(
        refresh_blocked_reason(Some(&legacy), true, false).is_none(),
        "a pre-HED-188 timeout-only block must not stay stuck forever"
    );
    // A profile check and a genuine (non-legacy) block are unaffected by the migration.
    assert!(refresh_blocked_reason(Some(&legacy), false, false).is_some());
    let genuine: Value = json!({
        "authBlocked": true,
        "lastError": "timed out after 45s",
        "timeoutStreak": TIMEOUT_STREAK_STICKY,
    });
    assert!(refresh_blocked_reason(Some(&genuine), true, false).is_some());
}
