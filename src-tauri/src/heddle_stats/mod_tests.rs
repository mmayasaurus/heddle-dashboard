//! Unit tests for `mod.rs` (contract shape, tap reader, ordering, golden file).

use super::*;

fn cursor_limit_for_merge_test() -> ProviderLimit {
    ProviderLimit {
        provider: "cursor".to_string(),
        model: Some("Cursor Pro".to_string()),
        captured_at: Some(123),
        five_hour: LimitWindow::default(),
        seven_day: LimitWindow::default(),
        source: Some("cursor-usage-summary".to_string()),
        stale: Some(false),
        stale_after_secs: Some(900),
        note: None,
        note_codes: None,
        accounts: None,
        active_account: None,
        windows: None,
        fable_weekly_estimate_pct: None,
        fable_weekly_samples: None,
    }
}

fn claude_registry_for_merge_tests() -> Vec<claude::Account> {
    claude::parse_registry(&serde_json::json!({
        "claude": [
            {"id": "default", "configDir": null, "email": "default@example.com", "loggedIn": true},
            {"id": "acct2", "configDir": "/tmp/heddle-merge-acct2", "email": "two@example.com", "loggedIn": true}
        ]
    }))
}

fn claude_tap_for_merge_test(account: &str, five_hour: f64, captured_at: i64) -> String {
    serde_json::json!({
        "model": "claude-test",
        "rate_limits": {
            "five_hour": {"used_percentage": five_hour, "resets_at": 3_000},
            "seven_day": {"used_percentage": five_hour / 2.0, "resets_at": 4_000}
        },
        "capturedAt": captured_at,
        "account": account
    })
    .to_string()
}

/// Shared setup for the HED-348 merge/rebuild tests: a temp usage dir seeded with `claude-<id>.json`
/// tap captures, one per `(id, five_hour_pct, captured_at)` entry.
fn dir_with_claude_taps(entries: &[(&str, f64, i64)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (id, five_hour, captured_at) in entries {
        std::fs::write(
            dir.path().join(format!("claude-{id}.json")),
            claude_tap_for_merge_test(id, *five_hour, *captured_at),
        )
        .unwrap();
    }
    dir
}

#[test]
fn regression_pr_348_merging_fresh_claude_rebuild_replaces_mirrors_frozen_freshness() {
    let now = 2_000;
    let dir = dir_with_claude_taps(&[("default", 11.0, now - 700), ("acct2", 77.0, now - 30)]);
    let fresh = claude::build_preserving_active(
        dir.path(),
        &claude_registry_for_merge_tests(),
        Some("acct2"),
        now,
    );
    let existing = serde_json::json!({
        "writtenAt": 1_900,
        "limits": [{
            "provider": "claude", "capturedAt": 1_000, "stale": false,
            "fiveHour": {"usedPercentage": 1.0, "resetsAt": 1_100},
            "activeAccount": "acct2"
        }]
    });

    let merged = merge_claude_into_limits(existing, fresh, now);
    let claude = &merged["limits"][0];
    assert_eq!(claude["capturedAt"], now - 30);
    assert_eq!(claude["stale"], false);
    assert_eq!(claude["fiveHour"]["usedPercentage"], 77.0);
    assert_eq!(claude["accounts"][0]["capturedAt"], now - 700);
    assert_eq!(claude["accounts"][0]["stale"], true);
}

#[test]
fn regression_pr_348_rebuild_preserves_a_nondefault_mirror_active_account() {
    let now = 2_000;
    let dir = dir_with_claude_taps(&[("default", 11.0, now - 30), ("acct2", 77.0, now - 30)]);

    let fresh = claude::build_preserving_active(
        dir.path(),
        &claude_registry_for_merge_tests(),
        Some("acct2"),
        now,
    )
    .unwrap();

    assert_eq!(fresh.active_account.as_deref(), Some("acct2"));
    assert_eq!(fresh.five_hour.used_percentage, Some(77.0));
    assert_eq!(fresh.seven_day.used_percentage, Some(38.5));
    assert_eq!(
        fresh.accounts.as_ref().unwrap()[1].five_hour.used_percentage,
        Some(77.0)
    );
    assert_eq!(
        fresh.accounts.as_ref().unwrap()[1].seven_day.used_percentage,
        Some(38.5)
    );
}

#[test]
fn regression_pr_348_rebuild_preserves_the_default_mirror_active_account() {
    let now = 2_000;
    let dir = dir_with_claude_taps(&[("default", 11.0, now - 30)]);

    let fresh = claude::build_preserving_active(
        dir.path(),
        &claude_registry_for_merge_tests(),
        Some("default"),
        now,
    )
    .unwrap();

    assert_eq!(fresh.active_account.as_deref(), Some("default"));
    assert_eq!(fresh.five_hour.used_percentage, Some(11.0));
}

#[test]
fn regression_pr_348_no_fresh_claude_keeps_the_existing_stale_block() {
    let existing = serde_json::json!({
        "writtenAt": 10,
        "limits": [{"provider": "claude", "capturedAt": 1, "stale": true}]
    });

    let merged = merge_claude_into_limits(existing, None, 456);

    assert_eq!(merged["writtenAt"], 456);
    assert_eq!(merged["limits"], serde_json::json!([
        {"provider": "claude", "capturedAt": 1, "stale": true}
    ]));
}

#[test]
fn regression_pr_348_absent_or_unknown_active_id_falls_back_to_a_rebuild_not_none() {
    // The keeper passes the mirror's existing activeAccount, which is absent on a first-run mirror;
    // a deregistered id is likewise unresolvable. Both must fall back to a full rebuild (the same
    // env/default resolution `limit` uses), never short-circuit to None — otherwise the keeper would
    // write no Claude entry at all and carry a stale block forward on a deregistered account.
    let now = 2_000;
    let dir = dir_with_claude_taps(&[("default", 11.0, now - 30)]);
    let registry = claude_registry_for_merge_tests();

    let absent = claude::build_preserving_active(dir.path(), &registry, None, now);
    assert!(absent.is_some(), "absent active id must rebuild, not return None");
    assert!(
        absent.unwrap().accounts.is_some(),
        "the fallback must be a real per-account rebuild"
    );

    let unknown = claude::build_preserving_active(dir.path(), &registry, Some("ghost"), now);
    assert!(
        unknown.is_some(),
        "unknown active id must rebuild, not return None"
    );
}

#[test]
fn regression_pr_348_capture_less_rebuild_keeps_the_existing_claude_block() {
    // `claude::build` returns Some(empty) when the registry exists but no captures do; that must
    // NOT overwrite a still-useful stale-marked entry with blanks (qodo/codeant).
    let now = 2_000;
    let dir = dir_with_claude_taps(&[]); // registered accounts, but no tap captures on disk
    let empty = claude::build_preserving_active(
        dir.path(),
        &claude_registry_for_merge_tests(),
        Some("acct2"),
        now,
    );
    assert!(
        empty.is_some(),
        "build returns Some(empty) for a registry with no captures"
    );
    assert!(
        empty.as_ref().unwrap().captured_at.is_none(),
        "the empty rebuild carries no capture timestamp"
    );

    let existing = serde_json::json!({
        "writtenAt": 1_000,
        "limits": [{
            "provider": "claude", "capturedAt": 1_500, "stale": false,
            "fiveHour": {"usedPercentage": 42.0, "resetsAt": 9_999}
        }]
    });
    let merged = merge_claude_into_limits(existing, empty, now);
    // the useful existing block survives; the empty rebuild does not replace it with blanks
    assert_eq!(merged["limits"][0]["capturedAt"], 1_500);
    assert_eq!(merged["limits"][0]["fiveHour"]["usedPercentage"], 42.0);
    assert_eq!(merged["writtenAt"], now);
}

#[test]
fn merge_cursor_into_limits_replaces_an_existing_cursor_entry() {
    let existing = serde_json::json!({
        "writtenAt": 10,
        "limits": [
            {"provider": "claude", "model": "Claude"},
            {"provider": "cursor", "model": "old Cursor"}
        ]
    });

    let merged = merge_cursor_into_limits(existing, Some(cursor_limit_for_merge_test()), 456);

    assert_eq!(merged["writtenAt"], 456);
    assert_eq!(merged["limits"].as_array().unwrap().len(), 2);
    assert_eq!(merged["limits"][0]["provider"], "claude");
    assert_eq!(merged["limits"][1]["provider"], "cursor");
    assert_eq!(merged["limits"][1]["model"], "Cursor Pro");
}

#[test]
fn merge_cursor_into_limits_removes_cursor_when_no_fresh_limit_exists() {
    let existing = serde_json::json!({
        "writtenAt": 10,
        "limits": [
            {"provider": "cursor", "model": "old Cursor"},
            {"provider": "codex", "model": "Codex"}
        ]
    });

    let merged = merge_cursor_into_limits(existing, None, 456);

    assert_eq!(merged["writtenAt"], 456);
    assert_eq!(merged["limits"], serde_json::json!([{"provider": "codex", "model": "Codex"}]));
}

#[test]
fn headless_limits_merges_a_fresh_codex_cache_without_touching_other_providers() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("claudex-cache.json");
    std::fs::write(
        &cache,
        include_str!("../../tests/fixtures/heddle_stats/claudex-usage-cache.lb.json"),
    )
    .unwrap();
    let existing = serde_json::json!({"writtenAt": 1, "limits": [
        {"provider": "cursor", "marker": "cursor"},
        {"provider": "claude", "marker": "claude"},
        {"provider": "codex", "marker": "old-codex"},
        {"provider": "gemini", "marker": "gemini"}
    ]});

    let merged = refresh_headless_limits_with_paths(
        existing,
        Some(cursor_limit_for_merge_test()),
        None,
        &cache,
        &dir.path().join("missing-helper"),
        &dir.path().join("gemini.json"),
        false,
        "missing-agy",
        dir.path(),
        1_786_822_400,
    );

    let limits = merged.expect("fresh cache must merge")["limits"]
        .as_array()
        .unwrap()
        .clone();
    let codex = limits.iter().find(|l| l["provider"] == "codex").unwrap();
    assert_eq!(codex["capturedAt"], 1_786_822_350);
    assert!(codex["accounts"].as_array().is_some_and(|a| !a.is_empty()));
    assert_eq!(
        limits.iter().find(|l| l["provider"] == "cursor").unwrap()["model"],
        "Cursor Pro"
    );
    assert_eq!(
        limits.iter().find(|l| l["provider"] == "claude").unwrap()["marker"],
        "claude"
    );
    assert_eq!(
        limits.iter().find(|l| l["provider"] == "gemini").unwrap()["marker"],
        "gemini"
    );
}

#[cfg(unix)]
#[test]
fn headless_limits_runs_a_due_codex_helper_and_merges_its_fresh_cache() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("claudex-cache.json");
    let stale = include_str!("../../tests/fixtures/heddle_stats/claudex-usage-cache.lb.json")
        .replace("1786822350.4144561", "1");
    std::fs::write(&cache, stale).unwrap();
    let fresh = include_str!("../../tests/fixtures/heddle_stats/claudex-usage-cache.lb.json")
        .replace('"', "\\\"");
    let helper = dir.path().join("claudex-usage");
    std::fs::write(
        &helper,
        format!(
            "#!/bin/sh\nprintf '%s' \"{fresh}\" > '{}'\n",
            cache.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();

    let merged = refresh_headless_limits_with_paths(
        serde_json::json!({"limits": [{"provider": "codex", "marker": "old"}]}),
        None,
        None,
        &cache,
        &helper,
        &dir.path().join("gemini.json"),
        false,
        "missing-agy",
        dir.path(),
        1_786_824_000,
    )
    .expect("helper refresh must merge in this pass");

    assert_eq!(merged["limits"][0]["provider"], "codex");
    assert_eq!(merged["limits"][0]["capturedAt"], 1_786_822_350);
}

#[test]
fn headless_limits_keeps_existing_codex_when_cache_or_helper_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let existing = serde_json::json!({"limits": [
        {"provider": "codex", "capturedAt": 7, "marker": "keep"}
    ]});
    for (cache, helper) in [
        (dir.path().join("missing-cache"), dir.path().join("missing-helper")),
        (dir.path().join("stale-cache"), dir.path().join("missing-helper")),
    ] {
        if cache.file_name().is_some_and(|n| n == "stale-cache") {
            std::fs::write(&cache, r#"{"fetched_at":1,"mode":"lb","payload":[]}"#).unwrap();
        }
        let merged = refresh_headless_limits_with_paths(
            existing.clone(),
            Some(cursor_limit_for_merge_test()),
            None,
            &cache,
            &helper,
            &dir.path().join("missing-gemini"),
            false,
            "missing-agy",
            dir.path(),
            1_000,
        )
        .expect("best-effort provider failures must not fail the cursor result");
        let codex = merged["limits"].as_array().unwrap().iter().find(|l| l["provider"] == "codex").unwrap();
        assert_eq!(codex, &serde_json::json!({"provider": "codex", "capturedAt": 7, "marker": "keep"}));
    }
}

#[cfg(unix)]
#[test]
fn headless_codex_timeout_returns_promptly_and_keeps_the_mirror_candidate_absent() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache.json");
    std::fs::write(&cache, r#"{"fetched_at":1,"mode":"lb","payload":[]}"#).unwrap();
    let helper = dir.path().join("slow-helper");
    std::fs::write(&helper, "#!/bin/sh\nexec sleep 2\n").unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let started = Instant::now();
    let result = codex::refresh_and_limit_with_paths_and_timeout(
        &cache, &helper, 1_000, Duration::from_millis(150),
    );
    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_secs(1), "timeout must kill the child promptly");
}

#[test]
fn headless_limits_merges_a_not_due_gemini_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let snapshot = dir.path().join("gemini.json");
    let agy: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/heddle_stats/agy-quota.json")).unwrap();
    let now = 1_786_824_000;
    write_json_atomic(&snapshot, &gemini::snapshot_from_agy(&agy["command"]["data"], now - 1)).unwrap();
    let merged = refresh_headless_limits_with_paths(
        serde_json::json!({"limits":[{"provider":"gemini","marker":"old"}]}),
        None, None, &dir.path().join("missing-codex"), &dir.path().join("missing-helper"),
        &snapshot, true, "missing-agy", dir.path(), now,
    ).unwrap();
    assert_eq!(merged["limits"][0]["provider"], "gemini");
    assert_eq!(merged["limits"][0]["capturedAt"], now - 1);
}

#[cfg(unix)]
#[test]
fn headless_limits_does_not_spawn_blocked_gemini_and_retains_existing_entry() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("agy-ran");
    let agy = dir.path().join("agy");
    std::fs::write(&agy, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    std::fs::set_permissions(&agy, std::fs::Permissions::from_mode(0o755)).unwrap();
    let merged = refresh_headless_limits_with_paths(
        serde_json::json!({"limits":[{"provider":"gemini","capturedAt":7,"marker":"keep"}]}),
        None, None, &dir.path().join("missing-codex"), &dir.path().join("missing-helper"),
        &dir.path().join("missing-gemini"), false, &agy.to_string_lossy(), dir.path(), 1_000,
    ).unwrap();
    assert!(!marker.exists(), "blocked refresh must not execute agy");
    assert_eq!(merged["limits"][0], serde_json::json!({"provider":"gemini","capturedAt":7,"marker":"keep"}));
}

#[cfg(unix)]
#[test]
fn headless_limits_runs_due_gemini_and_merges_its_new_snapshot() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let fixture = include_str!("../../tests/fixtures/heddle_stats/agy-quota.json").replace('"', "\\\"");
    let agy = dir.path().join("agy");
    std::fs::write(&agy, format!("#!/bin/sh\nprintf '%s' \"{fixture}\"\n")).unwrap();
    std::fs::set_permissions(&agy, std::fs::Permissions::from_mode(0o755)).unwrap();
    let snapshot = dir.path().join("gemini.json");
    let now = 1_786_824_000;
    let merged = refresh_headless_limits_with_paths(
        serde_json::json!({"limits":[{"provider":"gemini","marker":"old"}]}),
        None, None, &dir.path().join("missing-codex"), &dir.path().join("missing-helper"),
        &snapshot, true, &agy.to_string_lossy(), dir.path(), now,
    ).unwrap();
    assert_eq!(merged["limits"][0]["provider"], "gemini");
    assert_eq!(merged["limits"][0]["capturedAt"], now);
}

#[test]
fn headless_limits_keeps_best_effort_provider_blocks_when_both_refreshes_fail() {
    let dir = tempfile::tempdir().unwrap();
    let merged = refresh_headless_limits_with_paths(
        serde_json::json!({"limits":[
            {"provider":"codex","capturedAt":7,"marker":"codex"},
            {"provider":"gemini","capturedAt":8,"marker":"gemini"}
        ]}),
        Some(cursor_limit_for_merge_test()), None,
        &dir.path().join("missing-cache"), &dir.path().join("missing-helper"),
        &dir.path().join("missing-gemini"), true, "missing-agy", dir.path(), 1_000,
    ).unwrap();
    let limits = merged["limits"].as_array().unwrap();
    assert!(limits.iter().any(|l| l["provider"] == "cursor"));
    assert!(limits.iter().any(|l| l["marker"] == "codex"));
    assert!(limits.iter().any(|l| l["marker"] == "gemini"));
}

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
fn provider_limits_combine_tap_and_codex_in_claude_codex_rest_order() {
    let dir = tempfile::tempdir().unwrap();
    let tap = |model: &str| {
        serde_json::json!({
            "model": model,
            "rate_limits": {"five_hour": {"used_percentage": 12, "resets_at": 2_000}},
            "capturedAt": 1_000
        })
        .to_string()
    };
    std::fs::write(dir.path().join("claude.json"), tap("claude-model")).unwrap();
    std::fs::write(dir.path().join("zeta.json"), tap("zeta-model")).unwrap();
    std::fs::write(dir.path().join("alpha.json"), tap("alpha-model")).unwrap();
    std::fs::write(dir.path().join("malformed.json"), "not json").unwrap();
    std::fs::write(dir.path().join("limits.json"), tap("assembled-mirror")).unwrap();

    let cache = dir.path().join("claudex-cache.json");
    std::fs::write(
        &cache,
        include_str!("../../tests/fixtures/heddle_stats/claudex-usage-cache.lb.json"),
    )
    .unwrap();
    let limits = provider_limits_sync_with_paths(None, dir.path(), Some(&cache), 1_001).unwrap();

    let providers: Vec<&str> = limits.iter().map(|limit| limit.provider.as_str()).collect();
    assert_eq!(providers, ["claude", "codex", "alpha", "zeta"]);
    assert_eq!(limits[0].model.as_deref(), Some("claude-model"));
    assert_eq!(limits[0].five_hour.used_percentage, Some(12.0));
    assert_eq!(limits[0].five_hour.resets_at, Some(2_000));
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
        fable_weekly_estimate_pct: None,
        fable_weekly_samples: None,
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
        "fableWeeklyEstimatePct",
        "fableWeeklySamples",
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
    let claude_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("heddle-stats-golden");
    std::fs::create_dir_all(&claude_dir).unwrap();
    std::fs::write(claude_dir.join("claude-acct1.json"), claude_tap.to_string()).unwrap();
    std::fs::write(
        claude_dir.join("claude-acct3.keeper.json"),
        serde_json::json!({"account": "acct3", "startedAt": now - 30, "resets_at": now + 5 * 3600, "used": null}).to_string(),
    ).unwrap();
    std::fs::write(
        claude_dir.join("claude-acct4.keeper.json"),
        serde_json::json!({"account": "acct4", "startedAt": now - 20, "resets_at": now + 5 * 3600, "used": null}).to_string(),
    ).unwrap();
    let claude_registry = claude::parse_registry(&serde_json::json!({"claude": [
        {"id": "acct1", "configDir": null, "email": "one@example.com", "loggedIn": true},
        {"id": "acct2", "configDir": "/tmp/acct2", "email": "two@example.org", "loggedIn": true},
        {"id": "acct3", "configDir": "/tmp/acct3", "email": "three@example.net", "loggedIn": false},
        {"id": "acct4", "configDir": "/tmp/acct4", "email": "four@example.net", "loggedIn": true},
    ]}));
    let claude = claude::build(&claude_dir, &claude_registry, None, now).unwrap();
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
        fable_weekly_estimate_pct: None,
        fable_weekly_samples: None,
    };
    let mut v = vec![mk("gemini"), mk("codex"), mk("cursor"), mk("claude")];
    sort_limits(&mut v);
    let order: Vec<&str> = v.iter().map(|l| l.provider.as_str()).collect();
    assert_eq!(order, ["claude", "codex", "cursor", "gemini"]);
}
