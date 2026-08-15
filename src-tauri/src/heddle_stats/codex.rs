//! Codex/GPT caps from `claudex-usage`'s cache (`~/.local/state/claudex-usage-cache.json`).
//!
//! `claudex-usage` (Maya's claude-hud helper, `~/.local/bin/claudex-usage`) polls
//! `chatgpt.com/backend-api/wham/usage` — the endpoint the native Codex CLI uses for `/status` —
//! once per ChatGPT account and caches `{fetched_at, mode, payload}`:
//!   - `mode: "lb"` → `payload` is `[{email, data: <wham response | null>}, …]`, one entry per
//!     account behind the claudex round-robin LB (2 accounts today).
//!   - `mode: "raine"` → `payload` is the single account's wham response itself (legacy proxy).
//!
//! We surface BOTH the binding view (max used % per window across accounts — the account nearest a
//! wall is what limits you) and one row per account (masked email, plan, its own windows), plus
//! `additional_rate_limits` (per-model buckets such as "GPT-5.3-Codex-Spark") as named windows.
//!
//! WINDOWS: wham reports `primary_window` / `secondary_window` with `limit_window_seconds`; we map
//! them to 5h / 7d by length, so whichever the provider sends lands in the right slot. As of
//! 2026-08 OpenAI exposes ONLY the 7-day window (`primary_window` = 604800s, `secondary_window`
//! null) — the 5h window is gone from the payload. Nothing here hard-codes that: if a 5-hour window
//! reappears in either slot it is shown again automatically, and the "no 5h window" note goes away.
//!
//! FRESHNESS: the cache carries `fetched_at`; claudex-usage refreshes it (detached child, TTL 60s)
//! whenever a claudex session renders. We kick the same refresh when it is >90s old so it stays live
//! without a claudex session, and flag the entry `stale` when it hasn't refreshed in 5 minutes
//! (network down, expired login, helper missing).

use serde_json::Value;

use super::{
    augmented_path, home, is_stale, mask_email, AccountLimit, LimitWindow, NamedWindow,
    ProviderLimit,
};

/// claudex-usage's cache file, relative to `$HOME`.
const CACHE_REL: &str = ".local/state/claudex-usage-cache.json";
/// claudex-usage's refresh helper, relative to `$HOME`.
const HELPER_REL: &str = ".local/bin/claudex-usage";
/// Kick `claudex-usage --refresh lb` when the cache is older than this (claudex's own TTL is 60s).
const REFRESH_AFTER_SECS: f64 = 90.0;
/// Flag the entry stale when the cache hasn't managed to refresh in this long.
pub(super) const STALE_AFTER_SECS: i64 = 300;
/// wham reports window lengths in seconds: anything shorter than this is the 5-hour bucket, anything
/// longer is the 7-day bucket (5h = 18 000s, 7d = 604 800s).
const FIVE_HOUR_MAX_SECS: i64 = 100_000;

pub(super) const SOURCE: &str = "claudex-usage-cache";
/// Shown while no account reports a 5-hour window (the 2026-08 provider state).
pub(super) const NO_5H_NOTE: &str =
    "no 5h window in wham/usage — OpenAI currently exposes only the \
                                     7d window (secondary_window null); it reappears here \
                                     automatically if the provider restores it";
/// Shown when the cache exists but no account has any usage data (every fetch failed).
pub(super) const NO_DATA_NOTE: &str =
    "claudex-usage cache has no usage data for any account (all wham/usage fetches failed — expired \
     login or network?)";

/// Read the cache, kick a refresh if it is getting old, and return the Codex entry.
/// `None` when there is no cache at all (claudex-usage never ran here).
pub(super) fn limit(now: i64) -> Option<ProviderLimit> {
    let text = std::fs::read_to_string(home().join(CACHE_REL)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    maybe_refresh(&v, now);
    parse_cache(&v, now)
}

/// Self-refresh: if the cache is older than `REFRESH_AFTER_SECS`, run `claudex-usage --refresh lb`
/// detached (best-effort, output discarded) so the NEXT poll reads fresh data. The dashboard never
/// blocks on the network. Always refreshes the LB (multi-account) mode, which is what heddle routes
/// through; the raine mode is legacy.
fn maybe_refresh(v: &Value, now: i64) {
    let Some(fetched) = v["fetched_at"].as_f64() else {
        return;
    };
    if (now as f64) - fetched <= REFRESH_AFTER_SECS {
        return;
    }
    let _ = std::process::Command::new(home().join(HELPER_REL))
        .args(["--refresh", "lb"])
        .env("PATH", augmented_path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// Pure parse of a claudex-usage cache document. `now` is epoch seconds (injected for tests).
pub(super) fn parse_cache(v: &Value, now: i64) -> Option<ProviderLimit> {
    let mode = v["mode"].as_str().unwrap_or("lb");
    // (label, wham response) per account.
    let raw: Vec<(String, &Value)> = match &v["payload"] {
        Value::Array(list) => list
            .iter()
            .enumerate()
            .map(|(i, acct)| (account_label(acct["email"].as_str(), i), &acct["data"]))
            .collect(),
        obj @ Value::Object(_) => vec![(account_label(obj["email"].as_str(), 0), obj)],
        _ => return None,
    };
    if raw.is_empty() {
        return None;
    }
    let accounts: Vec<AccountLimit> = raw
        .into_iter()
        .map(|(label, data)| account_from_wham(label, data))
        .collect();

    let five_hour = binding(accounts.iter().map(|a| &a.five_hour));
    let seven_day = binding(accounts.iter().map(|a| &a.seven_day));
    let windows = binding_named(&accounts);
    let captured_at = v["fetched_at"].as_f64().map(|f| f as i64);

    let any_data = accounts
        .iter()
        .any(|a| a.five_hour.used_percentage.is_some() || a.seven_day.used_percentage.is_some());
    let any_5h = accounts
        .iter()
        .any(|a| a.five_hour.used_percentage.is_some());
    let mut notes: Vec<String> = Vec::new();
    if !any_data {
        notes.push(NO_DATA_NOTE.to_string());
    } else if !any_5h {
        notes.push(NO_5H_NOTE.to_string());
    }
    if mode != "lb" {
        notes.push(format!("cache is in '{mode}' mode (single legacy account)"));
    }

    Some(ProviderLimit {
        provider: "codex".to_string(),
        model: Some(format!("chatgpt · {} acct", accounts.len())),
        captured_at,
        five_hour,
        seven_day,
        source: Some(SOURCE.to_string()),
        stale: is_stale(captured_at, now, STALE_AFTER_SECS),
        stale_after_secs: Some(STALE_AFTER_SECS),
        note: if notes.is_empty() {
            None
        } else {
            Some(notes.join("; "))
        },
        accounts: Some(accounts),
        windows: Some(windows),
    })
}

/// Masked email when claudex-usage recorded one, else a positional label ("acct 2").
fn account_label(email: Option<&str>, index: usize) -> String {
    match email {
        Some(e) if !e.is_empty() && e != "?" && e.contains('@') => mask_email(e),
        _ => format!("acct {}", index + 1),
    }
}

/// One account row from its wham/usage response (or null when claudex-usage's fetch failed).
fn account_from_wham(label: String, data: &Value) -> AccountLimit {
    if !data.is_object() {
        return AccountLimit {
            label,
            plan: None,
            five_hour: LimitWindow::default(),
            seven_day: LimitWindow::default(),
            windows: Vec::new(),
            limit_reached: None,
            note: Some(
                "no data — claudex-usage's wham/usage fetch failed for this account (expired login?)"
                    .to_string(),
            ),
        };
    }
    let rl = &data["rate_limit"];
    let (five_hour, seven_day) = windows_from_rate_limit(rl);
    let mut windows = Vec::new();
    if let Some(extra) = data["additional_rate_limits"].as_array() {
        for e in extra {
            let name = e["limit_name"].as_str().unwrap_or("additional limit");
            let (f, s) = windows_from_rate_limit(&e["rate_limit"]);
            for (win, tag) in [(f, "5h"), (s, "7d")] {
                if win.used_percentage.is_none() {
                    continue;
                }
                windows.push(NamedWindow {
                    id: format!("{}-{tag}", slug(name)),
                    label: format!("{name} {tag}"),
                    used_percentage: win.used_percentage,
                    resets_at: win.resets_at,
                    used_amount: None,
                    limit_amount: None,
                    unit: None,
                });
            }
        }
    }
    let mut notes: Vec<&str> = Vec::new();
    if rl["limit_reached"].as_bool() == Some(true) {
        notes.push("rate limit reached");
    }
    if data["spend_control"]["reached"].as_bool() == Some(true) {
        notes.push("spend control reached");
    }
    if data["credits"]["overage_limit_reached"].as_bool() == Some(true) {
        notes.push("overage limit reached");
    }
    AccountLimit {
        label,
        plan: data["plan_type"].as_str().map(str::to_string),
        five_hour,
        seven_day,
        windows,
        limit_reached: rl["limit_reached"].as_bool(),
        note: if notes.is_empty() {
            None
        } else {
            Some(notes.join("; "))
        },
    }
}

/// Route wham's primary/secondary windows into (5h, 7d) slots by window length. A missing or null
/// window leaves its slot empty; whichever slot the provider populates is what we show.
fn windows_from_rate_limit(rl: &Value) -> (LimitWindow, LimitWindow) {
    let mut five = LimitWindow::default();
    let mut seven = LimitWindow::default();
    for key in ["primary_window", "secondary_window"] {
        let w = &rl[key];
        if !w.is_object() {
            continue;
        }
        let secs = w["limit_window_seconds"].as_i64().unwrap_or(0);
        let win = LimitWindow {
            used_percentage: w["used_percent"].as_f64(),
            resets_at: w["reset_at"].as_i64(),
        };
        if secs < FIVE_HOUR_MAX_SECS {
            five = win;
        } else {
            seven = win;
        }
    }
    (five, seven)
}

/// The binding view of one window across accounts: the highest used % wins (with that account's
/// reset time). Accounts without the window don't participate.
fn binding<'a>(windows: impl Iterator<Item = &'a LimitWindow>) -> LimitWindow {
    let mut best = LimitWindow::default();
    for w in windows {
        if w.used_percentage.unwrap_or(-1.0) > best.used_percentage.unwrap_or(-1.0) {
            best = w.clone();
        }
    }
    best
}

/// Binding view of the named (additional) windows: per `id`, the account with the highest used %.
/// Order follows first appearance so the drawer is stable between polls.
fn binding_named(accounts: &[AccountLimit]) -> Vec<NamedWindow> {
    let mut out: Vec<NamedWindow> = Vec::new();
    for w in accounts.iter().flat_map(|a| a.windows.iter()) {
        match out.iter_mut().find(|o| o.id == w.id) {
            Some(existing) => {
                if w.used_percentage.unwrap_or(-1.0) > existing.used_percentage.unwrap_or(-1.0) {
                    *existing = w.clone();
                }
            }
            None => out.push(w.clone()),
        }
    }
    out
}

/// "GPT-5.3-Codex-Spark" → "gpt-5-3-codex-spark": a stable id for a provider-named bucket.
fn slug(name: &str) -> String {
    let mut s = String::with_capacity(name.len());
    let mut last_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            s.push('-');
            last_dash = true;
        }
    }
    s.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn binding_view_is_the_max_across_accounts_with_that_accounts_reset() {
        let l = parse(LB_2_ACCOUNTS, 1_786_822_400);
        assert_eq!(l.provider, "codex");
        assert_eq!(l.model.as_deref(), Some("chatgpt · 2 acct"));
        assert_eq!(l.source.as_deref(), Some(SOURCE));
        // acct 1 is at 5% (reset 1787343662), acct 2 at 1% (reset 1787333190) → acct 1 binds.
        assert_eq!(l.seven_day.used_percentage, Some(5.0));
        assert_eq!(l.seven_day.resets_at, Some(1_787_343_662));
        // No 5h window anywhere in the payload → empty slot + the explanatory note.
        assert_eq!(l.five_hour, LimitWindow::default());
        assert!(l.note.as_deref().unwrap_or("").contains("no 5h window"));
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
        assert_eq!(accounts[1].label, "b…@example.org");
        assert_eq!(accounts[1].plan.as_deref(), Some("pro"));
        assert_eq!(accounts[1].seven_day.used_percentage, Some(1.0));
        assert_eq!(accounts[1].seven_day.resets_at, Some(1_787_333_190));
        // The full email must never leak into the payload.
        let json = serde_json::to_string(&accounts).unwrap();
        assert!(!json.contains("alice@") && !json.contains("bob@"), "{json}");
    }

    #[test]
    fn additional_rate_limits_become_named_windows_binding_across_accounts() {
        let l = parse(LB_2_ACCOUNTS, 1_786_822_400);
        let windows = l.windows.expect("named windows");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].id, "gpt-5-3-codex-spark-7d");
        assert_eq!(windows[0].label, "GPT-5.3-Codex-Spark 7d");
        // acct 2 has used 12% of the Spark bucket vs acct 1's 0% → acct 2 binds.
        assert_eq!(windows[0].used_percentage, Some(12.0));
        assert_eq!(windows[0].resets_at, Some(1_787_427_150));
        let accounts = l.accounts.unwrap();
        assert_eq!(accounts[0].windows[0].used_percentage, Some(0.0));
        assert_eq!(accounts[1].windows[0].used_percentage, Some(12.0));
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
        let accounts = l.accounts.unwrap();
        assert_eq!(accounts[0].five_hour.used_percentage, Some(37.0));
        assert_eq!(accounts[1].five_hour, LimitWindow::default());
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
        // The healthy account still binds.
        assert_eq!(l.seven_day.used_percentage, Some(5.0));
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

    #[test]
    fn slug_is_stable_and_lowercase() {
        assert_eq!(slug("GPT-5.3-Codex-Spark"), "gpt-5-3-codex-spark");
        assert_eq!(slug("  weird  name!! "), "weird-name");
    }
}
