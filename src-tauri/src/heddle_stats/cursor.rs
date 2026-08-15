//! Cursor caps from cursor.com's own usage API, per account.
//!
//! SOURCE: `GET https://cursor.com/api/usage-summary` — the JSON endpoint the cursor.com dashboard
//! (and the actively maintained MIT extension `numanaral/cursor-usage-stats`) reads — authenticated
//! with the LOCAL Cursor session: cookie `WorkosCursorSessionToken=<userId>::<jwt>` where the JWT
//! is the session's access token and `userId` is the last `|`-segment of its `sub` claim. Same
//! category as the Codex source (a provider's own JSON API, not HTML scraping). Live-verified
//! 2026-08-15. It returns:
//!   `{billingCycleStart, billingCycleEnd, membershipType, limitType, isUnlimited,
//!     autoModelSelectedDisplayMessage, namedModelSelectedDisplayMessage,
//!     individualUsage: { plan?: {enabled, used, limit, remaining, breakdown{included,bonus,total},
//!                                autoPercentUsed, apiPercentUsed, totalPercentUsed},
//!                        onDemand: {enabled, used, limit, remaining},   // legacy name: overall
//!                      }, teamUsage: {…}}`
//! Money is in CENTS. Cursor's included allowance is TWO pools and the payload carries both as
//! percentages: `plan.totalPercentUsed` = the included TOTAL pool that Auto and Cursor models (Grok,
//! Composer — heddle's default Cursor routes) draw from ("You've used 17% of your included total
//! usage"), and `plan.apiPercentUsed` = the included API sub-pool that named third-party models
//! (kimi, …) draw from ("You've used 87% of your included API usage"); `plan.used/limit/remaining`
//! (for an Ultra account `limit` = 40000¢ = the $400 "Other Models" allowance on the pricing page)
//! describe that API sub-pool in dollars. `onDemand` is usage-based spend against the spend limit.
//! We surface all three as windows and Cursor's own display strings as the note — never our own
//! arithmetic where the provider already states the number.
//!
//! ACCOUNTS (Maya has two):
//!   - **Cursor IDE** login — token in the IDE's `state.vscdb` (`cursorAuth/accessToken`, plus
//!     `cursorAuth/cachedEmail`, `cursorAuth/stripeMembershipType`). Read-only SQLite; always on.
//!   - **cursor-agent CLI** login — token only in the macOS Keychain (`cursor-access-token`).
//!     Reading it (`/usr/bin/security find-generic-password -w`, the same pattern upstream uses
//!     for the Claude Code item in `agent/usage.rs`) pops a macOS "allow access" prompt the first
//!     time, so it is OPT-IN: `~/.heddle/usage-sources.json` → `{"cursor": {"keychainCli": true}}`,
//!     default off, and a failed read backs off for an hour (a 30s poll must never nag).
//!
//! Tokens never leave this module: not logged, not written to the snapshot, not in error text.
//! We never refresh tokens ourselves (mirror the provider's auth, never reimplement it): an expired
//! session shows up as a note telling Maya to open Cursor / run `cursor-agent login`.
//!
//! ACTIVE ACCOUNT: heddle dispatches through the cursor-agent CLI, so that login (when readable) is
//! `activeAccount` and supplies the top-level windows; otherwise the top level is the binding view.
//!
//! CADENCE: the snapshot `~/.heddle/usage/cursor.json` is refreshed out-of-band when older than
//! `REFRESH_AFTER_SECS` (one detached thread, atomic write), stale after `STALE_AFTER_SECS`.

use std::path::PathBuf;

use serde_json::{json, Value};

// The session-discovery / HTTP half lives in `cursor_fetch.rs` (same parent module; tokens still
// never leave the pair).
use super::cursor_fetch::fetch_and_write;
// Re-imported only so `cursor_tests.rs` reaches them via `super::*`.
#[cfg(test)]
use super::cursor_fetch::{
    jwt_claims, jwt_exp, jwt_user_id, keychain_backing_off, keychain_cli_enabled,
    note_keychain_failure,
};
use super::{
    binding_named, is_stale, tap_limit, usage_dir, AccountLimit, LimitWindow, NamedWindow,
    ProviderLimit, RefreshGate,
};

const SNAPSHOT: &str = "cursor.json";
pub(super) const SOURCE: &str = "cursor-usage-summary";
/// Refresh when the snapshot is older than this (the maintained extension polls at 60s; a monthly
/// gauge doesn't need more than this, and the refresh button forces one on demand).
pub(super) const REFRESH_AFTER_SECS: i64 = 180;
/// Flag `stale` when no successful fetch landed in this long.
pub(super) const STALE_AFTER_SECS: i64 = 900;
/// After a failed refresh, wait this long before trying again.
const FAILURE_BACKOFF_SECS: i64 = 300;
/// Warn when the session token expires within this many seconds.
const TOKEN_EXPIRY_WARN_SECS: i64 = 7 * 86_400;

// Note codes (the localizable key layer for `note`).
pub(super) const CODE_NO_ACCOUNTS: &str = "cursor.noAccounts";
pub(super) const CODE_REFRESH_FAILED: &str = "cursor.refreshFailed";
pub(super) const CODE_NO_DATA_YET: &str = "cursor.noDataYet";
/// The included API/named-model pool (`plan.remaining` 0 or `apiPercentUsed` ≥ 100): kimi-class
/// named third-party models bill on-demand from here on.
pub(super) const CODE_INCLUDED_API_EXHAUSTED: &str = "cursor.includedApiExhausted";
/// The included TOTAL pool (`totalPercentUsed` ≥ 100): Auto and Cursor models (Grok, Composer) too.
pub(super) const CODE_INCLUDED_TOTAL_EXHAUSTED: &str = "cursor.includedTotalExhausted";
pub(super) const CODE_ON_DEMAND_LIMIT_REACHED: &str = "cursor.onDemandLimitReached";
pub(super) const CODE_TOKEN_EXPIRED: &str = "cursor.tokenExpired";
pub(super) const CODE_TOKEN_EXPIRING_SOON: &str = "cursor.tokenExpiringSoon";
pub(super) const CODE_FETCH_FAILED: &str = "cursor.fetchFailed";

pub(super) const SOURCE_IDE: &str = "cursor-ide";
pub(super) const SOURCE_CLI_KEYCHAIN: &str = "cursor-agent-keychain";

static GATE: RefreshGate = RefreshGate::new();

pub(super) fn snapshot_path() -> PathBuf {
    usage_dir().join(SNAPSHOT)
}

/// Read the snapshot (kicking a refresh if it is old or missing) and return the Cursor entry.
/// `None` only before the first refresh has ever written a snapshot.
pub(super) fn limit(now: i64) -> Option<ProviderLimit> {
    let snap = std::fs::read_to_string(snapshot_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let last_attempt = snap
        .as_ref()
        .and_then(|v| v["lastAttemptAt"].as_i64().max(v["capturedAt"].as_i64()));
    if last_attempt
        .map(|t| now - t > REFRESH_AFTER_SECS)
        .unwrap_or(true)
    {
        maybe_spawn_refresh(now, false);
    }
    parse_snapshot(&snap?, now)
}

/// Force a refresh regardless of snapshot age (respects the in-flight guard, ignores the failure
/// backoff). `true` when a refresh thread was started.
pub(super) fn force_refresh(now: i64) -> bool {
    maybe_spawn_refresh(now, true)
}

fn maybe_spawn_refresh(now: i64, force: bool) -> bool {
    GATE.spawn(now, force, FAILURE_BACKOFF_SECS, fetch_and_write)
}

// ───────────────────────────── snapshot → ProviderLimit ─────────────────────────────

/// "2026-08-25T22:24:48.000Z" → epoch seconds.
fn parse_time(v: &Value) -> Option<i64> {
    v.as_str().and_then(super::gemini::parse_rfc3339)
}

fn cents(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn usd(c: Option<f64>) -> Option<f64> {
    c.map(|c| c / 100.0)
}

/// Accumulates an account's windows + notes while the helpers below walk the summary.
#[derive(Default)]
struct Rows {
    windows: Vec<NamedWindow>,
    codes: Vec<String>,
    texts: Vec<String>,
    api_exhausted: bool,
    total_exhausted: bool,
    on_demand_enabled: bool,
    on_demand_hard_stop: bool,
}

/// The two included pools, Cursor's own display strings, and the exhaustion codes.
fn included_windows(summary: &Value, cycle_end: Option<i64>, out: &mut Rows) {
    let plan = &summary["individualUsage"]["plan"];
    if !plan.is_object() {
        return;
    }
    let used = cents(&plan["used"]);
    let limit = cents(&plan["limit"]);
    let total_pct = plan["totalPercentUsed"].as_f64();
    let api_pct = plan["apiPercentUsed"].as_f64();
    // Included TOTAL pool: Auto + Cursor models (Grok, Composer). Cursor states the percentage
    // itself; it does not expose this pool's dollar size, so no amounts here.
    out.windows.push(NamedWindow {
        id: "included-total".to_string(),
        label: "included total (Auto / Cursor models)".to_string(),
        used_percentage: total_pct.map(|p| p.clamp(0.0, 100.0)),
        resets_at: cycle_end,
        used_amount: None,
        limit_amount: None,
        unit: None,
    });
    // Included API sub-pool: named third-party models. Percentage is Cursor's; the amounts are
    // Cursor's `plan.used` / `plan.limit` for the same pool.
    out.windows.push(NamedWindow {
        id: "included-api".to_string(),
        label: "included API (named 3rd-party models)".to_string(),
        used_percentage: api_pct.map(|p| p.clamp(0.0, 100.0)),
        resets_at: cycle_end,
        used_amount: usd(used),
        limit_amount: usd(limit),
        unit: Some("usd".to_string()),
    });
    let plan_on = plan["enabled"].as_bool() != Some(false);
    out.api_exhausted = plan_on
        && (api_pct.map(|p| p >= 100.0).unwrap_or(false)
            || (limit.map(|l| l > 0.0).unwrap_or(false)
                && cents(&plan["remaining"]).map(|r| r <= 0.0).unwrap_or(false)));
    out.total_exhausted = plan_on && total_pct.map(|p| p >= 100.0).unwrap_or(false);
    included_notes(summary, used, limit, out);
}

/// Cursor's own display strings first, then the exhaustion notes the flags above imply.
fn included_notes(summary: &Value, used: Option<f64>, limit: Option<f64>, out: &mut Rows) {
    for key in [
        "autoModelSelectedDisplayMessage",
        "namedModelSelectedDisplayMessage",
    ] {
        if let Some(m) = summary[key].as_str().filter(|m| !m.is_empty()) {
            out.texts.push(m.to_string());
        }
    }
    if out.api_exhausted {
        out.codes.push(CODE_INCLUDED_API_EXHAUSTED.to_string());
        out.texts.push(format!(
            "included API pool used up (${:.2} of ${:.2}) — named third-party models bill on-demand \
             until the cycle resets",
            used.unwrap_or(0.0) / 100.0,
            limit.unwrap_or(0.0) / 100.0
        ));
    }
    if out.total_exhausted {
        out.codes.push(CODE_INCLUDED_TOTAL_EXHAUSTED.to_string());
        out.texts.push(
            "included total pool used up — Auto and Cursor models bill on-demand until the cycle \
             resets"
                .to_string(),
        );
    }
}

/// The usage-based (on-demand) window and its hard stop. Current payloads name it `onDemand`;
/// older ones called it `overall`.
fn on_demand_window(summary: &Value, cycle_end: Option<i64>, out: &mut Rows) {
    let od = if summary["individualUsage"]["onDemand"].is_object() {
        &summary["individualUsage"]["onDemand"]
    } else {
        &summary["individualUsage"]["overall"]
    };
    if !od.is_object() {
        return;
    }
    let enabled = od["enabled"].as_bool().unwrap_or(false);
    let used = cents(&od["used"]);
    let limit = cents(&od["limit"]);
    let has_limit = limit.map(|l| l > 0.0).unwrap_or(false);
    let pct = match (enabled, used, limit) {
        (true, Some(u), Some(l)) if l > 0.0 => Some((u / l * 100.0).clamp(0.0, 100.0)),
        _ => None,
    };
    out.windows.push(NamedWindow {
        id: "usage-based".to_string(),
        label: if enabled {
            "on-demand (usage-based)".to_string()
        } else {
            "on-demand (usage-based, off)".to_string()
        },
        used_percentage: pct,
        resets_at: cycle_end,
        used_amount: usd(used),
        limit_amount: usd(limit),
        unit: Some("usd".to_string()),
    });
    out.on_demand_enabled = enabled;
    // Hard stop when the spend limit is used up — by `remaining` OR by `used >= limit`, so the
    // flag can never disagree with a 100% bar.
    let spent = cents(&od["remaining"]).map(|r| r <= 0.0).unwrap_or(false)
        || matches!((used, limit), (Some(u), Some(l)) if u >= l);
    if enabled && has_limit && spent {
        out.on_demand_hard_stop = true;
        out.codes.push(CODE_ON_DEMAND_LIMIT_REACHED.to_string());
        out.texts.push("on-demand spend limit reached".to_string());
    }
}

/// Session-token expiry and last-fetch-error notes.
fn session_notes(acct: &Value, now: i64, out: &mut Rows) {
    if let Some(exp) = acct["tokenExpiresAt"].as_i64() {
        if exp <= now {
            out.codes.push(CODE_TOKEN_EXPIRED.to_string());
            out.texts
                .push("session token expired — sign in to Cursor again".to_string());
        } else if exp - now < TOKEN_EXPIRY_WARN_SECS {
            out.codes.push(CODE_TOKEN_EXPIRING_SOON.to_string());
            out.texts.push(format!(
                "session token expires in {}d",
                (exp - now) / 86_400
            ));
        }
    }
    if let Some(err) = acct["error"].as_str() {
        out.codes.push(CODE_FETCH_FAILED.to_string());
        out.texts.push(format!("last fetch failed: {err}"));
    }
}

/// One account row from its snapshot entry.
/// The raw provider facts for one account (the drawer tooltip / router's `detail`).
fn account_detail(
    acct: &Value,
    summary: &Value,
    source: &str,
    cycle_start: Option<i64>,
    cycle_end: Option<i64>,
    on_demand: &Value,
) -> Value {
    json!({
        "source": source,
        "membershipType": summary["membershipType"],
        "limitType": summary["limitType"],
        "isUnlimited": summary["isUnlimited"],
        "billingCycleStart": cycle_start,
        "billingCycleEnd": cycle_end,
        "plan": summary["individualUsage"]["plan"],
        "onDemand": on_demand,
        "autoModelSelectedDisplayMessage": summary["autoModelSelectedDisplayMessage"],
        "namedModelSelectedDisplayMessage": summary["namedModelSelectedDisplayMessage"],
        "tokenExpiresAt": acct["tokenExpiresAt"],
        "fetchedAt": acct["fetchedAt"],
    })
}

/// One account row from its snapshot entry.
pub(super) fn account_row(acct: &Value, now: i64) -> AccountLimit {
    let label = acct["label"].as_str().unwrap_or("cursor").to_string();
    let source = acct["source"].as_str().unwrap_or("?").to_string();
    let summary = &acct["summary"];
    let has_summary = summary.is_object();
    let cycle_end = parse_time(&summary["billingCycleEnd"]);
    let cycle_start = parse_time(&summary["billingCycleStart"]);
    let mut rows = Rows::default();
    included_windows(summary, cycle_end, &mut rows);
    on_demand_window(summary, cycle_end, &mut rows);
    session_notes(acct, now, &mut rows);
    // "heddle's default Cursor routes (Grok/Composer) will fail here": on-demand is capped out, or
    // it's off and the included TOTAL pool is gone. (The API sub-pool only gates named 3P models —
    // see `cursor.includedApiExhausted`.)
    let limit_reached = has_summary
        .then_some(rows.on_demand_hard_stop || (!rows.on_demand_enabled && rows.total_exhausted));
    let fetched_at = acct["fetchedAt"].as_i64();
    let on_demand = if summary["individualUsage"]["onDemand"].is_object() {
        &summary["individualUsage"]["onDemand"]
    } else {
        &summary["individualUsage"]["overall"]
    };
    AccountLimit {
        id: source.clone(),
        label,
        plan: summary["membershipType"]
            .as_str()
            .or(acct["membershipHint"].as_str())
            .map(str::to_string),
        captured_at: fetched_at,
        stale: is_stale(fetched_at, now, STALE_AFTER_SECS),
        five_hour: LimitWindow::default(),
        seven_day: LimitWindow::default(),
        windows: rows.windows,
        limit_reached,
        note: join_texts(&rows.texts),
        note_codes: rows.codes,
        detail: Some(account_detail(
            acct,
            summary,
            &source,
            cycle_start,
            cycle_end,
            on_demand,
        )),
    }
}

fn join_texts(texts: &[String]) -> Option<String> {
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("; "))
    }
}

/// Snapshot → ProviderLimit: no 5h/7d (Cursor has none), per-account rows with the pools as named
/// windows, the ACTIVE account (cursor-agent login, what dispatches bill) as the top level when it
/// has data — else the binding (max) view — plus staleness and refresh errors as notes.
/// The provider-level notes: no accounts at all, else the last refresh error.
fn snapshot_notes(
    snap: &Value,
    no_accounts: bool,
    has_capture: bool,
    now: i64,
) -> (Vec<String>, Vec<String>) {
    let mut codes = Vec::new();
    let mut texts = Vec::new();
    if no_accounts {
        codes.push(CODE_NO_ACCOUNTS.to_string());
        texts.push(
            snap["lastError"]
                .as_str()
                .unwrap_or("no Cursor login found")
                .to_string(),
        );
    } else if let Some(err) = snap["lastError"].as_str() {
        let when = snap["lastAttemptAt"].as_i64().unwrap_or(0);
        if has_capture {
            codes.push(CODE_REFRESH_FAILED.to_string());
            texts.push(format!("last refresh failed ({}s ago): {err}", now - when));
        } else {
            codes.push(CODE_NO_DATA_YET.to_string());
            texts.push(format!("no data yet: {err}"));
        }
    }
    (codes, texts)
}

/// Snapshot → ProviderLimit: no 5h/7d (Cursor has none), per-account rows with the pools as named
/// windows, the ACTIVE account (cursor-agent login, what dispatches bill) as the top level when it
/// has data — else the binding (max) view — plus staleness and refresh errors as notes.
pub(super) fn parse_snapshot(snap: &Value, now: i64) -> Option<ProviderLimit> {
    let mut l = tap_limit("cursor", snap, now)?;
    l.source = Some(SOURCE.to_string());
    l.stale = is_stale(l.captured_at, now, STALE_AFTER_SECS);
    l.stale_after_secs = Some(STALE_AFTER_SECS);
    let accounts: Vec<AccountLimit> = snap["accounts"]
        .as_array()
        .map(|a| a.iter().map(|acct| account_row(acct, now)).collect())
        .unwrap_or_default();
    l.model = Some(format!("cursor.com · {} acct", accounts.len()));
    // Top level = the cursor-agent login's own windows and ITS capture time (so a stale CLI row can't
    // hide behind a fresh IDE fetch); if that row has no data yet, show the binding view instead.
    let active = accounts
        .iter()
        .find(|a| a.id == SOURCE_CLI_KEYCHAIN && !a.windows.is_empty());
    match active {
        Some(a) => {
            l.active_account = Some(a.id.clone());
            l.windows = Some(a.windows.clone());
            l.captured_at = a.captured_at;
            l.stale = a.stale;
        }
        None => {
            l.active_account = None;
            l.windows = Some(binding_named(&accounts));
        }
    }
    let (codes, texts) = snapshot_notes(snap, accounts.is_empty(), l.captured_at.is_some(), now);
    l.accounts = Some(accounts);
    l.note = join_texts(&texts);
    l.note_codes = Some(codes);
    Some(l)
}

#[cfg(test)]
#[path = "cursor_tests.rs"]
mod tests;
