//! Claude caps from the statusline tap, per account.
//!
//! The tap (`~/.heddle/usage-tap.mjs`) writes the legacy `~/.heddle/usage/claude.json` (last
//! session that rendered, any account) AND, when `~/.heddle/accounts.json` maps the session's
//! `CLAUDE_CONFIG_DIR` to an account, `claude-<acctId>.json` (same tap shape + `account`,
//! `configDir`). The registry `accounts.json` → `claude[]: {id, configDir|null, email, loggedIn}`
//! (`configDir: null` = the default `~/.claude`). A launchd window-keeper pings each account so
//! every file exists and stays fresh; an account that never rendered simply has no file yet.
//!
//! The entry's top-level `fiveHour`/`sevenDay` are the ACTIVE account's — the account this process
//! is on (`CLAUDE_CONFIG_DIR` → registry, else the default) — so the summary bar stays "the account
//! you're on"; `accounts[]` carries every registered account (masked email, own windows, own
//! capture time / staleness, `limitReached` at ≥100%), and `activeAccount` names the row.
//! Without a registry this degrades to the plain single-file tap entry (`accounts: None`).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    home, is_stale, mask_email, tap_limit, usage_dir, AccountLimit, LimitWindow, ProviderLimit,
    TAP_STALE_AFTER_SECS,
};

/// `~/.heddle/accounts.json`, relative to `$HOME`.
const REGISTRY_REL: &str = ".heddle/accounts.json";
pub(super) const CODE_NO_CAPTURE: &str = "claude.noCapture";
pub(super) const CODE_LIMIT_REACHED: &str = "claude.limitReached";

/// One registered Claude account.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Account {
    pub id: String,
    /// `None` = the default `~/.claude` (never set `CLAUDE_CONFIG_DIR` for it).
    pub config_dir: Option<PathBuf>,
    pub email: Option<String>,
}

pub(super) fn limit(now: i64) -> Option<ProviderLimit> {
    let registry = read_registry(&home().join(REGISTRY_REL));
    let active_env = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    build(&usage_dir(), &registry, active_env.as_deref(), now)
}

/// Parse `accounts.json` → `claude[]`. Missing/invalid file → empty registry.
pub(super) fn read_registry(path: &Path) -> Vec<Account> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    parse_registry(&v)
}

pub(super) fn parse_registry(v: &Value) -> Vec<Account> {
    v["claude"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    let id = a["id"].as_str()?.to_string();
                    Some(Account {
                        id,
                        config_dir: a["configDir"].as_str().map(PathBuf::from),
                        email: a["email"].as_str().map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Which registered account this process runs as: the one whose `configDir` matches
/// `CLAUDE_CONFIG_DIR` (canonicalized when possible), else the default (`configDir: null`), else
/// the first. `None` for an empty registry.
pub(super) fn active_account<'a>(
    registry: &'a [Account],
    env_dir: Option<&Path>,
) -> Option<&'a Account> {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    if let Some(env) = env_dir {
        let want = canon(env);
        if let Some(a) = registry
            .iter()
            .find(|a| a.config_dir.as_deref().map(canon) == Some(want.clone()))
        {
            return Some(a);
        }
    }
    registry
        .iter()
        .find(|a| a.config_dir.is_none())
        .or_else(|| registry.first())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Build the claude entry from `dir` (tap files) and the registry. Pure given the filesystem.
pub(super) fn build(
    dir: &Path,
    registry: &[Account],
    env_dir: Option<&Path>,
    now: i64,
) -> Option<ProviderLimit> {
    let legacy = read_json(&dir.join("claude.json")).and_then(|v| tap_limit("claude", &v, now));
    if registry.is_empty() {
        return legacy;
    }
    let active = active_account(registry, env_dir);
    let mut rows: Vec<AccountLimit> = Vec::new();
    for a in registry {
        let file = read_json(&dir.join(format!("claude-{}.json", a.id)));
        rows.push(row(a, file.as_ref(), now));
    }
    // Per-account files the tap wrote for config dirs that aren't registered (`unknown-<dir>`).
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut extra: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let id = name
                    .strip_prefix("claude-")?
                    .strip_suffix(".json")?
                    .to_string();
                (!registry.iter().any(|a| a.id == id)).then_some(id)
            })
            .collect();
        extra.sort();
        for id in extra {
            let file = read_json(&dir.join(format!("claude-{id}.json")));
            let acct = Account {
                id: id.clone(),
                config_dir: file
                    .as_ref()
                    .and_then(|v| v["configDir"].as_str().map(PathBuf::from)),
                email: None,
            };
            rows.push(row(&acct, file.as_ref(), now));
        }
    }
    // Top level = the active account's own file; fall back to the legacy last-seen file so the
    // summary never blanks just because the active account hasn't rendered since install.
    let active_file = active.and_then(|a| read_json(&dir.join(format!("claude-{}.json", a.id))));
    let mut top = active_file
        .and_then(|v| tap_limit("claude", &v, now))
        .or(legacy)
        .unwrap_or_else(|| ProviderLimit {
            provider: "claude".to_string(),
            model: None,
            captured_at: None,
            five_hour: LimitWindow::default(),
            seven_day: LimitWindow::default(),
            source: Some("statusline-tap".to_string()),
            stale: None,
            stale_after_secs: Some(TAP_STALE_AFTER_SECS),
            note: None,
            note_codes: None,
            accounts: None,
            active_account: None,
            windows: None,
        });
    top.model = top
        .model
        .map(|m| format!("{m} · {} acct", rows.len()))
        .or_else(|| Some(format!("{} acct", rows.len())));
    top.active_account = active.map(|a| a.id.clone());
    top.note_codes = Some(Vec::new());
    top.accounts = Some(rows);
    top.windows = Some(Vec::new());
    Some(top)
}

/// One account row from its tap file (or none yet).
fn row(a: &Account, file: Option<&Value>, now: i64) -> AccountLimit {
    let label = a
        .email
        .as_deref()
        .map(mask_email)
        .unwrap_or_else(|| a.id.clone());
    let detail = serde_json::json!({
        "account": a.id,
        "configDir": a.config_dir.as_ref().map(|p| p.to_string_lossy().to_string()),
        "model": file.and_then(|v| v["model"].as_str()),
    });
    let Some(v) = file else {
        return AccountLimit {
            id: a.id.clone(),
            label,
            plan: None,
            captured_at: None,
            stale: None,
            five_hour: LimitWindow::default(),
            seven_day: LimitWindow::default(),
            windows: Vec::new(),
            limit_reached: None,
            note: Some(
                "no capture yet — no session on this account has rendered a statusline since the \
                 tap was installed"
                    .to_string(),
            ),
            note_codes: vec![CODE_NO_CAPTURE.to_string()],
            detail: Some(detail),
        };
    };
    let rl = &v["rate_limits"];
    let win = |k: &str| LimitWindow {
        used_percentage: rl[k]["used_percentage"].as_f64(),
        resets_at: rl[k]["resets_at"].as_i64(),
    };
    let five_hour = win("five_hour");
    let seven_day = win("seven_day");
    let captured_at = v["capturedAt"].as_i64();
    let has_data = five_hour.used_percentage.is_some() || seven_day.used_percentage.is_some();
    let reached = five_hour.used_percentage.unwrap_or(0.0) >= 100.0
        || seven_day.used_percentage.unwrap_or(0.0) >= 100.0;
    let mut codes = Vec::new();
    let mut texts = Vec::new();
    if reached {
        codes.push(CODE_LIMIT_REACHED.to_string());
        texts.push("rate limit reached (a window is at 100%)".to_string());
    }
    AccountLimit {
        id: a.id.clone(),
        label,
        plan: None,
        captured_at,
        stale: is_stale(captured_at, now, TAP_STALE_AFTER_SECS),
        five_hour,
        seven_day,
        windows: Vec::new(),
        limit_reached: if has_data { Some(reached) } else { None },
        note: if texts.is_empty() {
            None
        } else {
            Some(texts.join("; "))
        },
        note_codes: codes,
        detail: Some(detail),
    }
}

#[cfg(test)]
#[path = "claude_tests.rs"]
mod tests;
