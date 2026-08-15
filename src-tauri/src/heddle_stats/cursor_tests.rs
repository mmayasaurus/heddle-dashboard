//! Unit tests for `cursor.rs` (kept in a sibling file so the source file stays readable).

use super::*;

/// A real `GET cursor.com/api/usage-summary` answer for an Ultra account (2026-08-15; no PII —
/// the endpoint returns no email). Included pool exhausted, on-demand at $0 of a $100 limit.
const USAGE_SUMMARY: &str =
    include_str!("../../tests/fixtures/heddle_stats/cursor-usage-summary.json");

fn summary() -> Value {
    serde_json::from_str(USAGE_SUMMARY).unwrap()
}

/// header.payload.signature with a base64url payload — the shape of a real session JWT.
fn fake_jwt(sub: &str, exp: i64) -> String {
    let payload =
        serde_json::to_vec(&json!({"sub": sub, "exp": exp, "aud": "https://cursor.com"})).unwrap();
    format!(
        "eyJhbGciOiJIUzI1NiJ9.{}.c2ln",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload)
    )
}

fn snapshot_with(
    accounts: Vec<Value>,
    captured_at: Option<i64>,
    last_error: Option<&str>,
) -> Value {
    let mut s = json!({
        "model": format!("cursor.com · {} acct", accounts.len()),
        "rate_limits": {},
        "capturedAt": captured_at,
        "source": SOURCE,
        "accounts": accounts,
        "lastAttemptAt": captured_at.unwrap_or(0),
    });
    if let Some(e) = last_error {
        s["lastError"] = json!(e);
    }
    s
}

fn ide_account(now: i64) -> Value {
    json!({
        "label": "v…@example.com",
        "source": SOURCE_IDE,
        "tokenExpiresAt": now + 30 * 86_400,
        "membershipHint": "ultra",
        "fetchedAt": now,
        "summary": summary(),
        "error": null,
    })
}

#[test]
fn jwt_sub_and_exp_are_decoded_without_verification() {
    let t = fake_jwt("github|user_01ABC", 1_790_028_254);
    assert_eq!(jwt_user_id(&t).as_deref(), Some("user_01ABC"));
    assert_eq!(jwt_exp(&t), Some(1_790_028_254));
    assert_eq!(jwt_user_id("not-a-jwt"), None);
    assert_eq!(jwt_exp("a.b.c"), None);
    // A sub without a provider prefix is used as-is.
    assert_eq!(
        jwt_user_id(&fake_jwt("user_plain", 1)).as_deref(),
        Some("user_plain")
    );
}

#[test]
fn account_row_maps_the_two_pools_to_named_windows_in_dollars() {
    let now = 1_786_830_000;
    let a = account_row(&ide_account(now), now);
    assert_eq!(a.label, "v…@example.com");
    assert_eq!(a.plan.as_deref(), Some("ultra"));
    assert_eq!(a.five_hour, LimitWindow::default());
    assert_eq!(a.seven_day, LimitWindow::default());
    let ids: Vec<&str> = a.windows.iter().map(|w| w.id.as_str()).collect();
    assert_eq!(ids, ["monthly", "usage-based"]);
    let monthly = &a.windows[0];
    assert_eq!(monthly.used_percentage, Some(100.0));
    assert_eq!(monthly.used_amount, Some(400.0));
    assert_eq!(monthly.limit_amount, Some(400.0));
    assert_eq!(monthly.unit.as_deref(), Some("usd"));
    // Both pools reset with the billing cycle: 2026-08-25T22:24:48Z.
    assert_eq!(monthly.resets_at, Some(1_787_696_688));
    let on_demand = &a.windows[1];
    assert_eq!(on_demand.used_percentage, Some(0.0));
    assert_eq!(on_demand.used_amount, Some(0.0));
    assert_eq!(on_demand.limit_amount, Some(100.0));
    assert_eq!(on_demand.resets_at, Some(1_787_696_688));
    // Included pool exhausted but on-demand is on with room → requests still work.
    assert_eq!(a.limit_reached, Some(false));
    assert!(a.note_codes.contains(&CODE_PLAN_EXHAUSTED.to_string()));
    assert!(a.note.as_deref().unwrap().contains("$400.00 of $400.00"));
    // Raw facts for the router (cents, percentages, cycle, token expiry).
    let d = a.detail.unwrap();
    assert_eq!(d["plan"]["totalPercentUsed"], 17.337600000000002);
    assert_eq!(d["plan"]["apiPercentUsed"], 86.688);
    assert_eq!(d["onDemand"]["limit"], 10000);
    assert_eq!(d["billingCycleEnd"], 1_787_696_688);
    assert_eq!(d["membershipType"], "ultra");
    assert_eq!(d["source"], SOURCE_IDE);
}

#[test]
fn on_demand_hard_stop_and_disabled_on_demand_set_limit_reached() {
    let now = 1_786_830_000;
    // On-demand capped out.
    let mut acct = ide_account(now);
    acct["summary"]["individualUsage"]["onDemand"] =
        json!({"enabled": true, "used": 10000, "limit": 10000, "remaining": 0});
    let a = account_row(&acct, now);
    assert_eq!(a.limit_reached, Some(true));
    assert!(a
        .note_codes
        .contains(&CODE_ON_DEMAND_LIMIT_REACHED.to_string()));
    assert_eq!(a.windows[1].used_percentage, Some(100.0));
    // On-demand off + included pool gone → requests fail.
    let mut acct = ide_account(now);
    acct["summary"]["individualUsage"]["onDemand"] =
        json!({"enabled": false, "used": 0, "limit": 0, "remaining": 0});
    let a = account_row(&acct, now);
    assert_eq!(a.limit_reached, Some(true));
    assert_eq!(a.windows[1].used_percentage, None);
    assert!(a.windows[1].label.contains("off"));
    // Plenty of included pool left, on-demand off → fine.
    let mut acct = ide_account(now);
    acct["summary"]["individualUsage"]["plan"]["used"] = json!(1000);
    acct["summary"]["individualUsage"]["plan"]["remaining"] = json!(39000);
    acct["summary"]["individualUsage"]["onDemand"]["enabled"] = json!(false);
    let a = account_row(&acct, now);
    assert_eq!(a.limit_reached, Some(false));
    assert!(!a.note_codes.contains(&CODE_PLAN_EXHAUSTED.to_string()));
    assert_eq!(a.windows[0].used_percentage, Some(2.5));
}

#[test]
fn legacy_overall_shape_is_read_as_on_demand() {
    let now = 1_786_830_000;
    let mut acct = ide_account(now);
    let iu = acct["summary"]["individualUsage"].as_object_mut().unwrap();
    let od = iu.remove("onDemand").unwrap();
    iu.insert("overall".to_string(), od);
    let a = account_row(&acct, now);
    assert_eq!(a.windows[1].id, "usage-based");
    assert_eq!(a.windows[1].limit_amount, Some(100.0));
}

#[test]
fn token_expiry_and_fetch_errors_become_notes_and_keep_last_known_numbers() {
    let now = 1_786_830_000;
    let mut acct = ide_account(now);
    acct["tokenExpiresAt"] = json!(now + 3 * 86_400);
    acct["error"] = json!("usage-summary: HTTP 429 — rate limited by cursor.com");
    let a = account_row(&acct, now);
    assert!(a.note_codes.contains(&CODE_TOKEN_EXPIRING_SOON.to_string()));
    assert!(a.note_codes.contains(&CODE_FETCH_FAILED.to_string()));
    assert!(a.note.as_deref().unwrap().contains("expires in 3d"));
    assert!(a.note.as_deref().unwrap().contains("HTTP 429"));
    // Last-known summary still renders.
    assert_eq!(a.windows[0].used_percentage, Some(100.0));
    let mut acct = ide_account(now);
    acct["tokenExpiresAt"] = json!(now - 1);
    let a = account_row(&acct, now);
    assert!(a.note_codes.contains(&CODE_TOKEN_EXPIRED.to_string()));
    // No summary at all (never fetched): empty windows, unknown limit_reached, error surfaced.
    let acct = json!({"label": "c…@example.org", "source": SOURCE_CLI_KEYCHAIN, "tokenExpiresAt": now + 30 * 86_400, "error": "Keychain read of cursor-access-token failed (security exit 44) — access denied or no cursor-agent login"});
    let a = account_row(&acct, now);
    assert!(a.windows.is_empty());
    assert_eq!(a.limit_reached, None);
    assert_eq!(a.plan, None);
    assert_eq!(a.note_codes, vec![CODE_FETCH_FAILED]);
}

#[test]
fn snapshot_parses_to_a_cursor_entry_with_binding_windows_across_accounts() {
    let now = 1_786_830_000;
    let mut second = ide_account(now);
    second["label"] = json!("m…@example.org");
    second["source"] = json!(SOURCE_CLI_KEYCHAIN);
    second["summary"]["membershipType"] = json!("pro");
    second["summary"]["individualUsage"]["plan"] = json!({"enabled": true, "used": 500, "limit": 2000, "remaining": 1500, "breakdown": {"included": 2000, "bonus": 0, "total": 2000}, "autoPercentUsed": 0, "apiPercentUsed": 25, "totalPercentUsed": 25});
    second["summary"]["individualUsage"]["onDemand"] =
        json!({"enabled": true, "used": 4200, "limit": 5000, "remaining": 800});
    let snap = snapshot_with(vec![ide_account(now), second], Some(now), None);
    let l = parse_snapshot(&snap, now + 60).unwrap();
    assert_eq!(l.provider, "cursor");
    assert_eq!(l.model.as_deref(), Some("cursor.com · 2 acct"));
    assert_eq!(l.source.as_deref(), Some(SOURCE));
    assert_eq!(l.five_hour, LimitWindow::default());
    assert_eq!(l.seven_day, LimitWindow::default());
    assert_eq!(l.stale, Some(false));
    assert_eq!(l.stale_after_secs, Some(STALE_AFTER_SECS));
    assert!(l.note.is_none());
    assert_eq!(l.note_codes.as_deref(), Some(&[][..]));
    // Binding: monthly = the exhausted Ultra pool (100%), usage-based = the Pro account (84%).
    let windows = l.windows.unwrap();
    assert_eq!(windows[0].id, "monthly");
    assert_eq!(windows[0].used_percentage, Some(100.0));
    assert_eq!(windows[1].id, "usage-based");
    assert_eq!(windows[1].used_percentage, Some(84.0));
    assert_eq!(windows[1].used_amount, Some(42.0));
    let accounts = l.accounts.unwrap();
    assert_eq!(accounts.len(), 2);
    assert_eq!(accounts[1].plan.as_deref(), Some("pro"));
    // The full emails never appear.
    let js = serde_json::to_string(&accounts).unwrap();
    assert!(!js.contains("@example.com\"") || js.contains("v…@example.com"));
    // Old snapshot → stale.
    assert_eq!(
        parse_snapshot(&snap, now + STALE_AFTER_SECS + 1)
            .unwrap()
            .stale,
        Some(true)
    );
}

#[test]
fn no_accounts_and_refresh_failures_are_explained() {
    let now = 1_786_830_000;
    let snap = snapshot_with(vec![], None, Some("no Cursor login found (Cursor IDE not signed in; cursor-agent Keychain account is opt-in — see docs/USAGE_TAP.md)"));
    let l = parse_snapshot(&snap, now).unwrap();
    assert_eq!(l.model.as_deref(), Some("cursor.com · 0 acct"));
    assert_eq!(
        l.note_codes.as_deref(),
        Some(&[CODE_NO_ACCOUNTS.to_string()][..])
    );
    assert!(l.note.as_deref().unwrap().contains("opt-in"));
    assert_eq!(l.stale, None);
    // Accounts present but the last refresh failed after a good one → refreshFailed, data kept.
    let mut snap = snapshot_with(
        vec![ide_account(now)],
        Some(now),
        Some("every account fetch failed (see accounts[].error)"),
    );
    snap["lastAttemptAt"] = json!(now + 200);
    let l = parse_snapshot(&snap, now + 260).unwrap();
    assert_eq!(
        l.note_codes.as_deref(),
        Some(&[CODE_REFRESH_FAILED.to_string()][..])
    );
    assert!(l
        .note
        .as_deref()
        .unwrap()
        .starts_with("last refresh failed (60s ago)"));
    assert_eq!(l.windows.unwrap()[0].used_percentage, Some(100.0));
    // Never succeeded → noDataYet.
    let snap = snapshot_with(
        vec![ide_account(now)],
        None,
        Some("usage-summary: HTTP 401/403 — session rejected (expired or signed out)"),
    );
    let l = parse_snapshot(&snap, now).unwrap();
    assert_eq!(
        l.note_codes.as_deref(),
        Some(&[CODE_NO_DATA_YET.to_string()][..])
    );
}

#[test]
fn keychain_cli_account_is_opt_in_via_usage_sources_json() {
    assert!(!keychain_cli_enabled(&json!({})));
    assert!(!keychain_cli_enabled(
        &json!({"cursor": {"keychainCli": false}})
    ));
    assert!(!keychain_cli_enabled(
        &json!({"cursor": {"keychainCli": "yes"}})
    ));
    assert!(keychain_cli_enabled(
        &json!({"cursor": {"keychainCli": true}})
    ));
}

/// Machine-dependent: discovers the local Cursor logins (IDE always; cursor-agent Keychain only if
/// opted in), fetches usage-summary for each, writes the real snapshot and reads it back. Run:
/// `cargo test --lib heddle_stats::cursor -- --ignored --nocapture`.
#[test]
#[ignore]
fn live_refresh_writes_snapshot_and_limit_reads_it() {
    let started = now_secs();
    assert!(force_refresh(started), "refresh thread should start");
    for _ in 0..90 {
        std::thread::sleep(Duration::from_millis(500));
        if !REFRESHING.load(Ordering::SeqCst) {
            break;
        }
    }
    let snap: Value =
        serde_json::from_str(&std::fs::read_to_string(snapshot_path()).unwrap()).unwrap();
    println!(
        "snapshot capturedAt={} lastError={} accounts={}",
        snap["capturedAt"],
        snap["lastError"],
        snap["accounts"].as_array().map(|a| a.len()).unwrap_or(0)
    );
    let l = limit(now_secs()).expect("snapshot present → entry");
    println!("{}", serde_json::to_string_pretty(&l).unwrap());
}
