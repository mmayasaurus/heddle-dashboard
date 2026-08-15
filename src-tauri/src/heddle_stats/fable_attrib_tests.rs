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
