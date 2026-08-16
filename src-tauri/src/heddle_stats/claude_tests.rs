//! Unit tests for `claude.rs` (kept in a sibling file so the source file stays readable).

use super::*;

/// The registry shape the tap and window-keeper use (fake identities).
const REGISTRY: &str = r#"{
  "claude": [
    {"id": "acct1", "configDir": null, "email": "one@example.com", "loggedIn": true},
    {"id": "acct2", "configDir": "/tmp/heddle-claude-tests/.claude-acct2", "email": "two@example.org", "loggedIn": true},
    {"id": "acct3", "configDir": "/tmp/heddle-claude-tests/.claude-acct3", "email": "three@example.net", "loggedIn": true}
  ]
}"#;

fn tap_file(model: &str, five: f64, seven: f64, captured: i64, acct: &str) -> String {
    format!(
        r#"{{"model":"{model}","rate_limits":{{"five_hour":{{"used_percentage":{five},"resets_at":1786846200}},"seven_day":{{"used_percentage":{seven},"resets_at":1786892400}}}},"capturedAt":{captured},"account":"{acct}","configDir":null}}"#
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

#[test]
fn registry_parses_ids_config_dirs_and_emails() {
    let r = registry();
    assert_eq!(r.len(), 3);
    assert_eq!(r[0].id, "acct1");
    assert_eq!(r[0].config_dir, None);
    assert_eq!(
        r[1].config_dir.as_deref(),
        Some(Path::new("/tmp/heddle-claude-tests/.claude-acct2"))
    );
    assert_eq!(r[2].email.as_deref(), Some("three@example.net"));
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
    assert_eq!(l.model.as_deref(), Some("claude-fable-5 · 3 acct"));
    assert_eq!(l.active_account.as_deref(), Some("acct1"));
    assert_eq!(l.five_hour.used_percentage, Some(32.0));
    assert_eq!(l.source.as_deref(), Some("statusline-tap"));
    assert_eq!(l.stale, Some(false));
    let rows = l.accounts.unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].id, "acct1");
    assert_eq!(rows[0].label, "o…@example.com");
    assert_eq!(rows[0].five_hour.used_percentage, Some(32.0));
    assert_eq!(rows[0].captured_at, Some(now - 60));
    assert_eq!(rows[0].stale, Some(false));
    assert_eq!(rows[0].limit_reached, Some(false));
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
    // Full emails never leak.
    let js = serde_json::to_string(&rows).unwrap();
    assert!(
        !js.contains("one@") && !js.contains("two@") && !js.contains("three@"),
        "{js}"
    );
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
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[3].id, "unknown-claude-x");
    assert_eq!(rows[3].label, "unknown-claude-x");
    assert_eq!(rows[3].five_hour.used_percentage, Some(3.0));
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
    // acct1 is the active account → the same numbers ride on the top level.
    assert_eq!(l.active_account.as_deref(), Some("acct1"));
    assert_eq!(l.fable_weekly_estimate_pct, Some(4.0));
    assert_eq!(l.fable_weekly_samples, Some(3));
    // Other accounts (no capture) carry no estimate.
    assert_eq!(
        l.accounts.as_ref().unwrap()[1].fable_weekly_estimate_pct,
        None
    );
    // Re-polling the SAME capture doesn't double count.
    let l = build(&s.0, &reg, None, now).unwrap();
    assert_eq!(l.accounts.unwrap()[0].fable_weekly_samples, Some(3));
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
