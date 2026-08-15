//! Codex/GPT caps from `claudex-usage`'s cache (`~/.local/state/claudex-usage-cache.json`).
//!
//! `claudex-usage` (Maya's claude-hud helper, `~/.local/bin/claudex-usage`) polls
//! `chatgpt.com/backend-api/wham/usage` — the endpoint the native Codex CLI uses for `/status` —
//! once per ChatGPT account and caches `{fetched_at, mode, payload}`:
//!   - `mode: "lb"` → `payload` is `[{email, data: <wham response | null>}, …]`, one entry per
//!     account behind the claudex round-robin LB (2 accounts today).
//!   - `mode: "raine"` → `payload` is the single account's wham response itself (legacy proxy;
//!     `write_cache(mode, payload)` with `payload = wham(...)` in the helper's source).
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
//! without a claudex session (one child at a time, reaped, at most once a minute), and flag the
//! entry `stale` when it hasn't refreshed in 5 minutes (network down, expired login, helper missing).

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

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
/// Never kick more often than this, even if the cache never advances (helper broken / offline) —
/// otherwise a 30s poll would spawn a failing child every tick.
const KICK_COOLDOWN_SECS: i64 = 60;
/// Flag the entry stale when the cache hasn't managed to refresh in this long.
pub(super) const STALE_AFTER_SECS: i64 = 300;
/// wham reports window lengths in seconds: anything shorter than this is the 5-hour bucket, anything
/// longer is the 7-day bucket (5h = 18 000s, 7d = 604 800s).
const FIVE_HOUR_MAX_SECS: i64 = 100_000;

pub(super) const SOURCE: &str = "claudex-usage-cache";

// Note codes (the localizable key layer for `note`) and their English rendering.
pub(super) const CODE_NO_5H: &str = "codex.no5hWindow";
pub(super) const CODE_NO_DATA: &str = "codex.noData";
pub(super) const CODE_LEGACY_MODE: &str = "codex.legacyMode";
pub(super) const CODE_ACCOUNT_FETCH_FAILED: &str = "codex.accountFetchFailed";
pub(super) const CODE_RATE_LIMIT_REACHED: &str = "codex.rateLimitReached";
pub(super) const CODE_SPEND_CONTROL_REACHED: &str = "codex.spendControlReached";
pub(super) const CODE_OVERAGE_LIMIT_REACHED: &str = "codex.overageLimitReached";
/// Shown while no account reports a 5-hour window (the 2026-08 provider state). (A `\` at the end
/// of a line in a Rust string literal skips the newline AND the next line's leading whitespace,
/// so these read as single-spaced sentences — asserted in `notes_are_single_spaced`.)
pub(super) const NO_5H_NOTE: &str =
    "no 5h window in wham/usage — OpenAI currently exposes only the 7d window \
     (secondary_window null); it reappears here automatically if the provider restores it";
/// Shown when the cache exists but no account has any usage data (every fetch failed).
pub(super) const NO_DATA_NOTE: &str =
    "claudex-usage cache has no usage data for any account (all wham/usage fetches failed — expired \
     login or network?)";

static REFRESHING: AtomicBool = AtomicBool::new(false);
static LAST_KICK_AT: AtomicI64 = AtomicI64::new(0);

/// Read the cache, kick a refresh if it is getting old, and return the Codex entry.
/// `None` when there is no cache at all (claudex-usage never ran here).
pub(super) fn limit(now: i64) -> Option<ProviderLimit> {
    let text = std::fs::read_to_string(home().join(CACHE_REL)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    maybe_refresh(&v, now);
    parse_cache(&v, now)
}

/// Self-refresh: if the cache is older than `REFRESH_AFTER_SECS`, run `claudex-usage --refresh lb`
/// out-of-band so the NEXT poll reads fresh data. The dashboard never blocks on the network.
fn maybe_refresh(v: &Value, now: i64) {
    let Some(fetched) = v["fetched_at"].as_f64() else {
        return;
    };
    if (now as f64) - fetched > REFRESH_AFTER_SECS {
        kick_refresh(now, false);
    }
}

/// Kick `claudex-usage --refresh lb` regardless of cache age. `true` when a helper child was
/// started (not whether it succeeded — it writes the cache on its own; the next poll reads it).
pub(super) fn force_refresh(now: i64) -> bool {
    kick_refresh(now, true)
}

/// Start ONE helper child (a reaper thread waits on it, so it never zombies), skipping when one is
/// already in flight or — unless forced — when the last kick was under `KICK_COOLDOWN_SECS` ago.
/// Always refreshes the LB (multi-account) mode, which is what heddle routes through; raine is
/// legacy.
fn kick_refresh(now: i64, force: bool) -> bool {
    if !force && now - LAST_KICK_AT.load(Ordering::SeqCst) < KICK_COOLDOWN_SECS {
        return false;
    }
    if REFRESHING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    LAST_KICK_AT.store(now, Ordering::SeqCst);
    let child = std::process::Command::new(home().join(HELPER_REL))
        .args(["--refresh", "lb"])
        .env("PATH", augmented_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    std::thread::spawn(move || {
        if let Ok(mut c) = child {
            let _ = c.wait();
        }
        REFRESHING.store(false, Ordering::SeqCst);
    });
    true
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
    let (note_codes, note) = provider_notes(&accounts, mode);

    Some(ProviderLimit {
        provider: "codex".to_string(),
        model: Some(format!("chatgpt · {} acct", accounts.len())),
        captured_at,
        five_hour,
        seven_day,
        source: Some(SOURCE.to_string()),
        stale: is_stale(captured_at, now, STALE_AFTER_SECS),
        stale_after_secs: Some(STALE_AFTER_SECS),
        note,
        note_codes: Some(note_codes),
        accounts: Some(accounts),
        windows: Some(windows),
    })
}

/// Entry-level notes: no usage anywhere (every fetch failed), else no 5h window anywhere (the
/// current provider state), plus the legacy single-account mode.
fn provider_notes(accounts: &[AccountLimit], mode: &str) -> (Vec<String>, Option<String>) {
    let has_usage = |a: &AccountLimit| {
        a.five_hour.used_percentage.is_some()
            || a.seven_day.used_percentage.is_some()
            || a.windows.iter().any(|w| w.used_percentage.is_some())
    };
    let any_data = accounts.iter().any(has_usage);
    let any_5h = accounts
        .iter()
        .any(|a| a.five_hour.used_percentage.is_some());
    let mut codes = Vec::new();
    let mut texts: Vec<String> = Vec::new();
    if !any_data {
        codes.push(CODE_NO_DATA.to_string());
        texts.push(NO_DATA_NOTE.to_string());
    } else if !any_5h {
        codes.push(CODE_NO_5H.to_string());
        texts.push(NO_5H_NOTE.to_string());
    }
    if mode != "lb" {
        codes.push(CODE_LEGACY_MODE.to_string());
        texts.push(format!("cache is in '{mode}' mode (single legacy account)"));
    }
    (codes, join_notes(texts))
}

fn join_notes(texts: Vec<String>) -> Option<String> {
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("; "))
    }
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
            note_codes: vec![CODE_ACCOUNT_FETCH_FAILED.to_string()],
        };
    }
    let rl = &data["rate_limit"];
    let (five_hour, seven_day) = windows_from_rate_limit(rl);
    let (note_codes, note) = account_notes(data);
    AccountLimit {
        label,
        plan: data["plan_type"].as_str().map(str::to_string),
        five_hour,
        seven_day,
        windows: additional_windows(data),
        limit_reached: rl["limit_reached"].as_bool(),
        note,
        note_codes,
    }
}

/// `additional_rate_limits[]` (per-model buckets) → named windows. The id is the provider's stable
/// `metered_feature` key (falls back to a slug of the display name, then to the position) plus the
/// window tag, so two buckets with similar display names never merge in the binding view.
fn additional_windows(data: &Value) -> Vec<NamedWindow> {
    let mut windows = Vec::new();
    let Some(extra) = data["additional_rate_limits"].as_array() else {
        return windows;
    };
    for (i, e) in extra.iter().enumerate() {
        let name_opt = e["limit_name"].as_str().filter(|n| !n.trim().is_empty());
        let name = name_opt.unwrap_or("additional limit");
        let key = e["metered_feature"]
            .as_str()
            .map(str::to_string)
            .filter(|k| !k.is_empty())
            .or_else(|| name_opt.map(slug).filter(|s| !s.is_empty()))
            .unwrap_or_else(|| format!("additional-{i}"));
        let (f, s) = windows_from_rate_limit(&e["rate_limit"]);
        for (win, tag) in [(f, "5h"), (s, "7d")] {
            if win.used_percentage.is_none() {
                continue;
            }
            windows.push(NamedWindow {
                id: format!("{key}-{tag}"),
                label: format!("{name} {tag}"),
                used_percentage: win.used_percentage,
                resets_at: win.resets_at,
                used_amount: None,
                limit_amount: None,
                unit: None,
            });
        }
    }
    windows
}

/// Per-account status flags → (codes, English text).
fn account_notes(data: &Value) -> (Vec<String>, Option<String>) {
    let flags = [
        (
            data["rate_limit"]["limit_reached"].as_bool(),
            CODE_RATE_LIMIT_REACHED,
            "rate limit reached",
        ),
        (
            data["spend_control"]["reached"].as_bool(),
            CODE_SPEND_CONTROL_REACHED,
            "spend control reached",
        ),
        (
            data["credits"]["overage_limit_reached"].as_bool(),
            CODE_OVERAGE_LIMIT_REACHED,
            "overage limit reached",
        ),
    ];
    let mut codes = Vec::new();
    let mut texts = Vec::new();
    for (flag, code, text) in flags {
        if flag == Some(true) {
            codes.push(code.to_string());
            texts.push(text.to_string());
        }
    }
    (codes, join_notes(texts))
}

/// Route wham's primary/secondary windows into (5h, 7d) slots by window length. A window without a
/// positive `limit_window_seconds` can't be classified and is skipped (never forced into a slot);
/// if two windows land in the same slot the higher used % wins, matching the binding rule.
fn windows_from_rate_limit(rl: &Value) -> (LimitWindow, LimitWindow) {
    let mut five = LimitWindow::default();
    let mut seven = LimitWindow::default();
    for key in ["primary_window", "secondary_window"] {
        let w = &rl[key];
        let Some(secs) = w["limit_window_seconds"].as_i64().filter(|s| *s > 0) else {
            continue;
        };
        let win = LimitWindow {
            used_percentage: w["used_percent"].as_f64(),
            resets_at: w["reset_at"].as_i64(),
        };
        let slot = if secs < FIVE_HOUR_MAX_SECS {
            &mut five
        } else {
            &mut seven
        };
        if win.used_percentage.unwrap_or(-1.0) > slot.used_percentage.unwrap_or(-1.0) {
            *slot = win;
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

/// "GPT-5.3-Codex-Spark" → "gpt-5-3-codex-spark": a readable fallback id for a provider bucket
/// that lacks a `metered_feature` key.
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
}
