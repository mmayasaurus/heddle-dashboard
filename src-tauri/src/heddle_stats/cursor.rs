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
//! Money is in CENTS. `plan` is the included monthly pool the endpoint reports (for an Ultra
//! account `limit` = 40000¢ = the $400 "Other Models" allowance from Cursor's pricing page);
//! `onDemand` is usage-based spend against the spend limit. Cursor's separate "Cursor Models"
//! pool (Grok/Composer) is NOT reported by this endpoint — we don't invent it.
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
//! CADENCE: the snapshot `~/.heddle/usage/cursor.json` is refreshed out-of-band when older than
//! `REFRESH_AFTER_SECS` (one detached thread, atomic write), stale after `STALE_AFTER_SECS`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use super::{
    binding_named, home, is_stale, mask_email, now_secs, tap_limit, usage_dir, write_json_atomic,
    AccountLimit, LimitWindow, NamedWindow, ProviderLimit,
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
/// After a Keychain read fails (denied / no item), don't try again for this long.
const KEYCHAIN_RETRY_AFTER_SECS: i64 = 3600;
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
pub(super) const CODE_PLAN_EXHAUSTED: &str = "cursor.planExhausted";
pub(super) const CODE_ON_DEMAND_LIMIT_REACHED: &str = "cursor.onDemandLimitReached";
pub(super) const CODE_TOKEN_EXPIRED: &str = "cursor.tokenExpired";
pub(super) const CODE_TOKEN_EXPIRING_SOON: &str = "cursor.tokenExpiringSoon";
pub(super) const CODE_FETCH_FAILED: &str = "cursor.fetchFailed";

pub(super) const SOURCE_IDE: &str = "cursor-ide";
pub(super) const SOURCE_CLI_KEYCHAIN: &str = "cursor-agent-keychain";

static REFRESHING: AtomicBool = AtomicBool::new(false);
static NEXT_ATTEMPT_AT: AtomicI64 = AtomicI64::new(0);
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
    if !force && now < NEXT_ATTEMPT_AT.load(Ordering::SeqCst) {
        return false;
    }
    if REFRESHING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }
    std::thread::spawn(|| {
        let ok = fetch_and_write();
        let now = now_secs();
        NEXT_ATTEMPT_AT.store(
            if ok { 0 } else { now + FAILURE_BACKOFF_SECS },
            Ordering::SeqCst,
        );
        REFRESHING.store(false, Ordering::SeqCst);
    });
    true
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

/// The cursor-agent CLI login from the macOS Keychain (opt-in). `Ok(None)` when disabled or not
/// on macOS; `Err` when the read failed (denied, no item, no UI session) — backed off for an hour.
fn cli_session(now: i64) -> Result<Option<Session>, String> {
    if !keychain_cli_enabled(&sources_config()) {
        return Ok(None);
    }
    if !cfg!(target_os = "macos") {
        return Err("cursor-agent Keychain account is only supported on macOS".to_string());
    }
    if now < KEYCHAIN_NEXT_ATTEMPT_AT.load(Ordering::SeqCst) {
        return Err("Keychain read skipped — backing off after an earlier failure".to_string());
    }
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "cursor-access-token", "-w"])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("failed to run security: {e}"))?;
    if !out.status.success() {
        KEYCHAIN_NEXT_ATTEMPT_AT.store(now + KEYCHAIN_RETRY_AFTER_SECS, Ordering::SeqCst);
        let code = out.status.code().unwrap_or(-1);
        // 44 = errSecItemNotFound (no cursor-agent login); other codes are mostly denied access.
        return Err(format!(
            "Keychain read of cursor-access-token failed (security exit {code}) — access denied or \
             no cursor-agent login"
        ));
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        KEYCHAIN_NEXT_ATTEMPT_AT.store(now + KEYCHAIN_RETRY_AFTER_SECS, Ordering::SeqCst);
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

/// GET usage-summary for one session. Errors never contain the token.
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
/// fetched successfully. Accounts that fail keep their last-known summary (from the previous
/// snapshot) with an `error`, so numbers never silently vanish.
fn fetch_and_write() -> bool {
    let now = now_secs();
    let path = snapshot_path();
    let previous = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object);

    let mut sessions: Vec<Session> = Vec::new();
    let mut discovery_errors: Vec<String> = Vec::new();
    match ide_session() {
        Ok(Some(s)) => sessions.push(s),
        Ok(None) => {}
        Err(e) => discovery_errors.push(e),
    }
    match cli_session(now) {
        Ok(Some(s)) => sessions.push(s),
        Ok(None) => {}
        Err(e) => discovery_errors.push(e),
    }

    let prev_accounts: Vec<Value> = previous
        .as_ref()
        .and_then(|p| p["accounts"].as_array().cloned())
        .unwrap_or_default();
    let mut accounts: Vec<Value> = Vec::new();
    let mut any_ok = false;
    for s in &sessions {
        let prev = prev_accounts
            .iter()
            .find(|a| a["source"] == s.source)
            .cloned()
            .unwrap_or_else(|| json!({}));
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

    let mut snap = json!({
        "model": format!("cursor.com · {} acct", accounts.len()),
        "rate_limits": {},
        "capturedAt": if any_ok { json!(now) } else { previous.as_ref().map(|p| p["capturedAt"].clone()).unwrap_or(Value::Null) },
        "source": SOURCE,
        "accounts": accounts,
        "lastAttemptAt": now,
    });
    let error = if sessions.is_empty() {
        Some(if discovery_errors.is_empty() {
            "no Cursor login found (Cursor IDE not signed in; cursor-agent Keychain account is \
             opt-in — see docs/USAGE_TAP.md)"
                .to_string()
        } else {
            discovery_errors.join("; ")
        })
    } else if !any_ok {
        Some("every account fetch failed (see accounts[].error)".to_string())
    } else if discovery_errors.is_empty() {
        None
    } else {
        Some(discovery_errors.join("; "))
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

/// One account row from its snapshot entry.
pub(super) fn account_row(acct: &Value, now: i64) -> AccountLimit {
    let label = acct["label"].as_str().unwrap_or("cursor").to_string();
    let source = acct["source"].as_str().unwrap_or("?").to_string();
    let summary = &acct["summary"];
    let has_summary = summary.is_object();
    let cycle_end = parse_time(&summary["billingCycleEnd"]);
    let cycle_start = parse_time(&summary["billingCycleStart"]);
    let plan = &summary["individualUsage"]["plan"];
    // Current shape names it onDemand; older shape called it overall.
    let on_demand = if summary["individualUsage"]["onDemand"].is_object() {
        &summary["individualUsage"]["onDemand"]
    } else {
        &summary["individualUsage"]["overall"]
    };

    let mut windows = Vec::new();
    let mut codes = Vec::new();
    let mut texts = Vec::new();

    if plan.is_object() {
        let used = cents(&plan["used"]);
        let limit = cents(&plan["limit"]);
        let pct = match (used, limit) {
            (Some(u), Some(l)) if l > 0.0 => Some((u / l * 100.0).clamp(0.0, 100.0)),
            _ => None,
        };
        windows.push(NamedWindow {
            id: "monthly".to_string(),
            label: "included plan (monthly)".to_string(),
            used_percentage: pct,
            resets_at: cycle_end,
            used_amount: used.map(|c| c / 100.0),
            limit_amount: limit.map(|c| c / 100.0),
            unit: Some("usd".to_string()),
        });
        if plan["enabled"].as_bool() != Some(false)
            && cents(&plan["remaining"]).map(|r| r <= 0.0).unwrap_or(false)
            && limit.map(|l| l > 0.0).unwrap_or(false)
        {
            codes.push(CODE_PLAN_EXHAUSTED.to_string());
            texts.push(format!(
                "included pool used up (${:.2} of ${:.2}) — named third-party models bill on-demand \
                 until the cycle resets",
                used.unwrap_or(0.0) / 100.0,
                limit.unwrap_or(0.0) / 100.0
            ));
        }
    }
    let mut on_demand_hard_stop = false;
    if on_demand.is_object() {
        let enabled = on_demand["enabled"].as_bool().unwrap_or(false);
        let used = cents(&on_demand["used"]);
        let limit = cents(&on_demand["limit"]);
        let pct = match (enabled, used, limit) {
            (true, Some(u), Some(l)) if l > 0.0 => Some((u / l * 100.0).clamp(0.0, 100.0)),
            _ => None,
        };
        windows.push(NamedWindow {
            id: "usage-based".to_string(),
            label: if enabled {
                "on-demand (usage-based)".to_string()
            } else {
                "on-demand (usage-based, off)".to_string()
            },
            used_percentage: pct,
            resets_at: cycle_end,
            used_amount: used.map(|c| c / 100.0),
            limit_amount: limit.map(|c| c / 100.0),
            unit: Some("usd".to_string()),
        });
        if enabled
            && limit.map(|l| l > 0.0).unwrap_or(false)
            && cents(&on_demand["remaining"])
                .map(|r| r <= 0.0)
                .unwrap_or(false)
        {
            on_demand_hard_stop = true;
            codes.push(CODE_ON_DEMAND_LIMIT_REACHED.to_string());
            texts.push("on-demand spend limit reached".to_string());
        }
    }
    let plan_exhausted = codes.iter().any(|c| c == CODE_PLAN_EXHAUSTED);
    let on_demand_enabled = on_demand["enabled"].as_bool().unwrap_or(false);
    // "Requests will fail": on-demand is capped out, or it's off and the included pool is gone.
    let limit_reached = if has_summary {
        Some(on_demand_hard_stop || (!on_demand_enabled && plan_exhausted))
    } else {
        None
    };

    if let Some(exp) = acct["tokenExpiresAt"].as_i64() {
        if exp <= now {
            codes.push(CODE_TOKEN_EXPIRED.to_string());
            texts.push("session token expired — sign in to Cursor again".to_string());
        } else if exp - now < TOKEN_EXPIRY_WARN_SECS {
            codes.push(CODE_TOKEN_EXPIRING_SOON.to_string());
            texts.push(format!(
                "session token expires in {}d",
                (exp - now) / 86_400
            ));
        }
    }
    if let Some(err) = acct["error"].as_str() {
        codes.push(CODE_FETCH_FAILED.to_string());
        texts.push(format!("last fetch failed: {err}"));
    }

    let fetched_at = acct["fetchedAt"].as_i64();
    AccountLimit {
        id: source.clone(),
        label,
        captured_at: fetched_at,
        stale: is_stale(fetched_at, now, STALE_AFTER_SECS),
        plan: summary["membershipType"]
            .as_str()
            .or(acct["membershipHint"].as_str())
            .map(str::to_string),
        five_hour: LimitWindow::default(),
        seven_day: LimitWindow::default(),
        windows,
        limit_reached,
        note: if texts.is_empty() {
            None
        } else {
            Some(texts.join("; "))
        },
        note_codes: codes,
        detail: Some(json!({
            "source": source,
            "membershipType": summary["membershipType"],
            "limitType": summary["limitType"],
            "isUnlimited": summary["isUnlimited"],
            "billingCycleStart": cycle_start,
            "billingCycleEnd": cycle_end,
            "plan": plan,
            "onDemand": on_demand,
            "autoModelSelectedDisplayMessage": summary["autoModelSelectedDisplayMessage"],
            "namedModelSelectedDisplayMessage": summary["namedModelSelectedDisplayMessage"],
            "tokenExpiresAt": acct["tokenExpiresAt"],
            "fetchedAt": acct["fetchedAt"],
        })),
    }
}

/// Snapshot → ProviderLimit: no 5h/7d (Cursor has none), per-account rows with the two pools as
/// named windows, binding (max) windows across accounts, staleness, and refresh errors as notes.
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
    l.windows = Some(binding_named(&accounts));
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
