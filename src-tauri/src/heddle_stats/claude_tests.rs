//! Unit tests for `claude.rs` (kept in a sibling file so the source file stays readable).

use super::*;

/// The registry shape the tap and window-keeper use (fake identities).
const REGISTRY: &str = r#"{
  "claude": [
    {"id": "acct1", "configDir": null, "email": "one@example.com", "loggedIn": true},
    {"id": "acct2", "configDir": "/tmp/heddle-claude-tests/.claude-acct2", "email": "two@example.org", "loggedIn": true},
    {"id": "acct3", "configDir": "/tmp/heddle-claude-tests/.claude-acct3", "email": "three@example.net", "loggedIn": false},
    {"id": "acct4", "configDir": "/tmp/heddle-claude-tests/.claude-acct4", "email": "four@example.net", "loggedIn": true}
  ]
}"#;

fn tap_file(model: &str, five: f64, seven: f64, captured: i64, acct: &str) -> String {
    format!(
        r#"{{"model":"{model}","rate_limits":{{"five_hour":{{"used_percentage":{five},"resets_at":1786846200}},"seven_day":{{"used_percentage":{seven},"resets_at":1786892400}}}},"capturedAt":{captured},"account":"{acct}","configDir":null}}"#
    )
}

/// A `claude-<id>.oauth-usage.json` sidecar shaped exactly like the shipped keeper's
/// `oauth_usage_for()` (`scripts/heddle-window-keeper.py`) — no `windowResetsAt` field, since that
/// keeper doesn't emit one today.
fn oauth_file(fable_pct: f64, captured: i64) -> String {
    format!(
        r#"{{"fablePct":{fable_pct},"fiveHourPct":10.0,"sevenDayPct":20.0,"byModel":{{"Fable":{fable_pct}}},"capturedAt":{captured},"source":"oauth-usage"}}"#
    )
}

/// Same shape, but with a `windowResetsAt` — for exercising the (not-yet-shipped) case where the
/// endpoint's Fable entry carries its own reset, distinct from the tap's 7-day boundary.
fn oauth_file_with_window(fable_pct: f64, captured: i64, window_resets_at: i64) -> String {
    format!(
        r#"{{"fablePct":{fable_pct},"fiveHourPct":null,"sevenDayPct":null,"byModel":{{}},"capturedAt":{captured},"source":"oauth-usage","windowResetsAt":{window_resets_at}}}"#
    )
}

/// A scratch usage dir under the crate's own (gitignored) `target/` — not the shared OS temp dir —
/// unique per test and process, removed on drop.
struct Scratch(PathBuf);
impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("heddle-claude-tests")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.0.join(name), text).unwrap();
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn registry() -> Vec<Account> {
    parse_registry(&serde_json::from_str(REGISTRY).unwrap())
}

/// Sets the keeper's `HEDDLE_OAUTH_CACHE_SECS` for THIS TEST THREAD only (see
/// `CACHE_SECS_OVERRIDE`), and clears it on drop so a panic can't leak it into the rest of the case.
/// The process env is deliberately untouched: these tests run in parallel threads of one process.
struct CacheSecs;
impl CacheSecs {
    fn set(v: &str) -> Self {
        CACHE_SECS_OVERRIDE.with(|c| *c.borrow_mut() = Some(v.to_string()));
        CacheSecs
    }
}
impl Drop for CacheSecs {
    fn drop(&mut self) {
        CACHE_SECS_OVERRIDE.with(|c| *c.borrow_mut() = None);
    }
}

fn persisted_attrib(s: &Scratch, id: &str) -> Attrib {
    serde_json::from_str(
        &std::fs::read_to_string(s.0.join(format!("claude-{id}.attrib.json"))).unwrap(),
    )
    .unwrap()
}

#[test]
fn registry_parses_ids_config_dirs_and_emails() {
    let r = registry();
    assert_eq!(r.len(), 4);
    assert_eq!(r[0].id, "acct1");
    assert_eq!(r[0].config_dir, None);
    assert_eq!(
        r[1].config_dir.as_deref(),
        Some(Path::new("/tmp/heddle-claude-tests/.claude-acct2"))
    );
    assert_eq!(r[2].email.as_deref(), Some("three@example.net"));
    assert_eq!(r[0].logged_in, Some(true));
    assert_eq!(r[2].logged_in, Some(false));
    assert!(parse_registry(&serde_json::json!({})).is_empty());
}

#[test]
fn active_account_follows_claude_config_dir_else_the_default() {
    let r = registry();
    assert_eq!(
        active_account(&r, None).map(|a| a.id.as_str()),
        Some("acct1")
    );
    assert_eq!(
        active_account(
            &r,
            Some(Path::new("/tmp/heddle-claude-tests/.claude-acct3"))
        )
        .map(|a| a.id.as_str()),
        Some("acct3")
    );
    // Unregistered dir → the default account.
    assert_eq!(
        active_account(&r, Some(Path::new("/tmp/heddle-claude-tests/.claude-nope")))
            .map(|a| a.id.as_str()),
        Some("acct1")
    );
    assert!(active_account(&[], None).is_none());
}

#[test]
fn without_a_registry_the_entry_is_the_plain_tap_file() {
    let s = Scratch::new("noreg");
    s.write(
        "claude.json",
        &tap_file("claude-fable-5", 20.0, 9.0, 1_786_822_375, "acct1"),
    );
    let l = build(&s.0, &[], None, 1_786_822_400).unwrap();
    assert_eq!(l.five_hour.used_percentage, Some(20.0));
    assert!(l.accounts.is_none() && l.active_account.is_none());
    assert!(build(&Scratch::new("empty").0, &[], None, 0).is_none());
}

#[test]
fn per_account_rows_come_from_claude_acct_files_and_top_level_is_the_active_account() {
    let now = 1_786_830_900;
    let s = Scratch::new("rows");
    s.write(
        "claude.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write(
        "claude-acct2.json",
        &tap_file("claude-haiku-4-5", 100.0, 2.0, now - 700, "acct2"),
    );
    // acct3: no capture yet.
    let l = build(&s.0, &registry(), None, now).unwrap();
    assert_eq!(l.provider, "claude");
    assert_eq!(l.model.as_deref(), Some("claude-fable-5 · 4 acct"));
    assert_eq!(l.active_account.as_deref(), Some("acct1"));
    assert_eq!(l.five_hour.used_percentage, Some(32.0));
    assert_eq!(l.source.as_deref(), Some("statusline-tap"));
    assert_eq!(l.stale, Some(false));
    let rows = l.accounts.unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].id, "acct1");
    assert_eq!(rows[0].label, "o…@example.com");
    assert_eq!(rows[0].five_hour.used_percentage, Some(32.0));
    assert_eq!(rows[0].captured_at, Some(now - 60));
    assert_eq!(rows[0].stale, Some(false));
    assert_eq!(rows[0].limit_reached, Some(false));
    assert_eq!(rows[0].logged_in, Some(true));
    assert_eq!(rows[0].detail.as_ref().unwrap()["model"], "claude-fable-5");
    // acct2: at 100% → limitReached + code; captured 700s ago → stale.
    assert_eq!(rows[1].id, "acct2");
    assert_eq!(rows[1].limit_reached, Some(true));
    assert_eq!(rows[1].note_codes, vec![CODE_LIMIT_REACHED]);
    assert_eq!(rows[1].stale, Some(true));
    // acct3: no file → explained, unknown.
    assert_eq!(rows[2].id, "acct3");
    assert_eq!(rows[2].label, "t…@example.net");
    assert_eq!(rows[2].five_hour, LimitWindow::default());
    assert_eq!(rows[2].limit_reached, None);
    assert_eq!(rows[2].note_codes, vec![CODE_NO_CAPTURE]);
    assert_eq!(rows[2].logged_in, Some(false));
    assert_eq!(rows[3].id, "acct4");
    assert_eq!(rows[3].note_codes, vec![CODE_NO_CAPTURE]);
    // Full emails never leak.
    let js = serde_json::to_string(&rows).unwrap();
    assert!(
        !js.contains("one@") && !js.contains("two@") && !js.contains("three@"),
        "{js}"
    );
}

#[test]
fn keeper_anchors_supply_registered_account_windows_when_fresher_than_the_tap() {
    let now = 1_786_830_900;
    let s = Scratch::new("keeper-rows");
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write(
        "claude-acct3.keeper.json",
        &format!(
            r#"{{"account":"acct3","startedAt":{},"resets_at":{},"used":null}}"#,
            now - 30,
            now + 5 * 3600
        ),
    );
    s.write(
        "claude-acct4.keeper.json",
        &format!(
            r#"{{"account":"acct4","startedAt":{},"resets_at":{},"used":null}}"#,
            now - 20,
            now + 5 * 3600
        ),
    );

    let rows = account_rows(&s.0, &registry(), now);
    assert_eq!(rows[2].id, "acct3");
    assert_eq!(rows[2].captured_at, Some(now - 30));
    assert_eq!(rows[2].five_hour.used_percentage, None);
    assert_eq!(rows[2].five_hour.resets_at, Some(now + 5 * 3600));
    assert_eq!(rows[2].note_codes, Vec::<String>::new());
    assert_eq!(rows[3].id, "acct4");
    assert_eq!(rows[3].captured_at, Some(now - 20));
    assert_eq!(rows[3].five_hour.resets_at, Some(now + 5 * 3600));
}

#[test]
fn active_account_switches_the_top_level_and_falls_back_to_the_legacy_file() {
    let now = 1_786_830_900;
    let s = Scratch::new("active");
    s.write(
        "claude.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write(
        "claude-acct2.json",
        &tap_file("claude-haiku-4-5", 7.0, 2.0, now - 30, "acct2"),
    );
    // Running as acct2 → its file is the top level.
    let l = build(
        &s.0,
        &registry(),
        Some(Path::new("/tmp/heddle-claude-tests/.claude-acct2")),
        now,
    )
    .unwrap();
    assert_eq!(l.active_account.as_deref(), Some("acct2"));
    assert_eq!(l.five_hour.used_percentage, Some(7.0));
    assert!(l.model.as_deref().unwrap().starts_with("claude-haiku-4-5"));
    // Running as acct3 (no file yet) → legacy last-seen file keeps the summary populated, and
    // `activeAccount` names the account that capture came from (acct1), not the selected acct3.
    let l = build(
        &s.0,
        &registry(),
        Some(Path::new("/tmp/heddle-claude-tests/.claude-acct3")),
        now,
    )
    .unwrap();
    assert_eq!(l.active_account.as_deref(), Some("acct1"));
    assert_eq!(l.five_hour.used_percentage, Some(32.0));
}

#[test]
fn legacy_fallback_active_account_must_have_a_matching_row() {
    let now = 1_786_830_900;
    let s = Scratch::new("fallback-id");
    // Legacy capture names an account that is neither registered nor has a per-account file →
    // the numbers still show, but activeAccount stays null rather than dangling.
    s.write(
        "claude.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct-old-gone"),
    );
    let l = build(
        &s.0,
        &registry(),
        Some(Path::new("/tmp/heddle-claude-tests/.claude-acct3")),
        now,
    )
    .unwrap();
    assert_eq!(l.five_hour.used_percentage, Some(32.0));
    assert_eq!(l.active_account, None);
}

#[test]
fn unregistered_per_account_files_are_appended_as_extra_rows() {
    let now = 1_786_830_900;
    let s = Scratch::new("extra");
    s.write(
        "claude-unknown-claude-x.json",
        &tap_file("claude-sonnet-5", 3.0, 1.0, now - 10, "unknown-claude-x"),
    );
    // An old unregistered file (a one-off dir from weeks ago) is NOT shown.
    s.write(
        "claude-unknown-old.json",
        &tap_file("claude-sonnet-5", 9.0, 9.0, now - 3 * 86_400, "unknown-old"),
    );
    let l = build(&s.0, &registry(), None, now).unwrap();
    let rows = l.accounts.unwrap();
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[4].id, "unknown-claude-x");
    assert_eq!(rows[4].label, "unknown-claude-x");
    assert_eq!(rows[4].five_hour.used_percentage, Some(3.0));
}

#[test]
fn polls_accumulate_a_persisted_fable_estimate_per_account_and_surface_it_on_the_active_row() {
    let now = 1_786_830_900;
    let s = Scratch::new("fable");
    let reg = registry();
    // Poll 1: acct1 rendered a Fable session at 10% weekly.
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 30.0, 10.0, now - 300, "acct1"),
    );
    let l = build(&s.0, &reg, None, now - 300).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(r.fable_weekly_samples, Some(0));
    assert_eq!(r.fable_weekly_estimate_pct, None);
    assert!(
        s.0.join("claude-acct1.attrib.json").exists(),
        "attribution persisted"
    );
    // Polls 2-4: +2 (Fable), +1 (Haiku), +2 (Fable) → estimate 4% on 3 samples.
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 30.0, 12.0, now - 240, "acct1"),
    );
    build(&s.0, &reg, None, now - 240).unwrap();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-haiku-4-5", 30.0, 13.0, now - 180, "acct1"),
    );
    build(&s.0, &reg, None, now - 180).unwrap();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 30.0, 15.0, now - 120, "acct1"),
    );
    let l = build(&s.0, &reg, None, now - 120).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(r.fable_weekly_samples, Some(3));
    assert_eq!(r.fable_weekly_estimate_pct, Some(4.0));
    let fw = &r.detail.as_ref().unwrap()["fableWeekly"];
    assert_eq!(fw["fablePct"], 4.0);
    assert_eq!(fw["otherPct"], 1.0);
    assert_eq!(fw["unknownPct"], 10.0);
    top_level_and_idempotency(&s, &reg, now);
    // The attribution file itself is never mistaken for an unregistered account row.
    let l = build(&s.0, &reg, None, now).unwrap();
    assert!(l.accounts.unwrap().iter().all(|r| !r.id.contains("attrib")));
    // The persisted state survives a fresh process: read it back and check.
    let persisted: Attrib = serde_json::from_str(
        &std::fs::read_to_string(s.0.join("claude-acct1.attrib.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(persisted.samples, 3);
    assert_eq!(persisted.fable_pct, 4.0);
}

#[test]
fn single_file_mode_without_a_registry_still_accumulates_the_fable_estimate() {
    let now = 1_786_830_900;
    let s = Scratch::new("legacy-fable");
    s.write(
        "claude.json",
        &tap_file("claude-fable-5", 30.0, 10.0, now - 300, "acct1"),
    );
    let l = build(&s.0, &[], None, now - 300).unwrap();
    assert_eq!(l.fable_weekly_samples, Some(0));
    assert_eq!(l.fable_weekly_estimate_pct, None);
    assert!(s.0.join("claude-default.attrib.json").exists());
    s.write(
        "claude.json",
        &tap_file("claude-fable-5", 30.0, 12.0, now - 240, "acct1"),
    );
    build(&s.0, &[], None, now - 240).unwrap();
    s.write(
        "claude.json",
        &tap_file("claude-haiku-4-5", 30.0, 13.0, now - 180, "acct1"),
    );
    build(&s.0, &[], None, now - 180).unwrap();
    s.write(
        "claude.json",
        &tap_file("claude-fable-5", 30.0, 15.0, now - 120, "acct1"),
    );
    let l = build(&s.0, &[], None, now - 120).unwrap();
    assert_eq!(l.fable_weekly_samples, Some(3));
    assert_eq!(l.fable_weekly_estimate_pct, Some(4.0));
    // Still the plain single-file entry otherwise (no rows).
    assert!(l.accounts.is_none());
}

/// Second half of the accumulation test (split for the length gate): the active row's numbers ride
/// on the top level, other accounts stay null, and re-polling the same capture never double counts.
fn top_level_and_idempotency(s: &Scratch, reg: &[Account], now: i64) {
    let l = build(&s.0, reg, None, now - 120).unwrap();
    assert_eq!(l.active_account.as_deref(), Some("acct1"));
    assert_eq!(l.fable_weekly_estimate_pct, Some(4.0));
    assert_eq!(l.fable_weekly_samples, Some(3));
    assert_eq!(
        l.accounts.as_ref().unwrap()[1].fable_weekly_estimate_pct,
        None
    );
    let l = build(&s.0, reg, None, now).unwrap();
    assert_eq!(l.accounts.unwrap()[0].fable_weekly_samples, Some(3));
}

#[test]
fn a_row_without_a_current_capture_never_surfaces_a_historical_estimate() {
    let now = 1_786_830_900;
    let s = Scratch::new("stale-estimate");
    let reg = registry();
    // Build up a confident estimate for acct1…
    for (i, (model, used)) in [
        ("claude-fable-5", 10.0),
        ("claude-fable-5", 12.0),
        ("claude-haiku-4-5", 13.0),
        ("claude-fable-5", 15.0),
    ]
    .iter()
    .enumerate()
    {
        s.write(
            "claude-acct1.json",
            &tap_file(model, 30.0, *used, now - 400 + (i as i64) * 60, "acct1"),
        );
        build(&s.0, &reg, None, now - 400 + (i as i64) * 60).unwrap();
    }
    // …then the tap file disappears (session gone, file cleaned up).
    std::fs::remove_file(s.0.join("claude-acct1.json")).unwrap();
    let l = build(&s.0, &reg, None, now).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(r.note_codes, vec![CODE_NO_CAPTURE]);
    assert_eq!(
        r.fable_weekly_estimate_pct, None,
        "no live-looking bar next to 'no capture yet'"
    );
    assert_eq!(r.fable_weekly_samples, None);
    // The history stays inspectable in the detail breakdown.
    let fw = &r.detail.as_ref().unwrap()["fableWeekly"];
    assert_eq!(fw["samples"], 3);
    assert_eq!(fw["fablePct"], 4.0);
}

// ─────────────────────── HED-150 pt2: exact OAuth Fable % sidecar ───────────────────────

#[test]
fn a_fresh_oauth_sidecar_surfaces_the_exact_fable_pct_and_drops_the_estimate_flag() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-exact");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write("claude-acct1.oauth-usage.json", &oauth_file(77.0, now - 30));
    let l = build(&s.0, &reg, None, now).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(r.fable_weekly_estimate_pct, Some(77.0));
    let fw = &r.detail.as_ref().unwrap()["fableWeekly"];
    assert_eq!(fw["exact"], true);
    assert_eq!(fw["fablePct"], 77.0);
}

#[test]
fn exact_survives_a_tap_only_capture_while_the_sidecar_stays_fresh() {
    // The anti-flicker guarantee: a statusline tap carries no Fable field, so a tap-only capture
    // must not demote the drawer from exact back to the heuristic estimate while the OAuth sidecar
    // is still fresh (HED-150 pt2) — attribute() has to re-stamp exact_fable_pct on every call, not
    // only when the sidecar itself changes.
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-anti-flicker");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write("claude-acct1.oauth-usage.json", &oauth_file(77.0, now - 60));
    let l = build(&s.0, &reg, None, now).unwrap();
    assert_eq!(
        l.accounts.as_ref().unwrap()[0].fable_weekly_estimate_pct,
        Some(77.0)
    );

    // A later tap-only capture: different model, new seven_day% — the sidecar file itself is
    // untouched (still fresh, same reading).
    s.write(
        "claude-acct1.json",
        &tap_file("claude-haiku-4-5", 32.0, 26.0, now + 30, "acct1"),
    );
    let l = build(&s.0, &reg, None, now + 30).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(
        r.fable_weekly_estimate_pct,
        Some(77.0),
        "must not demote to the estimator"
    );
    assert_eq!(r.detail.as_ref().unwrap()["fableWeekly"]["exact"], true);
}

#[test]
fn tap_absent_with_a_fresh_sidecar_still_surfaces_the_exact_value() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-no-tap");
    let reg = registry();
    // No claude-acct1.json (no tap, no keeper anchor) — only the OAuth sidecar.
    s.write("claude-acct1.oauth-usage.json", &oauth_file(55.0, now - 10));
    let l = build(&s.0, &reg, None, now).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(r.fable_weekly_estimate_pct, Some(55.0));
    assert_eq!(r.detail.as_ref().unwrap()["fableWeekly"]["exact"], true);
    // The 5h/7d windows stay unknown — the sidecar never substitutes for a tap capture there.
    assert_eq!(r.five_hour, LimitWindow::default());
    assert_eq!(r.seven_day, LimitWindow::default());
}

#[test]
fn a_stale_oauth_sidecar_is_ignored_and_the_estimator_path_still_runs() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-stale");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 30.0, 10.0, now, "acct1"),
    );
    // Captured well beyond OAUTH_EXACT_STALE_AFTER_SECS before `now`.
    s.write(
        "claude-acct1.oauth-usage.json",
        &oauth_file(77.0, now - OAUTH_EXACT_STALE_AFTER_SECS - 100),
    );
    let l = build(&s.0, &reg, None, now).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(
        r.fable_weekly_estimate_pct, None,
        "stale sidecar must not force exact (too few samples for the estimator yet either)"
    );
    let fw = &r.detail.as_ref().unwrap()["fableWeekly"];
    assert_eq!(fw["exact"], false);
    assert_eq!(fw["fablePct"], 0.0);
}

#[test]
fn a_new_window_resets_the_exact_share_via_the_sidecars_own_reset() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-new-window");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 120, "acct1"),
    );
    s.write(
        "claude-acct1.oauth-usage.json",
        &oauth_file_with_window(40.0, now - 120, 1_786_892_400),
    );
    let l = build(&s.0, &reg, None, now - 120).unwrap();
    assert_eq!(
        l.accounts.as_ref().unwrap()[0].fable_weekly_estimate_pct,
        Some(40.0)
    );

    // A new weekly window: the sidecar's OWN windowResetsAt moves (the tap's hardcoded resets_at in
    // `tap_file` does not) — the new, lower share must not be blended with the old window's 40%.
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 1.0, now, "acct1"),
    );
    s.write(
        "claude-acct1.oauth-usage.json",
        &oauth_file_with_window(5.0, now, 1_786_892_400 + 7 * 86_400),
    );
    let l = build(&s.0, &reg, None, now).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(
        r.fable_weekly_estimate_pct,
        Some(5.0),
        "re-adopts, doesn't blend"
    );
    assert_eq!(
        r.detail.as_ref().unwrap()["fableWeekly"]["windowResetsAt"],
        1_786_892_400 + 7 * 86_400
    );
}

// ───────────────── HED-150 pt2, review round 2: sidecar hygiene + demotion ─────────────────

/// The keeper writes several per-account sidecars next to the tap files. None of them is an account:
/// `claude-acct1.oauth-usage.json` strips to the id `acct1.oauth-usage`, and (unlike the others) it
/// carries a `capturedAt`, so the unregistered-file scan used to surface it as a phantom row and
/// inflate the drawer's account count.
#[test]
fn keeper_sidecars_are_never_mistaken_for_unregistered_account_rows() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-phantom");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write("claude-acct1.oauth-usage.json", &oauth_file(77.0, now - 30));
    // Both other sidecars given a FRESH `capturedAt`, so only the name keeps them out of the roster —
    // the keeper anchor stays older than the tap so it doesn't also change acct1's windows.
    s.write(
        "claude-acct1.keeper.json",
        &format!(
            r#"{{"account":"acct1","startedAt":{},"capturedAt":{},"resets_at":{},"used":null}}"#,
            now - 90,
            now - 90,
            now + 5 * 3600
        ),
    );
    s.write(
        "claude-acct1.turns.json",
        &format!(
            r#"{{"account":"acct1","capturedAt":{},"turns":3}}"#,
            now - 30
        ),
    );
    let l = build(&s.0, &reg, None, now).unwrap();
    let rows = l.accounts.unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["acct1", "acct2", "acct3", "acct4"], "no phantom rows");
    assert_eq!(l.model.as_deref(), Some("claude-fable-5 · 4 acct"));
    // The real row is unaffected: still exact, still its own tap windows.
    assert_eq!(rows[0].fable_weekly_estimate_pct, Some(77.0));
    assert_eq!(rows[0].five_hour.used_percentage, Some(32.0));
}

/// THE round-2 regression: once a fresh sidecar set `exact`, a sidecar that then goes stale while
/// the tap capture is UNCHANGED used to leave `exact` true forever — the unchanged capture is
/// dropped by `already_ingested()` before `ingest()`'s demotion branch can run, so the old
/// percentage kept being published as an exact reading after the keeper stopped refreshing.
#[test]
fn a_sidecar_gone_stale_demotes_exact_even_when_the_tap_capture_is_unchanged() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-demote");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write("claude-acct1.oauth-usage.json", &oauth_file(77.0, now - 30));
    let l = build(&s.0, &reg, None, now).unwrap();
    assert_eq!(
        l.accounts.as_ref().unwrap()[0].fable_weekly_estimate_pct,
        Some(77.0)
    );
    assert!(persisted_attrib(&s, "acct1").exact);

    // The keeper stops refreshing: the sidecar ages out while the tap file is byte-identical, so no
    // new capture arrives to carry the demotion.
    let later = now + OAUTH_EXACT_STALE_AFTER_SECS + 60;
    let l = build(&s.0, &reg, None, later).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    let fw = &r.detail.as_ref().unwrap()["fableWeekly"];
    assert_eq!(
        fw["exact"], false,
        "a stale sidecar cannot still claim exact"
    );
    assert_eq!(
        r.fable_weekly_estimate_pct, None,
        "the old percentage must not survive as a live number"
    );
    // Demoted like `seed_from_exact`: the last exact share seeds the books (capped by the
    // account-wide total), confidence restarts, and the demotion is PERSISTED so a fresh process
    // can't resurrect it.
    let p = persisted_attrib(&s, "acct1");
    assert!(!p.exact);
    assert_eq!((p.fable_pct, p.samples), (24.0, 0));
    assert_eq!(p.window_resets_at, Some(1_786_892_400));
    // Deleting the sidecar outright keeps it demoted (and doesn't re-enter exact mode).
    std::fs::remove_file(s.0.join("claude-acct1.oauth-usage.json")).unwrap();
    let l = build(&s.0, &reg, None, later + 60).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(r.detail.as_ref().unwrap()["fableWeekly"]["exact"], false);
    assert_eq!(r.fable_weekly_estimate_pct, None);
}

/// The keeper names the sidecar with `safe_segment()`, so an id carrying out-of-class characters is
/// written as `claude-team_a.oauth-usage.json` — reading the raw id finds nothing at all.
#[test]
fn the_oauth_sidecar_is_read_through_the_keepers_own_filename_sanitizing() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-safe-segment");
    let reg = vec![Account {
        id: "team:a".to_string(),
        config_dir: None,
        email: None,
        logged_in: None,
    }];
    s.write(
        "claude-team_a.oauth-usage.json",
        &oauth_file(42.0, now - 30),
    );
    let l = build(&s.0, &reg, None, now).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(r.id, "team:a");
    assert_eq!(r.fable_weekly_estimate_pct, Some(42.0));
    assert_eq!(r.detail.as_ref().unwrap()["fableWeekly"]["exact"], true);
    // The mapping itself, against the keeper's `[^A-Za-z0-9._-] → _`.
    assert_eq!(safe_segment("team:a"), "team_a");
    assert_eq!(safe_segment("acct1"), "acct1");
    assert_eq!(safe_segment("ok.id-1_2"), "ok.id-1_2");
    assert_eq!(safe_segment("a/../b"), "a_.._b");
}

/// A `capturedAt` in the future is clock skew or corruption; the age test alone reads it as "captured
/// moments ago" and would pin that reading as exact indefinitely.
#[test]
fn a_sidecar_captured_in_the_future_is_ignored_rather_than_treated_as_fresh() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-future");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 30.0, 10.0, now, "acct1"),
    );
    s.write(
        "claude-acct1.oauth-usage.json",
        &oauth_file(77.0, now + 3600),
    );
    let l = build(&s.0, &reg, None, now).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(r.detail.as_ref().unwrap()["fableWeekly"]["exact"], false);
    assert_eq!(r.fable_weekly_estimate_pct, None);
}

/// The freshness bound follows the keeper's configured refresh cadence: with a bigger
/// `HEDDLE_OAUTH_CACHE_SECS`, a legitimately older sidecar must not be demoted between refreshes.
#[test]
fn the_freshness_bound_follows_the_keepers_configured_cache_interval() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-cache-secs");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    // ~20 minutes old: past the 900s floor, but well inside three cycles of an hourly cache.
    s.write(
        "claude-acct1.oauth-usage.json",
        &oauth_file(77.0, now - 1_200),
    );
    let l = build(&s.0, &reg, None, now).unwrap();
    assert_eq!(
        l.accounts.as_ref().unwrap()[0].fable_weekly_estimate_pct,
        None,
        "stale under the default 900s bound"
    );

    let _cache = CacheSecs::set("3600");
    let l = build(&s.0, &reg, None, now).unwrap();
    let r = &l.accounts.as_ref().unwrap()[0];
    assert_eq!(
        r.fable_weekly_estimate_pct,
        Some(77.0),
        "a keeper told to cache for an hour makes this sidecar fresh"
    );
    assert_eq!(r.detail.as_ref().unwrap()["fableWeekly"]["exact"], true);
    assert_eq!(oauth_exact_stale_after_secs(), 10_800);
    drop(_cache);
    assert_eq!(oauth_exact_stale_after_secs(), OAUTH_EXACT_STALE_AFTER_SECS);
}

/// The env→bound mapping itself: floored at the const, three keeper cycles above it, clamped to the
/// keeper's own maximum, and never widened by a value the keeper wouldn't honour either.
#[test]
fn the_freshness_bound_floors_clamps_and_ignores_unusable_config() {
    assert_eq!(oauth_exact_stale_after_secs(), OAUTH_EXACT_STALE_AFTER_SECS);
    for (cache, want) in [
        ("60", OAUTH_EXACT_STALE_AFTER_SECS),
        ("300", OAUTH_EXACT_STALE_AFTER_SECS),
        (" 3600 ", 10_800),
        ("999999", OAUTH_CACHE_MAX_SECS * 3),
        ("-5", OAUTH_EXACT_STALE_AFTER_SECS),
        ("not-a-number", OAUTH_EXACT_STALE_AFTER_SECS),
        ("", OAUTH_EXACT_STALE_AFTER_SECS),
    ] {
        let _c = CacheSecs::set(cache);
        assert_eq!(
            oauth_exact_stale_after_secs(),
            want,
            "HEDDLE_OAUTH_CACHE_SECS={cache:?}"
        );
    }
    assert_eq!(
        oauth_exact_stale_after_secs(),
        OAUTH_EXACT_STALE_AFTER_SECS,
        "cleared once the guards drop"
    );
}

/// Stamping the sidecar's value onto every tap capture must not turn into a write per render: the
/// tap re-renders many times a minute per active account, and the exact % it carries rarely moves.
#[test]
fn an_unchanged_exact_value_does_not_rewrite_the_attrib_file_on_every_tap() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-no-rewrite");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now - 60, "acct1"),
    );
    s.write("claude-acct1.oauth-usage.json", &oauth_file(77.0, now - 30));
    build(&s.0, &reg, None, now).unwrap();
    let attrib = s.0.join("claude-acct1.attrib.json");
    let after_first = std::fs::read_to_string(&attrib).unwrap();

    // A later render: same account-wide reading, same exact %, only `capturedAt` moved. (A rewrite
    // would show up in the file's own `updatedAt`/`lastCapturedAt`.)
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now + 30, "acct1"),
    );
    let l = build(&s.0, &reg, None, now + 30).unwrap();
    assert_eq!(
        std::fs::read_to_string(&attrib).unwrap(),
        after_first,
        "a bare timestamp bump must not rewrite the attribution file"
    );
    assert_eq!(
        l.accounts.as_ref().unwrap()[0].fable_weekly_estimate_pct,
        Some(77.0),
        "…and the value is still surfaced from the in-memory state"
    );

    // The exact VALUE moving still persists, immediately.
    s.write("claude-acct1.oauth-usage.json", &oauth_file(78.0, now + 40));
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 24.0, now + 60, "acct1"),
    );
    let l = build(&s.0, &reg, None, now + 60).unwrap();
    assert_eq!(
        l.accounts.as_ref().unwrap()[0].fable_weekly_estimate_pct,
        Some(78.0)
    );
    let p = persisted_attrib(&s, "acct1");
    assert!(p.exact);
    assert_eq!(p.fable_pct, 78.0);
    // …as does the account-wide reading moving, which seeds a later demotion.
    s.write("claude-acct1.oauth-usage.json", &oauth_file(78.0, now + 70));
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 32.0, 26.0, now + 90, "acct1"),
    );
    build(&s.0, &reg, None, now + 90).unwrap();
    assert_eq!(persisted_attrib(&s, "acct1").last_used_pct, Some(26.0));
}

#[test]
fn malformed_or_out_of_range_fable_pct_in_the_sidecar_is_ignored_without_panicking() {
    let now = 1_786_830_900;
    let s = Scratch::new("oauth-malformed");
    let reg = registry();
    s.write(
        "claude-acct1.json",
        &tap_file("claude-fable-5", 30.0, 10.0, now, "acct1"),
    );
    for bad in [
        r#"{"fablePct":-5.0,"capturedAt":REPL,"source":"oauth-usage"}"#,
        r#"{"fablePct":150.0,"capturedAt":REPL,"source":"oauth-usage"}"#,
        r#"{"fablePct":"not-a-number","capturedAt":REPL,"source":"oauth-usage"}"#,
        r#"{"fablePct":NaN,"capturedAt":REPL,"source":"oauth-usage"}"#,
    ] {
        let body = bad.replace("REPL", &now.to_string());
        s.write("claude-acct1.oauth-usage.json", &body);
        let l = build(&s.0, &reg, None, now).unwrap();
        let r = &l.accounts.as_ref().unwrap()[0];
        assert_eq!(
            r.detail.as_ref().unwrap()["fableWeekly"]["exact"],
            false,
            "malformed sidecar {body:?} must not flip exact on"
        );
    }
}
