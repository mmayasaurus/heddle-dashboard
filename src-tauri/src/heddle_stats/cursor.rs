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
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use super::{
    binding_named, home, is_stale, mask_email, now_secs, run_with_timeout, tap_limit, usage_dir,
    write_json_atomic, AccountLimit, LimitWindow, NamedWindow, ProviderLimit, RefreshGate,
};

const SNAPSHOT: &str = "cursor.json";
pub(super) const SOURCE: &str = "cursor-usage-summary";
const USAGE_SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
/// Refresh when the snapshot is older than this (the maintained extension polls at 60s; a monthly
/// gauge doesn't need more than this, and the refresh button forces one on demand).
pub(super) const REFRESH_AFTER_SECS: i64 = 180;
/// Flag `stale` when no successful fetch landed in this long.
pub(super) const STALE_AFTER_SECS: i64 = 900;
/// After a failed refresh, wait this long before trying again.
const FAILURE_BACKOFF_SECS: i64 = 300;
/// After a Keychain read fails (denied / no item / timed out), don't try again for this long.
const KEYCHAIN_RETRY_AFTER_SECS: i64 = 3600;
/// The first Keychain read may show macOS's "allow access" dialog; if nobody answers it in this
/// long the read is abandoned (and backed off) so the refresher can't hang on it.
const KEYCHAIN_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// Warn when the session token expires within this many seconds.
const TOKEN_EXPIRY_WARN_SECS: i64 = 7 * 86_400;
const USER_AGENT: &str = concat!(
    "heddle-dashboard/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/mmayasaurus/heddle-dashboard)"
);

/// Opt-in switch for the cursor-agent Keychain account, in `~/.heddle/usage-sources.json`.
const SOURCES_CONFIG_REL: &str = ".heddle/usage-sources.json";

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
static KEYCHAIN_NEXT_ATTEMPT_AT: AtomicI64 = AtomicI64::new(0);

fn snapshot_path() -> PathBuf {
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

// ───────────────────────────── local sessions ─────────────────────────────

/// A local Cursor login we can query usage for. The token stays inside this struct.
struct Session {
    label: String,
    source: &'static str,
    token: String,
    membership_hint: Option<String>,
}

/// Cursor IDE's global state DB per platform.
fn ide_state_db_path() -> Option<PathBuf> {
    let h = home();
    if cfg!(target_os = "macos") {
        Some(
            h.join("Library")
                .join("Application Support")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        )
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|a| {
            PathBuf::from(a)
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb")
        })
    } else {
        Some(
            h.join(".config")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        )
    }
}

/// The IDE login, if Cursor is installed and signed in. Read-only SQLite (the IDE may hold the DB
/// open; readers are fine). `Ok(None)` = no IDE / signed out; `Err` = present but unreadable.
fn ide_session() -> Result<Option<Session>, String> {
    let Some(path) = ide_state_db_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("cannot open Cursor state.vscdb read-only: {e}"))?;
    conn.busy_timeout(Duration::from_secs(2)).ok();
    let get = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM ItemTable WHERE key = ?1", [key], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .filter(|v| !v.is_empty())
    };
    let Some(token) = get("cursorAuth/accessToken") else {
        return Ok(None);
    };
    Ok(Some(Session {
        label: get("cursorAuth/cachedEmail")
            .map(|e| mask_email(&e))
            .unwrap_or_else(|| "cursor-ide".to_string()),
        source: SOURCE_IDE,
        token,
        membership_hint: get("cursorAuth/stripeMembershipType"),
    }))
}

/// `~/.heddle/usage-sources.json` (missing/invalid → `{}`).
fn sources_config() -> Value {
    std::fs::read_to_string(home().join(SOURCES_CONFIG_REL))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}))
}

pub(super) fn keychain_cli_enabled(config: &Value) -> bool {
    config["cursor"]["keychainCli"].as_bool() == Some(true)
}

/// Whether the Keychain path is inside its failure backoff at `now`.
pub(super) fn keychain_backing_off(now: i64) -> bool {
    now < KEYCHAIN_NEXT_ATTEMPT_AT.load(Ordering::SeqCst)
}

/// Record a Keychain failure: no retry for `KEYCHAIN_RETRY_AFTER_SECS`.
pub(super) fn note_keychain_failure(now: i64) {
    KEYCHAIN_NEXT_ATTEMPT_AT.store(now + KEYCHAIN_RETRY_AFTER_SECS, Ordering::SeqCst);
}

/// The cursor-agent CLI login from the macOS Keychain (opt-in). `Ok(None)` when disabled; `Err`
/// when the read failed (denied, no item, no UI session, unanswered prompt, non-macOS) — every
/// failure backs off for an hour so a 30s poll can never nag.
fn cli_session(now: i64) -> Result<Option<Session>, String> {
    if !keychain_cli_enabled(&sources_config()) {
        return Ok(None);
    }
    if keychain_backing_off(now) {
        return Err("Keychain read skipped — backing off after an earlier failure".to_string());
    }
    if !cfg!(target_os = "macos") {
        note_keychain_failure(now);
        return Err("cursor-agent Keychain account is only supported on macOS".to_string());
    }
    let mut cmd = std::process::Command::new("/usr/bin/security");
    cmd.args(["find-generic-password", "-s", "cursor-access-token", "-w"]);
    let (ok, stdout, _stderr) = match run_with_timeout(cmd, KEYCHAIN_PROMPT_TIMEOUT) {
        Ok(r) => r,
        Err(e) => {
            note_keychain_failure(now);
            return Err(format!("Keychain read of cursor-access-token failed: {e}"));
        }
    };
    if !ok {
        note_keychain_failure(now);
        // Exit 44 = errSecItemNotFound (no cursor-agent login); other codes are mostly denied access.
        return Err(
            "Keychain read of cursor-access-token failed (security exited non-zero) — access \
             denied or no cursor-agent login"
                .to_string(),
        );
    }
    let token = stdout.trim().to_string();
    if token.is_empty() {
        note_keychain_failure(now);
        return Err("Keychain item cursor-access-token is empty".to_string());
    }
    let email = std::fs::read_to_string(home().join(".cursor").join("cli-config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["authInfo"]["email"].as_str().map(mask_email));
    Ok(Some(Session {
        label: email.unwrap_or_else(|| "cursor-agent".to_string()),
        source: SOURCE_CLI_KEYCHAIN,
        token,
        membership_hint: None,
    }))
}

// ───────────────────────────── JWT + HTTP ─────────────────────────────

/// Decode a JWT payload without verifying it (we only need `sub` / `exp` from OUR OWN token).
pub(super) fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// `sub` = "<provider>|user_xxx" → "user_xxx" (the cookie's user id).
pub(super) fn jwt_user_id(token: &str) -> Option<String> {
    let claims = jwt_claims(token)?;
    let sub = claims["sub"].as_str()?;
    Some(sub.rsplit('|').next().unwrap_or(sub).to_string())
}

pub(super) fn jwt_exp(token: &str) -> Option<i64> {
    jwt_claims(token)?["exp"].as_i64()
}

/// GET usage-summary for one session. The cookie (which carries the token) lives only in this
/// function's stack and is never formatted into an error, log, or the snapshot.
fn fetch_usage_summary(token: &str) -> Result<Value, String> {
    let user_id = jwt_user_id(token).ok_or("session token has no usable `sub` claim")?;
    let cookie = format!("WorkosCursorSessionToken={user_id}::{token}");
    let resp = ureq::get(USAGE_SUMMARY_URL)
        .set("Cookie", &cookie)
        .set("Accept", "application/json")
        .set("User-Agent", USER_AGENT)
        .timeout(HTTP_TIMEOUT)
        .call();
    match resp {
        Ok(r) => {
            let body = r
                .into_string()
                .map_err(|e| format!("usage-summary: read failed: {e}"))?;
            serde_json::from_str::<Value>(&body)
                .map_err(|e| format!("usage-summary: invalid JSON: {e}"))
        }
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => Err(
            "usage-summary: HTTP 401/403 — session rejected (expired or signed out)".to_string(),
        ),
        Err(ureq::Error::Status(429, _)) => {
            Err("usage-summary: HTTP 429 — rate limited by cursor.com".to_string())
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("usage-summary: HTTP {code}")),
        Err(e) => Err(format!("usage-summary: request failed: {e}")),
    }
}

// ───────────────────────────── refresh → snapshot ─────────────────────────────

/// Discover sessions, fetch each, write the snapshot. Returns whether at least one account was
/// fetched successfully. Accounts that fail — or that couldn't even be discovered this attempt
/// (IDE DB unreadable, Keychain backoff) — keep their last-known summary from the previous
/// snapshot with an `error`, so numbers never silently vanish.
fn fetch_and_write() -> bool {
    let now = now_secs();
    let path = snapshot_path();
    let previous = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object);
    let prev_accounts: Vec<Value> = previous
        .as_ref()
        .and_then(|p| p["accounts"].as_array().cloned())
        .unwrap_or_default();
    let prev_for = |source: &str| {
        prev_accounts
            .iter()
            .find(|a| a["source"] == source)
            .cloned()
    };

    let mut sessions: Vec<Session> = Vec::new();
    let mut discovery_errors: Vec<(&'static str, String)> = Vec::new();
    for (source, found) in [
        (SOURCE_IDE, ide_session()),
        (SOURCE_CLI_KEYCHAIN, cli_session(now)),
    ] {
        match found {
            Ok(Some(s)) => sessions.push(s),
            Ok(None) => {}
            Err(e) => discovery_errors.push((source, e)),
        }
    }

    let mut accounts: Vec<Value> = Vec::new();
    let mut any_ok = false;
    for s in &sessions {
        let prev = prev_for(s.source).unwrap_or_else(|| json!({}));
        let mut acct = json!({
            "label": s.label,
            "source": s.source,
            "tokenExpiresAt": jwt_exp(&s.token),
            "membershipHint": s.membership_hint,
            "fetchedAt": prev["fetchedAt"].clone(),
            "summary": prev["summary"].clone(),
        });
        let expired = jwt_exp(&s.token).map(|e| e <= now).unwrap_or(false);
        let result = if expired {
            Err(format!(
                "session token expired — open Cursor{} to sign in again",
                if s.source == SOURCE_CLI_KEYCHAIN {
                    " / run `cursor-agent login`"
                } else {
                    ""
                }
            ))
        } else {
            fetch_usage_summary(&s.token)
        };
        match result {
            Ok(summary) => {
                any_ok = true;
                acct["summary"] = summary;
                acct["fetchedAt"] = json!(now);
                acct["error"] = Value::Null;
            }
            Err(e) => acct["error"] = Value::String(e),
        }
        accounts.push(acct);
    }
    // Accounts we knew last time but couldn't discover now: carry them over with the reason.
    for (source, why) in &discovery_errors {
        if accounts.iter().any(|a| a["source"] == *source) {
            continue;
        }
        if let Some(mut prev) = prev_for(source) {
            prev["error"] = Value::String(format!("not discovered this attempt: {why}"));
            accounts.push(prev);
        }
    }

    let mut snap = json!({
        "model": format!("cursor.com · {} acct", accounts.len()),
        "rate_limits": {},
        "capturedAt": if any_ok { json!(now) } else { previous.as_ref().map(|p| p["capturedAt"].clone()).unwrap_or(Value::Null) },
        "source": SOURCE,
        "accounts": accounts,
        "lastAttemptAt": now,
    });
    let discovery_text: Vec<String> = discovery_errors.iter().map(|(_, e)| e.clone()).collect();
    let error = if sessions.is_empty() {
        Some(if discovery_text.is_empty() {
            "no Cursor login found (Cursor IDE not signed in; cursor-agent Keychain account is \
             opt-in — see docs/USAGE_TAP.md)"
                .to_string()
        } else {
            discovery_text.join("; ")
        })
    } else if !any_ok {
        Some("every account fetch failed (see accounts[].error)".to_string())
    } else if discovery_text.is_empty() {
        None
    } else {
        Some(discovery_text.join("; "))
    };
    if let Some(e) = error {
        snap["lastError"] = Value::String(e);
    }
    let _ = write_json_atomic(&path, &snap);
    any_ok
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
    // Cursor's own words first.
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
        note: if rows.texts.is_empty() {
            None
        } else {
            Some(rows.texts.join("; "))
        },
        note_codes: rows.codes,
        detail: Some(json!({
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
        })),
    }
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
    let mut codes = Vec::new();
    let mut texts = Vec::new();
    if accounts.is_empty() {
        codes.push(CODE_NO_ACCOUNTS.to_string());
        texts.push(
            snap["lastError"]
                .as_str()
                .unwrap_or("no Cursor login found")
                .to_string(),
        );
    } else if let Some(err) = snap["lastError"].as_str() {
        let when = snap["lastAttemptAt"].as_i64().unwrap_or(0);
        if l.captured_at.is_some() {
            codes.push(CODE_REFRESH_FAILED.to_string());
            texts.push(format!("last refresh failed ({}s ago): {err}", now - when));
        } else {
            codes.push(CODE_NO_DATA_YET.to_string());
            texts.push(format!("no data yet: {err}"));
        }
    }
    l.accounts = Some(accounts);
    l.note = if texts.is_empty() {
        None
    } else {
        Some(texts.join("; "))
    };
    l.note_codes = Some(codes);
    Some(l)
}

#[cfg(test)]
#[path = "cursor_tests.rs"]
mod tests;
