//! Behavioral tests for the Fable weekly attribution: given a capture sequence, the attributed
//! numbers and the show/hide decision are what the doc promises.

use super::*;

fn cap(at: i64, model: &str, used: f64, resets: i64) -> Capture {
    Capture {
        captured_at: at,
        model: model.to_string(),
        seven_day_used: Some(used),
        seven_day_resets_at: Some(resets),
        exact_fable_pct: None,
    }
}

const RESET: i64 = 1_786_892_400;

#[test]
fn deltas_are_attributed_to_the_rendering_model_and_the_estimate_needs_three_samples() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    // First capture: 10% already used before we watched → unknown, no samples, no estimate.
    assert!(ingest(&mut s, &cap(t0, "claude-fable-5", 10.0, RESET), t0));
    assert_eq!(
        (s.unknown_pct, s.fable_pct, s.other_pct, s.samples),
        (10.0, 0.0, 0.0, 0)
    );
    assert_eq!(estimate(&s), None);
    // +2 under Fable, +1 under Haiku, +2 under Fable → fable 4, other 1, samples 3 → estimate 4%.
    assert!(ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 12.0, RESET),
        t0 + 60
    ));
    assert_eq!(estimate(&s), None, "one sample is not enough");
    assert!(ingest(
        &mut s,
        &cap(t0 + 120, "claude-haiku-4-5", 13.0, RESET),
        t0 + 120
    ));
    assert_eq!(estimate(&s), None, "two samples are not enough");
    assert!(ingest(
        &mut s,
        &cap(t0 + 180, "claude-fable-5", 15.0, RESET),
        t0 + 180
    ));
    assert_eq!(s.fable_pct, 4.0);
    assert_eq!(s.other_pct, 1.0);
    assert_eq!(s.unknown_pct, 10.0);
    assert_eq!(s.samples, 3);
    assert_eq!(estimate(&s), Some(4.0));
    // The same capture again changes nothing (idempotent per capture).
    assert!(!ingest(
        &mut s,
        &cap(t0 + 180, "claude-fable-5", 15.0, RESET),
        t0 + 200
    ));
    assert_eq!(s.samples, 3);
    // No change in used% → nothing attributed, still a "sample-less" capture.
    assert!(ingest(
        &mut s,
        &cap(t0 + 240, "claude-opus-4-6", 15.0, RESET),
        t0 + 240
    ));
    assert_eq!(s.samples, 3);
    assert_eq!(s.other_pct, 1.0);
}

#[test]
fn a_long_gap_sends_the_delta_to_unknown_instead_of_the_next_renderer() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    ingest(&mut s, &cap(t0, "claude-fable-5", 10.0, RESET), t0);
    ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 11.0, RESET),
        t0 + 60,
    );
    // The app was closed for an hour; +5% happened unobserved.
    ingest(
        &mut s,
        &cap(t0 + 60 + 3600, "claude-fable-5", 16.0, RESET),
        t0 + 60 + 3600,
    );
    assert_eq!(s.fable_pct, 1.0);
    assert_eq!(s.unknown_pct, 15.0);
    assert_eq!(s.samples, 1);
    // A gap of exactly MAX_GAP_SECS still counts (boundary is "longer than").
    ingest(
        &mut s,
        &cap(t0 + 60 + 3600 + MAX_GAP_SECS, "claude-fable-5", 17.0, RESET),
        0,
    );
    assert_eq!(s.fable_pct, 2.0);
    assert_eq!(s.samples, 2);
}

#[test]
fn a_new_weekly_window_starts_the_books_over() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    ingest(&mut s, &cap(t0, "claude-fable-5", 40.0, RESET), t0);
    ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 45.0, RESET),
        t0 + 60,
    );
    ingest(
        &mut s,
        &cap(t0 + 120, "claude-fable-5", 50.0, RESET),
        t0 + 120,
    );
    ingest(
        &mut s,
        &cap(t0 + 180, "claude-fable-5", 55.0, RESET),
        t0 + 180,
    );
    assert_eq!(estimate(&s), Some(15.0));
    // Reset: resets_at moves a week out and used% drops to 3% under a Fable session.
    ingest(
        &mut s,
        &cap(t0 + 240, "claude-fable-5", 3.0, RESET + 7 * 86_400),
        t0 + 240,
    );
    assert_eq!(s.window_resets_at, Some(RESET + 7 * 86_400));
    assert_eq!(
        (s.fable_pct, s.other_pct, s.unknown_pct, s.samples),
        (0.0, 0.0, 3.0, 0)
    );
    assert_eq!(estimate(&s), None, "a fresh window has no confidence yet");
}

#[test]
fn a_downward_correction_inside_a_window_shrinks_the_buckets_proportionally() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    ingest(&mut s, &cap(t0, "claude-fable-5", 0.0, RESET), t0);
    ingest(&mut s, &cap(t0 + 60, "claude-fable-5", 6.0, RESET), t0 + 60);
    ingest(
        &mut s,
        &cap(t0 + 120, "claude-haiku-4-5", 8.0, RESET),
        t0 + 120,
    );
    ingest(
        &mut s,
        &cap(t0 + 180, "claude-fable-5", 10.0, RESET),
        t0 + 180,
    );
    assert_eq!((s.fable_pct, s.other_pct), (8.0, 2.0));
    // Provider now says 5% (same window): buckets scale to sum 5 → fable 4, other 1.
    ingest(
        &mut s,
        &cap(t0 + 240, "claude-fable-5", 5.0, RESET),
        t0 + 240,
    );
    assert!((s.fable_pct - 4.0).abs() < 1e-9 && (s.other_pct - 1.0).abs() < 1e-9);
    assert_eq!(s.samples, 3);
}

#[test]
fn an_exact_model_scoped_window_wins_regardless_of_samples() {
    let v: Value = serde_json::json!({
        "model": "claude-fable-5",
        "rate_limits": {
            "five_hour": {"used_percentage": 20, "resets_at": 1},
            "seven_day": {"used_percentage": 40, "resets_at": RESET},
            "seven_day_fable": {"used_percentage": 33.5, "resets_at": RESET}
        },
        "capturedAt": 1_786_830_000
    });
    let c = capture_from_tap(&v).unwrap();
    assert_eq!(c.exact_fable_pct, Some(33.5));
    let mut s = Attrib::default();
    assert!(ingest(&mut s, &c, 1));
    assert!(s.exact);
    assert_eq!(estimate(&s), Some(33.5));
    assert_eq!(s.samples, 0);
    // The plain payload (no model window) → no exact value.
    let plain: Value = serde_json::json!({"model": "claude-fable-5", "rate_limits": {"seven_day": {"used_percentage": 1, "resets_at": RESET}}, "capturedAt": 5});
    assert_eq!(capture_from_tap(&plain).unwrap().exact_fable_pct, None);
}

#[test]
fn model_classification_and_capture_parsing() {
    assert!(is_fable_model("claude-fable-5"));
    assert!(is_fable_model("Fable"));
    assert!(!is_fable_model("claude-opus-4-6"));
    assert!(!is_fable_model("claude-haiku-4-5"));
    assert!(!is_fable_model(""));
    let v: Value = serde_json::json!({"model": "claude-haiku-4-5", "rate_limits": {"five_hour": {"used_percentage": 1, "resets_at": 2}, "seven_day": {"used_percentage": 2.5, "resets_at": RESET}}, "capturedAt": 77});
    let c = capture_from_tap(&v).unwrap();
    assert_eq!(
        (c.captured_at, c.seven_day_used, c.seven_day_resets_at),
        (77, Some(2.5), Some(RESET))
    );
    assert_eq!(c.model, "claude-haiku-4-5");
    assert!(
        capture_from_tap(&serde_json::json!({"model": "x"})).is_none(),
        "no capturedAt → no capture"
    );
}

#[test]
fn state_round_trips_through_json_with_defaults_for_missing_fields() {
    let s = Attrib {
        fable_pct: 1.5,
        samples: 2,
        ..Default::default()
    };
    let j = serde_json::to_string(&s).unwrap();
    let back: Attrib = serde_json::from_str(&j).unwrap();
    assert_eq!(back, s);
    let partial: Attrib = serde_json::from_str(r#"{"fablePct": 3.0}"#).unwrap();
    assert_eq!(partial.fable_pct, 3.0);
    assert_eq!(partial.samples, 0);
}

#[test]
fn a_capture_without_a_weekly_reading_is_a_no_op() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    ingest(&mut s, &cap(t0, "claude-fable-5", 10.0, RESET), t0);
    ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 12.0, RESET),
        t0 + 60,
    );
    let before = s.clone();
    let malformed = Capture {
        captured_at: t0 + 120,
        model: "claude-fable-5".to_string(),
        seven_day_used: None,
        seven_day_resets_at: Some(RESET),
        exact_fable_pct: None,
    };
    assert!(!ingest(&mut s, &malformed, t0 + 120));
    assert_eq!(s, before, "state and confidence must be untouched");
    assert_eq!(estimate(&s), estimate(&before));
}

#[test]
fn captures_older_than_the_baseline_are_dropped() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    ingest(&mut s, &cap(t0, "claude-fable-5", 10.0, RESET), t0);
    ingest(
        &mut s,
        &cap(t0 + 120, "claude-fable-5", 12.0, RESET),
        t0 + 120,
    );
    let before = s.clone();
    // A stale snapshot from an out-of-order writer: higher reading, older timestamp.
    assert!(!ingest(
        &mut s,
        &cap(t0 + 60, "claude-haiku-4-5", 15.0, RESET),
        t0 + 130
    ));
    assert_eq!(s, before, "the baseline must never rewind");
    // The next current capture still attributes against the newest baseline.
    ingest(
        &mut s,
        &cap(t0 + 180, "claude-fable-5", 13.0, RESET),
        t0 + 180,
    );
    assert_eq!(s.fable_pct, 3.0);
}

#[test]
fn two_distinct_readings_in_the_same_second_both_count() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    ingest(&mut s, &cap(t0, "claude-fable-5", 10.0, RESET), t0);
    ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 11.0, RESET),
        t0 + 60,
    );
    // Same second, same reading → duplicate, dropped.
    assert!(!ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 11.0, RESET),
        t0 + 61
    ));
    assert_eq!(s.samples, 1);
    // Same second, DIFFERENT reading (bursty renders) → attributed, gap 0.
    assert!(ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 11.5, RESET),
        t0 + 62
    ));
    assert_eq!(s.fable_pct, 1.5);
    assert_eq!(s.samples, 2);
}

#[test]
fn entering_exact_mode_drops_the_heuristic_books_and_repeats_are_no_ops() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    ingest(&mut s, &cap(t0, "claude-fable-5", 10.0, RESET), t0);
    ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 12.0, RESET),
        t0 + 60,
    );
    ingest(
        &mut s,
        &cap(t0 + 120, "claude-haiku-4-5", 13.0, RESET),
        t0 + 120,
    );
    assert_eq!(s.samples, 2);
    // The payload grows a weekly Fable window → exact takes over, heuristic books drop.
    let mut exact_cap = cap(t0 + 180, "claude-fable-5", 14.0, RESET);
    exact_cap.exact_fable_pct = Some(6.5);
    assert!(ingest(&mut s, &exact_cap, t0 + 180));
    assert!(s.exact);
    assert_eq!(estimate(&s), Some(6.5));
    assert_eq!(
        (s.other_pct, s.unknown_pct, s.samples),
        (0.0, 0.0, 0),
        "no stale confidence next to an exact value"
    );
    // The identical exact capture again: no state change reported.
    let before = s.clone();
    assert!(!ingest(&mut s, &exact_cap, t0 + 240));
    assert_eq!(s.fable_pct, before.fable_pct);
    assert_eq!(
        s.updated_at, before.updated_at,
        "no silent divergence from the persisted file"
    );
}

#[test]
fn only_a_weekly_fable_window_is_exact_never_a_five_hour_one() {
    let five_only: Value = serde_json::json!({
        "model": "claude-fable-5",
        "rate_limits": {
            "five_hour_fable": {"used_percentage": 90, "resets_at": 1},
            "seven_day": {"used_percentage": 40, "resets_at": RESET}
        },
        "capturedAt": 1_786_830_000
    });
    assert_eq!(capture_from_tap(&five_only).unwrap().exact_fable_pct, None);
    let weekly: Value = serde_json::json!({
        "model": "claude-fable-5",
        "rate_limits": {
            "five_hour_fable": {"used_percentage": 90, "resets_at": 1},
            "fable_weekly": {"used_percentage": 21.0, "resets_at": RESET},
            "seven_day": {"used_percentage": 40, "resets_at": RESET}
        },
        "capturedAt": 1_786_830_000
    });
    assert_eq!(
        capture_from_tap(&weekly).unwrap().exact_fable_pct,
        Some(21.0)
    );
}

#[test]
fn a_temporarily_missing_reset_timestamp_does_not_wipe_the_books() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    ingest(&mut s, &cap(t0, "claude-fable-5", 10.0, RESET), t0);
    ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 12.0, RESET),
        t0 + 60,
    );
    // A capture that omits resets_at (Some → None transition): books survive, delta attributed.
    let mut no_reset = cap(t0 + 120, "claude-fable-5", 13.0, RESET);
    no_reset.seven_day_resets_at = None;
    assert!(ingest(&mut s, &no_reset, t0 + 120));
    assert_eq!(s.fable_pct, 3.0);
    assert_eq!(s.window_resets_at, Some(RESET), "the known window is kept");
    // resets_at returns with the SAME window (None → Some): still no wipe.
    ingest(
        &mut s,
        &cap(t0 + 180, "claude-fable-5", 14.0, RESET),
        t0 + 180,
    );
    assert_eq!(s.fable_pct, 4.0);
    assert_eq!(s.samples, 3);
}

#[test]
fn a_downward_correction_with_empty_books_reports_the_total_as_unknown() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    // First capture at 0% → all buckets zero.
    ingest(&mut s, &cap(t0, "claude-fable-5", 0.0, RESET), t0);
    // Force the pathological shape: baseline says 5% but the books are empty.
    s.last_used_pct = Some(5.0);
    ingest(&mut s, &cap(t0 + 60, "claude-fable-5", 2.0, RESET), t0 + 60);
    assert_eq!(
        (s.fable_pct, s.other_pct, s.unknown_pct),
        (0.0, 0.0, 2.0),
        "the reported total is carried as unknown instead of vanishing"
    );
}

#[test]
fn fable_is_matched_as_a_token_not_a_substring() {
    assert!(is_fable_model("claude-fable-5"));
    assert!(is_fable_model("FABLE"));
    assert!(!is_fable_model("claude-affable-2"));
    assert!(!is_fable_model("fabled-model"));
}

#[test]
fn losing_the_exact_window_seeds_the_books_instead_of_forgetting() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    let mut exact_cap = cap(t0, "claude-fable-5", 14.0, RESET);
    exact_cap.exact_fable_pct = Some(6.5);
    ingest(&mut s, &exact_cap, t0);
    assert_eq!(estimate(&s), Some(6.5));
    // The provider drops the Fable window mid-week (same weekly window).
    assert!(ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 15.0, RESET),
        t0 + 60
    ));
    assert!(!s.exact);
    assert_eq!(s.fable_pct, 6.5, "the last exact share is the seed");
    assert_eq!(
        s.unknown_pct, 8.5,
        "the rest of the reported total is unattributed"
    );
    assert_eq!(s.samples, 0);
    assert_eq!(estimate(&s), None, "hidden until fresh confidence exists");
    // Three fresh Fable deltas later the estimate resumes, well-seeded.
    ingest(
        &mut s,
        &cap(t0 + 120, "claude-fable-5", 16.0, RESET),
        t0 + 120,
    );
    ingest(
        &mut s,
        &cap(t0 + 180, "claude-fable-5", 17.0, RESET),
        t0 + 180,
    );
    ingest(
        &mut s,
        &cap(t0 + 240, "claude-fable-5", 18.0, RESET),
        t0 + 240,
    );
    assert_eq!(estimate(&s), Some(9.5));
}

#[test]
fn losing_the_exact_window_across_a_week_boundary_resets_instead_of_seeding() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    let mut exact_cap = cap(t0, "claude-fable-5", 40.0, RESET);
    exact_cap.exact_fable_pct = Some(35.0);
    ingest(&mut s, &exact_cap, t0);
    // The window rolls AND the exact key disappears in the same capture: last week's 35% must not
    // become this week's seed against a 3% total.
    ingest(
        &mut s,
        &cap(t0 + 60, "claude-fable-5", 3.0, RESET + 7 * 86_400),
        t0 + 60,
    );
    assert!(!s.exact);
    assert_eq!((s.fable_pct, s.unknown_pct, s.samples), (0.0, 3.0, 0));
    assert_eq!(s.window_resets_at, Some(RESET + 7 * 86_400));
}

#[test]
fn a_changed_exact_value_in_the_same_second_is_not_a_duplicate() {
    let mut s = Attrib::default();
    let t0 = 1_786_830_000;
    let mut first = cap(t0, "claude-fable-5", 40.0, RESET);
    first.seven_day_used = None;
    first.exact_fable_pct = Some(30.0);
    ingest(&mut s, &first, t0);
    assert_eq!(estimate(&s), Some(30.0));
    // Same second, still no seven_day reading, but the exact value moved.
    let mut second = first.clone();
    second.exact_fable_pct = Some(31.0);
    assert!(ingest(&mut s, &second, t0 + 1));
    assert_eq!(estimate(&s), Some(31.0));
    // And the truly identical capture is still a no-op.
    assert!(!ingest(&mut s, &second, t0 + 2));
}

// ── HED-136: sample COUNT is not coverage — a soft cap must not read blindness as a quiet zero ──

/// The exact live shape that made the lever inert (acct2, 2026-08-17): three attributed deltas
/// against forty unattributed points. The old `samples >= MIN_SAMPLES` gate returned `Some(0.0)`,
/// which HED-76 reads as "Fable is quiet" when the truth is "we accounted for 7% of this window".
#[test]
fn a_handful_of_samples_over_a_barely_seen_window_reports_unknown_not_zero() {
    let s = Attrib {
        fable_pct: 0.0,
        other_pct: 3.0,
        unknown_pct: 40.0,
        samples: 3,
        ..Attrib::default()
    };
    assert!(
        coverage(&s) < MIN_COVERAGE,
        "3 of 43 points is not coverage"
    );
    assert_eq!(
        estimate(&s),
        None,
        "an unseen window must read as unknown, never as a confident 0%"
    );
}

/// The other half of the same rule: once most of the window IS attributed, the estimate is a real
/// number again. Without this, "always None" would also pass the test above.
#[test]
fn a_well_covered_window_still_reports_its_attributed_share() {
    let s = Attrib {
        fable_pct: 30.0,
        other_pct: 10.0,
        unknown_pct: 5.0,
        samples: 4,
        ..Attrib::default()
    };
    assert!(coverage(&s) >= MIN_COVERAGE);
    assert_eq!(estimate(&s), Some(30.0));
}

/// Coverage gates the HEURISTIC path only. An exact model-scoped window is an authoritative reading
/// from the payload, not something we inferred, so it is never suppressed for lack of samples.
#[test]
fn an_exact_reading_is_never_gated_on_coverage() {
    // An exact ZERO is the sharpest case: it is the one reading that looks identical to the blindness
    // this ticket is about, and it must still be reported — because here we were TOLD it is zero.
    let s = Attrib {
        fable_pct: 0.0,
        other_pct: 0.0,
        unknown_pct: 40.0,
        exact: true,
        samples: 0,
        ..Attrib::default()
    };
    assert!(
        coverage(&s) < MIN_COVERAGE,
        "nothing attributed heuristically"
    );
    assert_eq!(
        estimate(&s),
        Some(0.0),
        "a model-scoped window is authoritative; only the inferred path needs coverage"
    );
}

/// A fresh window has observed nothing; coverage must read 0.0 rather than dividing by zero into a
/// NaN that would compare false against every threshold and silently admit the estimate.
#[test]
fn an_empty_window_has_zero_coverage_not_a_nan() {
    let s = Attrib::default();
    assert_eq!(coverage(&s), 0.0);
    assert_eq!(estimate(&s), None);
}

/// The breakdown must say WHY an estimate is missing, or "no estimate" is indistinguishable from a bug.
#[test]
fn the_detail_breakdown_exposes_coverage_and_its_threshold() {
    let s = Attrib {
        fable_pct: 0.0,
        other_pct: 3.0,
        unknown_pct: 40.0,
        samples: 3,
        ..Attrib::default()
    };
    let d = detail(&s);
    assert!((d["coverage"].as_f64().unwrap() - 3.0 / 43.0).abs() < 1e-9);
    assert_eq!(d["minCoverage"].as_f64(), Some(MIN_COVERAGE));
}
