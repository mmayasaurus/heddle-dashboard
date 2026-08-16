//! Unit tests for `mod.rs` (contract shape, tap reader, ordering, golden file).

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
        note_codes: None,
        accounts: None,
        windows: None,
    };
    let mut v = vec![mk("gemini"), mk("codex"), mk("cursor"), mk("claude")];
    sort_limits(&mut v);
    let order: Vec<&str> = v.iter().map(|l| l.provider.as_str()).collect();
    assert_eq!(order, ["claude", "codex", "cursor", "gemini"]);
}
