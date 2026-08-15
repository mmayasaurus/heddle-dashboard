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
        active_account: None,
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
        "activeAccount",
        "windows",
    ] {
        assert!(j[k].is_null(), "additive key {k} must be null when absent");
    }
}

/// The exact JSON `heddle_provider_limits` serves (and mirrors to `~/.heddle/usage/limits.json`),
/// built from the fixtures — one entry per provider — and pinned to
/// `tests/fixtures/heddle_stats/limits.golden.json`. Out-of-process consumers (heddle-core's
/// router) build their fixture tests from that file, so a contract change shows up here first.
/// Regenerate deliberately with `cargo test --lib heddle_stats::tests::write_golden -- --ignored`.
fn golden_limits() -> serde_json::Value {
    let now = 1_786_831_200;
    let claude_tap: serde_json::Value = serde_json::json!({
        "model": "claude-fable-5",
        "rate_limits": {"five_hour": {"used_percentage": 32, "resets_at": 1786846200},
                         "seven_day": {"used_percentage": 24, "resets_at": 1786892400}},
        "capturedAt": now - 60, "account": "acct1", "configDir": null
    });
    let claude = tap_limit("claude", &claude_tap, now).unwrap();
    let codex_cache: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/heddle_stats/claudex-usage-cache.lb.json"
    ))
    .unwrap();
    let mut codex = codex::parse_cache(&codex_cache, now).unwrap();
    // The fixture's fetched_at is older than the staleness threshold at `now`; pin it fresh so
    // the golden shows the common case.
    codex.captured_at = Some(now - 30);
    codex.stale = Some(false);
    for a in codex.accounts.iter_mut().flatten() {
        a.captured_at = Some(now - 30);
        a.stale = Some(false);
    }
    let agy: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/heddle_stats/agy-quota.json"
    ))
    .unwrap();
    let gemini_snap = gemini::snapshot_from_agy(&agy["command"]["data"], now - 90);
    let gemini = gemini::parse_snapshot(&gemini_snap, now).unwrap();
    let summary: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/heddle_stats/cursor-usage-summary.json"
    ))
    .unwrap();
    let cursor_snap = serde_json::json!({
        "model": "cursor.com · 1 acct", "rate_limits": {}, "capturedAt": now - 45,
        "source": cursor::SOURCE, "lastAttemptAt": now - 45,
        "accounts": [{"label": "v…@example.com", "source": cursor::SOURCE_IDE,
                      "tokenExpiresAt": now + 30 * 86_400, "membershipHint": "ultra",
                      "fetchedAt": now - 45, "summary": summary, "error": null}]
    });
    let cursor = cursor::parse_snapshot(&cursor_snap, now).unwrap();
    let mut all = vec![gemini, cursor, codex, claude];
    sort_limits(&mut all);
    serde_json::json!({ "writtenAt": now, "limits": all })
}

const GOLDEN_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/heddle_stats/limits.golden.json"
);

#[test]
fn contract_json_matches_the_golden_file() {
    let want: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(GOLDEN_PATH).unwrap()).unwrap();
    let got = golden_limits();
    assert_eq!(
        got,
        want,
        "heddle_provider_limits contract drifted from tests/fixtures/heddle_stats/limits.golden.json — \
         if the change is intended (additive!), regenerate with \
         `cargo test --lib heddle_stats::tests::write_golden -- --ignored` and tell the consumers"
    );
}

/// Regenerates the golden file. Ignored so it never runs by accident.
#[test]
#[ignore]
fn write_golden() {
    std::fs::write(
        GOLDEN_PATH,
        serde_json::to_string_pretty(&golden_limits()).unwrap() + "\n",
    )
    .unwrap();
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
        active_account: None,
        windows: None,
    };
    let mut v = vec![mk("gemini"), mk("codex"), mk("cursor"), mk("claude")];
    sort_limits(&mut v);
    let order: Vec<&str> = v.iter().map(|l| l.provider.as_str()).collect();
    assert_eq!(order, ["claude", "codex", "cursor", "gemini"]);
}
