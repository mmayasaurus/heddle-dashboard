//! The network half of the Cursor source: local session discovery (IDE `state.vscdb`,
//! cursor-agent macOS Keychain — opt-in), JWT peeking, the `usage-summary` HTTP call, and the
//! snapshot writer. Split from `cursor.rs` so each file stays readable; the pair forms one unit and
//! session tokens never leave it (not logged, not persisted, not in error text — the cookie lives
//! only on `fetch_usage_summary`'s stack).

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use super::cursor::{snapshot_path, SOURCE, SOURCE_CLI_KEYCHAIN, SOURCE_IDE};
use super::{home, mask_email, now_secs, run_with_timeout, write_json_atomic};

/// After a Keychain read fails (denied / no item / timed out), don't try again for this long.
const KEYCHAIN_RETRY_AFTER_SECS: i64 = 3600;
/// The first Keychain read may show macOS's "allow access" dialog; if nobody answers it in this
/// long the read is abandoned (and backed off) so the refresher can't hang on it.
const KEYCHAIN_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);
/// Opt-in switch for the cursor-agent Keychain account, in `~/.heddle/usage-sources.json`.
const SOURCES_CONFIG_REL: &str = ".heddle/usage-sources.json";
const USAGE_SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
/// After a Keychain read fails (denied / no item / timed out), don't try again for this long.
/// The first Keychain read may show macOS's "allow access" dialog; if nobody answers it in this
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = concat!(
    "heddle-dashboard/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/mmayasaurus/heddle-dashboard)"
);
/// Opt-in switch for the cursor-agent Keychain account, in `~/.heddle/usage-sources.json`.
static KEYCHAIN_NEXT_ATTEMPT_AT: AtomicI64 = AtomicI64::new(0);

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
/// One session per source, plus the reasons any source couldn't be discovered this attempt.
fn discover_sessions(now: i64) -> (Vec<Session>, Vec<(&'static str, String)>) {
    let mut sessions = Vec::new();
    let mut errors = Vec::new();
    for (source, found) in [
        (SOURCE_IDE, ide_session()),
        (SOURCE_CLI_KEYCHAIN, cli_session(now)),
    ] {
        match found {
            Ok(Some(s)) => sessions.push(s),
            Ok(None) => {}
            Err(e) => errors.push((source, e)),
        }
    }
    (sessions, errors)
}

/// Fetch one session's usage-summary and build its snapshot entry (keeping the previous summary on
/// failure). Returns `(entry, fetched_ok)`.
fn fetch_account(s: &Session, prev: Value, now: i64) -> (Value, bool) {
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
            acct["summary"] = summary;
            acct["fetchedAt"] = json!(now);
            acct["error"] = Value::Null;
            (acct, true)
        }
        Err(e) => {
            acct["error"] = Value::String(e);
            (acct, false)
        }
    }
}

/// The snapshot-level `lastError`, if this attempt deserves one.
fn snapshot_error(no_sessions: bool, any_ok: bool, discovery_text: &[String]) -> Option<String> {
    if no_sessions {
        return Some(if discovery_text.is_empty() {
            "no Cursor login found (Cursor IDE not signed in; cursor-agent Keychain account is \
             opt-in — see docs/USAGE_TAP.md)"
                .to_string()
        } else {
            discovery_text.join("; ")
        });
    }
    if !any_ok {
        return Some("every account fetch failed (see accounts[].error)".to_string());
    }
    (!discovery_text.is_empty()).then(|| discovery_text.join("; "))
}

pub(super) fn fetch_and_write() -> bool {
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
    let (sessions, discovery_errors) = discover_sessions(now);
    let mut accounts: Vec<Value> = Vec::new();
    let mut any_ok = false;
    for s in &sessions {
        let (acct, ok) = fetch_account(s, prev_for(s.source).unwrap_or_else(|| json!({})), now);
        any_ok |= ok;
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
    if let Some(e) = snapshot_error(sessions.is_empty(), any_ok, &discovery_text) {
        snap["lastError"] = Value::String(e);
    }
    // A failed snapshot write means the fresh numbers never became visible: report the refresh as
    // failed so `RefreshGate` backs off and retries, instead of leaving a stale snapshot behind a
    // "success".
    write_json_atomic(&path, &snap).is_ok() && any_ok
}
