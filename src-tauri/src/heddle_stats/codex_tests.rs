//! Unit tests for `codex.rs` (kept in a sibling file so the source file stays readable).

use super::*;
use std::sync::{Mutex, OnceLock};
/// Two-account LB cache, shaped exactly like claudex-usage writes it (2026-08 provider state:
/// 7d-only primary window, secondary null, one additional per-model bucket). Fake emails.
const LB_2_ACCOUNTS: &str =
    include_str!("../../tests/fixtures/heddle_stats/claudex-usage-cache.lb.json");
/// Same, but the provider has restored a 5-hour secondary window on one account.
const LB_WITH_5H: &str =
    include_str!("../../tests/fixtures/heddle_stats/claudex-usage-cache.lb-with-5h.json");
/// Legacy single-account raine mode: payload is the wham response itself.
const RAINE: &str =
    include_str!("../../tests/fixtures/heddle_stats/claudex-usage-cache.raine.json");
/// One account's fetch failed (data null), the other is fine.
const LB_ONE_FAILED: &str =
    include_str!("../../tests/fixtures/heddle_stats/claudex-usage-cache.lb-one-failed.json");

fn parse(text: &str, now: i64) -> ProviderLimit {
    let v: Value = serde_json::from_str(text).expect("fixture parses");
    parse_cache(&v, now).expect("cache yields a codex entry")
}

fn lb() -> Value {
    serde_json::from_str(LB_2_ACCOUNTS).unwrap()
}

#[test]
fn binding_view_is_the_max_across_accounts_with_that_accounts_reset() {
    let l = parse(LB_2_ACCOUNTS, 1_786_822_400);
    assert_eq!(l.provider, "codex");
    assert_eq!(l.model.as_deref(), Some("chatgpt · 2 acct"));
    assert_eq!(l.source.as_deref(), Some(SOURCE));
    // acct 1 is at 5% (reset 1787343662), acct 2 at 1% (reset 1787333190) → acct 1 binds.
    assert_eq!(l.seven_day.used_percentage, Some(5.0));
    assert_eq!(l.seven_day.resets_at, Some(1_787_343_662));
    // No 5h window anywhere in the payload → empty slot + the explanatory note (+ its code).
    assert_eq!(l.five_hour, LimitWindow::default());
    assert!(l.note.as_deref().unwrap_or("").contains("no 5h window"));
    assert_eq!(l.note_codes.as_deref(), Some(&[CODE_NO_5H.to_string()][..]));
}

#[test]
fn per_account_rows_are_masked_and_carry_plan_and_own_windows() {
    let l = parse(LB_2_ACCOUNTS, 1_786_822_400);
    let accounts = l.accounts.expect("per-account rows");
    assert_eq!(accounts.len(), 2);
    assert_eq!(accounts[0].label, "a…@example.com");
    assert_eq!(accounts[0].plan.as_deref(), Some("prolite"));
    assert_eq!(accounts[0].seven_day.used_percentage, Some(5.0));
    assert_eq!(accounts[0].limit_reached, Some(false));
    assert!(accounts[0].note.is_none() && accounts[0].note_codes.is_empty());
    assert_eq!(accounts[1].label, "b…@example.org");
    assert_eq!(accounts[1].plan.as_deref(), Some("pro"));
    assert_eq!(accounts[1].seven_day.used_percentage, Some(1.0));
    assert_eq!(accounts[1].seven_day.resets_at, Some(1_787_333_190));
    // The full email must never leak into the payload.
    let json = serde_json::to_string(&accounts).unwrap();
    assert!(!json.contains("alice@") && !json.contains("bob@"), "{json}");
}

#[test]
fn additional_rate_limits_become_named_windows_keyed_by_metered_feature() {
    let l = parse(LB_2_ACCOUNTS, 1_786_822_400);
    let windows = l.windows.expect("named windows");
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].id, "codex_bengalfox-7d");
    assert_eq!(windows[0].label, "GPT-5.3-Codex-Spark 7d");
    // acct 2 has used 12% of the Spark bucket vs acct 1's 0% → acct 2 binds.
    assert_eq!(windows[0].used_percentage, Some(12.0));
    assert_eq!(windows[0].resets_at, Some(1_787_427_150));
    let accounts = l.accounts.unwrap();
    assert_eq!(accounts[0].windows[0].used_percentage, Some(0.0));
    assert_eq!(accounts[1].windows[0].used_percentage, Some(12.0));
}

#[test]
fn a_named_short_window_promotes_to_the_account_five_hour_slot() {
    let mut v = lb();
    let window = &mut v["payload"][0]["data"]["additional_rate_limits"][0]["rate_limit"]
        ["primary_window"];
    window["used_percent"] = Value::from(42);
    window["limit_window_seconds"] = Value::from(18_000);
    window["reset_at"] = Value::from(1_786_840_042);

    let l = parse_cache(&v, 1_786_822_400).unwrap();
    let account = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(account.five_hour.used_percentage, Some(42.0));
    assert_eq!(account.five_hour.resets_at, Some(1_786_840_042));
    assert!(account
        .windows
        .iter()
        .any(|window| window.id == "codex_bengalfox-5h" && window.used_percentage == Some(42.0)));
}

#[test]
fn top_level_five_hour_window_wins_over_a_named_short_window() {
    let mut v = lb();
    v["payload"][0]["data"]["rate_limit"]["secondary_window"] = serde_json::json!({
        "used_percent": 30,
        "limit_window_seconds": 18_000,
        "reset_at": 1_786_840_030
    });
    let named = &mut v["payload"][0]["data"]["additional_rate_limits"][0]["rate_limit"]
        ["primary_window"];
    named["used_percent"] = Value::from(90);
    named["limit_window_seconds"] = Value::from(18_000);
    named["reset_at"] = Value::from(1_786_840_090);

    let l = parse_cache(&v, 1_786_822_400).unwrap();
    let account = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(account.five_hour.used_percentage, Some(30.0));
    assert_eq!(account.five_hour.resets_at, Some(1_786_840_030));
}

#[test]
fn a_named_long_window_does_not_populate_the_five_hour_slot() {
    let l = parse(LB_2_ACCOUNTS, 1_786_822_400);
    assert_eq!(l.accounts.as_ref().unwrap()[0].five_hour, LimitWindow::default());
    assert_eq!(l.five_hour, LimitWindow::default());
}

#[test]
fn named_short_windows_bind_across_accounts_after_promotion() {
    let mut v = lb();
    for (account, used_percent, reset_at) in [
        (0, 10, 1_786_840_010),
        (1, 80, 1_786_840_080),
    ] {
        let window = &mut v["payload"][account]["data"]["additional_rate_limits"][0]
            ["rate_limit"]["primary_window"];
        window["used_percent"] = Value::from(used_percent);
        window["limit_window_seconds"] = Value::from(18_000);
        window["reset_at"] = Value::from(reset_at);
    }

    let l = parse_cache(&v, 1_786_822_400).unwrap();
    assert_eq!(l.five_hour.used_percentage, Some(80.0));
    assert_eq!(l.five_hour.resets_at, Some(1_786_840_080));
}

#[test]
fn named_window_ids_fall_back_to_a_slug_then_position_and_never_collide_by_display_name() {
    let mut v = lb();
    let extra = &mut v["payload"][0]["data"]["additional_rate_limits"];
    // Two buckets whose display names slug identically but whose feature keys differ.
    let mut second = extra[0].clone();
    second["limit_name"] = Value::String("GPT 5.3 Codex Spark".into());
    second["metered_feature"] = Value::String("codex_other".into());
    second["rate_limit"]["primary_window"]["used_percent"] = Value::from(40);
    extra.as_array_mut().unwrap().push(second);
    // A third with neither key nor name → positional id.
    let mut third = extra[0].clone();
    third.as_object_mut().unwrap().remove("metered_feature");
    third.as_object_mut().unwrap().remove("limit_name");
    extra.as_array_mut().unwrap().push(third);
    let l = parse_cache(&v, 1_786_822_400).unwrap();
    let ids: Vec<String> = l.windows.unwrap().into_iter().map(|w| w.id).collect();
    assert!(ids.contains(&"codex_bengalfox-7d".to_string()));
    assert!(ids.contains(&"codex_other-7d".to_string()));
    assert!(ids.contains(&"additional-2-7d".to_string()), "{ids:?}");
    // No metered_feature but a name → slug fallback.
    let mut v = lb();
    v["payload"][0]["data"]["additional_rate_limits"][0]
        .as_object_mut()
        .unwrap()
        .remove("metered_feature");
    let l = parse_cache(&v, 1_786_822_400).unwrap();
    assert!(l.accounts.unwrap()[0]
        .windows
        .iter()
        .any(|w| w.id == "gpt-5-3-codex-spark-7d"));
}

#[test]
fn a_restored_five_hour_window_shows_up_automatically_and_clears_the_note() {
    let l = parse(LB_WITH_5H, 1_786_822_400);
    assert_eq!(l.five_hour.used_percentage, Some(37.0));
    assert_eq!(l.five_hour.resets_at, Some(1_786_840_000));
    assert_eq!(l.seven_day.used_percentage, Some(5.0));
    assert!(
        l.note.is_none(),
        "note should clear when a 5h window is present: {:?}",
        l.note
    );
    assert_eq!(l.note_codes.as_deref(), Some(&[][..]));
    let accounts = l.accounts.unwrap();
    assert_eq!(accounts[0].five_hour.used_percentage, Some(37.0));
    assert_eq!(accounts[1].five_hour, LimitWindow::default());
}

#[test]
fn a_window_without_a_positive_length_is_skipped_not_forced_into_the_5h_slot() {
    let mut v = lb();
    let rl = &mut v["payload"][0]["data"]["rate_limit"];
    rl["primary_window"]
        .as_object_mut()
        .unwrap()
        .remove("limit_window_seconds");
    rl["secondary_window"] = serde_json::json!({
        "used_percent": 55, "limit_window_seconds": 0, "reset_at": 1_786_840_000
    });
    let l = parse_cache(&v, 1_786_822_400).unwrap();
    let a = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(
        a.five_hour,
        LimitWindow::default(),
        "unclassifiable windows stay out"
    );
    assert_eq!(a.seven_day, LimitWindow::default());
    // The other account still binds the 7d view.
    assert_eq!(l.seven_day.used_percentage, Some(1.0));
}

#[test]
fn two_windows_in_the_same_slot_keep_the_higher_used_percent() {
    let mut v = lb();
    // Both windows 7d-length: primary 5%, secondary 9% → the slot shows 9%.
    v["payload"][0]["data"]["rate_limit"]["secondary_window"] = serde_json::json!({
        "used_percent": 9, "limit_window_seconds": 604_800, "reset_at": 1_787_300_000
    });
    let l = parse_cache(&v, 1_786_822_400).unwrap();
    let a = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(a.seven_day.used_percentage, Some(9.0));
    assert_eq!(a.seven_day.resets_at, Some(1_787_300_000));
}

#[test]
fn usage_only_in_additional_windows_is_not_reported_as_no_data() {
    let mut v = lb();
    for acct in v["payload"].as_array_mut().unwrap() {
        acct["data"]["rate_limit"]["primary_window"] = Value::Null;
    }
    let l = parse_cache(&v, 1_786_822_400).unwrap();
    // Standard slots empty, but the Spark buckets carry usage → not "no data".
    assert_eq!(l.seven_day, LimitWindow::default());
    let codes = l.note_codes.unwrap();
    assert!(!codes.contains(&CODE_NO_DATA.to_string()), "{codes:?}");
    assert!(codes.contains(&CODE_NO_5H.to_string()));
}

#[test]
fn staleness_uses_fetched_at_against_the_five_minute_threshold() {
    let fresh = parse(LB_2_ACCOUNTS, 1_786_822_350 + 120);
    assert_eq!(fresh.captured_at, Some(1_786_822_350));
    assert_eq!(fresh.stale, Some(false));
    assert_eq!(fresh.stale_after_secs, Some(STALE_AFTER_SECS));
    let old = parse(LB_2_ACCOUNTS, 1_786_822_350 + STALE_AFTER_SECS + 1);
    assert_eq!(old.stale, Some(true));
}

#[test]
fn raine_mode_single_object_payload_is_one_labelled_account() {
    let l = parse(RAINE, 1_786_822_400);
    assert_eq!(l.model.as_deref(), Some("chatgpt · 1 acct"));
    assert_eq!(l.seven_day.used_percentage, Some(67.0));
    let accounts = l.accounts.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].label, "c…@example.net");
    assert!(l.note.as_deref().unwrap_or("").contains("'raine' mode"));
    assert!(l
        .note_codes
        .unwrap()
        .contains(&CODE_LEGACY_MODE.to_string()));
}

#[test]
fn a_failed_account_fetch_keeps_its_row_with_a_note() {
    let l = parse(LB_ONE_FAILED, 1_786_822_400);
    let accounts = l.accounts.unwrap();
    assert_eq!(accounts.len(), 2);
    assert_eq!(accounts[0].seven_day.used_percentage, Some(5.0));
    assert_eq!(accounts[1].seven_day, LimitWindow::default());
    assert_eq!(accounts[1].plan, None);
    assert!(accounts[1]
        .note
        .as_deref()
        .unwrap_or("")
        .contains("fetch failed"));
    assert_eq!(accounts[1].note_codes, vec![CODE_ACCOUNT_FETCH_FAILED]);
    // The healthy account still binds.
    assert_eq!(l.seven_day.used_percentage, Some(5.0));
}

#[test]
fn account_status_flags_become_notes_with_codes() {
    let mut v = lb();
    let d = &mut v["payload"][1]["data"];
    d["rate_limit"]["limit_reached"] = Value::Bool(true);
    d["spend_control"]["reached"] = Value::Bool(true);
    let l = parse_cache(&v, 1_786_822_400).unwrap();
    let a = &l.accounts.unwrap()[1];
    assert_eq!(a.limit_reached, Some(true));
    assert_eq!(
        a.note.as_deref(),
        Some("rate limit reached; spend control reached")
    );
    assert_eq!(
        a.note_codes,
        vec![CODE_RATE_LIMIT_REACHED, CODE_SPEND_CONTROL_REACHED]
    );
}

#[test]
fn empty_or_malformed_payloads_yield_no_entry() {
    for text in [
        r#"{"fetched_at": 1, "mode": "lb", "payload": []}"#,
        r#"{"fetched_at": 1, "mode": "lb", "payload": null}"#,
        r#"{"fetched_at": 1, "mode": "lb"}"#,
    ] {
        let v: Value = serde_json::from_str(text).unwrap();
        assert!(parse_cache(&v, 2).is_none(), "{text}");
    }
}

#[test]
fn cache_file_reader_maps_windows_binds_the_max_and_marks_stale() {
    let mut cache: Value = serde_json::from_str(LB_WITH_5H).unwrap();
    let accounts = cache["payload"].as_array_mut().unwrap();
    // Move both maxima off account 0, proving the binding view does not just select the first row.
    accounts[0]["data"]["rate_limit"]["primary_window"]["used_percent"] = Value::from(1);
    accounts[1]["data"]["rate_limit"]["primary_window"]["used_percent"] = Value::from(52);
    accounts[1]["data"]["rate_limit"]["primary_window"]["reset_at"] = Value::from(1_787_555_555);
    accounts[1]["data"]["rate_limit"]["secondary_window"] = serde_json::json!({
        "used_percent": 48, "limit_window_seconds": 18_000, "reset_at": 1_786_850_000
    });
    let cache_file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(cache_file.path(), cache.to_string()).unwrap();

    let now = 1_786_822_350 + STALE_AFTER_SECS + 1;
    let limit =
        limit_from_cache_path(cache_file.path(), now, false).expect("fixture cache yields a limit");

    // A 5h secondary window (< 100_000 seconds) and a 7d primary window map to their
    // respective slots; the binding keeps the max usage and its matching reset timestamp.
    assert_eq!(limit.five_hour.used_percentage, Some(48.0));
    assert_eq!(limit.five_hour.resets_at, Some(1_786_850_000));
    assert_eq!(limit.seven_day.used_percentage, Some(52.0));
    assert_eq!(limit.seven_day.resets_at, Some(1_787_555_555));
    assert_eq!(limit.stale, Some(true));
}

#[test]
fn missing_or_malformed_cache_files_degrade_to_no_limit() {
    let dir = tempfile::tempdir().unwrap();
    assert!(limit_from_cache_path(&dir.path().join("missing.json"), 1, false).is_none());

    let malformed = dir.path().join("malformed.json");
    std::fs::write(&malformed, "not json").unwrap();
    assert!(limit_from_cache_path(&malformed, 1, false).is_none());
}

#[test]
fn cache_older_than_ninety_seconds_requests_a_refresh() {
    let cache = serde_json::json!({ "fetched_at": 1_000.0 });
    assert!(!needs_refresh(&cache, 1_090));
    assert!(needs_refresh(&cache, 1_091));
    assert!(!needs_refresh(&serde_json::json!({}), 1_091));
}

#[cfg(unix)]
static REFRESH_TEST_SERIAL: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(unix)]
#[test]
fn stale_cache_reader_kicks_the_injected_helper() {
    use std::os::unix::fs::PermissionsExt;

    let _serial = REFRESH_TEST_SERIAL
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap();
    REFRESHING.store(false, Ordering::SeqCst);
    LAST_KICK_AT.store(0, Ordering::SeqCst);

    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache.json");
    std::fs::write(
        &cache,
        r#"{"fetched_at": 1000, "mode": "lb", "payload": []}"#,
    )
    .unwrap();
    let marker = dir.path().join("helper-ran");
    let helper = dir.path().join("refresh-helper");
    // The helper records the args it was invoked with, so the test proves the INJECTED helper (not
    // the real claudex-usage) actually ran with `--refresh lb`. LAST_KICK_AT alone is stored before
    // the spawn, so it would pass even if the spawn used the wrong path or failed (HED-49 review).
    std::fs::write(
        &helper,
        format!("#!/bin/sh\nprintf '%s' \"$*\" > \"{}\"\nexit 0\n", marker.display()),
    )
    .unwrap();
    let mut perms = std::fs::metadata(&helper).unwrap().permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(&helper, perms).unwrap();

    let now = 1091;
    let _ = limit_from_cache_and_helper_path(&cache, &helper, now, true);
    assert_eq!(LAST_KICK_AT.load(Ordering::SeqCst), now);
    // The kick spawns the helper and a reaper thread waits on it; poll briefly for its marker.
    let mut ran = String::new();
    for _ in 0..100 {
        if let Ok(s) = std::fs::read_to_string(&marker) {
            ran = s;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(ran, "--refresh lb", "the injected helper must run with --refresh lb");
}

#[test]
fn window_length_boundary_maps_under_100k_to_five_hours_and_100k_to_seven_days() {
    let rate_limit = serde_json::json!({
        "primary_window": {
            "used_percent": 11,
            "limit_window_seconds": 99_999,
            "reset_at": 2_001
        },
        "secondary_window": {
            "used_percent": 22,
            "limit_window_seconds": 100_000,
            "reset_at": 2_002
        }
    });

    let (five_hour, seven_day) = windows_from_rate_limit(&rate_limit);
    assert_eq!(
        five_hour,
        LimitWindow {
            used_percentage: Some(11.0),
            resets_at: Some(2_001)
        }
    );
    assert_eq!(
        seven_day,
        LimitWindow {
            used_percentage: Some(22.0),
            resets_at: Some(2_002)
        }
    );

    let secondary_is_short = serde_json::json!({
        "primary_window": {"used_percent": 33, "limit_window_seconds": 604_800, "reset_at": 3_001},
        "secondary_window": {"used_percent": 44, "limit_window_seconds": 99_999, "reset_at": 3_002}
    });
    let (five_hour, seven_day) = windows_from_rate_limit(&secondary_is_short);
    assert_eq!(five_hour.resets_at, Some(3_002));
    assert_eq!(seven_day.resets_at, Some(3_001));
}

#[test]
fn notes_are_single_spaced() {
    // `\` line continuations swallow the next line's leading whitespace (Rust reference,
    // "String continuation escapes"), so the rendered notes contain no runs of spaces.
    for note in [NO_5H_NOTE, NO_DATA_NOTE] {
        assert!(!note.contains("  "), "{note:?}");
        assert!(!note.contains('\n'));
    }
}

#[test]
fn slug_is_stable_and_lowercase() {
    assert_eq!(slug("GPT-5.3-Codex-Spark"), "gpt-5-3-codex-spark");
    assert_eq!(slug("  weird  name!! "), "weird-name");
    assert_eq!(slug("!!!"), "");
}

/// Machine-dependent smoke test against the REAL claudex-usage cache on this machine — run with
/// `cargo test --lib heddle_stats::codex -- --ignored --nocapture` to eyeball the exact JSON the
/// drawer receives (emails are masked). Ignored by default; absent cache = pass.
#[test]
#[ignore]
fn live_cache_smoke() {
    match limit(super::super::now_secs()) {
        Some(l) => println!("{}", serde_json::to_string_pretty(&l).unwrap()),
        None => println!("(no claudex-usage cache on this machine)"),
    }
}
