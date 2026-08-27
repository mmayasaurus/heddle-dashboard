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
//!
//! HED-150 pt2: the window-keeper also writes `claude-<id>.oauth-usage.json` — an exact per-account
//! weekly Fable % pulled from the OAuth usage endpoint, refreshed independently of the tap.
//! `attribute()` stamps that value onto EVERY capture while the sidecar is fresh, not just when it
//! changes: a Fable-silent tap capture (the common case) would otherwise demote the drawer's bar
//! back to the heuristic estimate between OAuth refreshes. The converse is just as load-bearing —
//! once the sidecar stops being fresh, `attribute()` demotes out of exact mode explicitly, because
//! an unchanged tap capture never reaches the demotion inside `ingest()`. See `fable_attrib.rs` for
//! the exact-vs-estimate machinery this feeds.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::fable_attrib::{self, Attrib};
use super::{
    home, is_stale, mask_email, tap_limit, usage_dir, write_json_atomic, AccountLimit, LimitWindow,
    ProviderLimit, TAP_STALE_AFTER_SECS,
};

/// `~/.heddle/accounts.json`, relative to `$HOME`.
const REGISTRY_REL: &str = ".heddle/accounts.json";
pub(super) const CODE_NO_CAPTURE: &str = "claude.noCapture";
/// Unregistered per-account files (`claude-unknown-*.json`) are shown only while this recent.
const UNREGISTERED_MAX_AGE_SECS: i64 = 24 * 3600;
pub(super) const CODE_LIMIT_REACHED: &str = "claude.limitReached";
/// The keeper refreshes each account's `claude-<id>.oauth-usage.json` at most every
/// `HEDDLE_OAUTH_CACHE_SECS` (300s default) and backs a failing account off for
/// `HEDDLE_OAUTH_BACKOFF_SECS` (3600s default) — see `scripts/heddle-window-keeper.py`. A few
/// refresh cycles of slack tolerates one missed poll without falling back to the estimator, while
/// staying well short of a stuck backoff, so a sidecar the keeper has stopped refreshing goes stale
/// promptly instead of pinning a week-old % as "exact" indefinitely.
///
/// This is the FLOOR; the effective bound is `oauth_exact_stale_after_secs()`, which sizes itself off
/// the keeper's own configured cache interval.
const OAUTH_EXACT_STALE_AFTER_SECS: i64 = 900;
/// The keeper's own default for `HEDDLE_OAUTH_CACHE_SECS`, and the range its `int_env()` clamps that
/// setting into — mirrored here so a typo'd env can't stretch our freshness bound past what the
/// keeper itself would honour.
const OAUTH_CACHE_DEFAULT_SECS: i64 = 300;
const OAUTH_CACHE_MAX_SECS: i64 = 86_400;

/// Test seam for `HEDDLE_OAUTH_CACHE_SECS`: `cargo test` runs cases in parallel threads of ONE
/// process, so a real `set_var` would leak one case's keeper config into every other staleness
/// assertion. Thread-local, so a test only ever configures itself.
#[cfg(test)]
thread_local! {
    static CACHE_SECS_OVERRIDE: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

fn keeper_cache_secs_env() -> Option<String> {
    #[cfg(test)]
    if let Some(v) = CACHE_SECS_OVERRIDE.with(|c| c.borrow().clone()) {
        return Some(v);
    }
    std::env::var("HEDDLE_OAUTH_CACHE_SECS").ok()
}

/// How old the sidecar may be before it stops counting as exact: three of the keeper's own refresh
/// cycles, floored at `OAUTH_EXACT_STALE_AFTER_SECS`. An operator who sets
/// `HEDDLE_OAUTH_CACHE_SECS=3600` gets a sidecar that is legitimately up to an hour old, and a fixed
/// 900s bound would demote that account to the estimator between every single refresh. Unset,
/// unparseable, or out of the keeper's range → the keeper's own default/clamp, so the bound tracks
/// what the producer will actually do (at its 86400s maximum, three cycles is ~3 days).
///
/// Read per call rather than cached: the app and the launchd keeper are separate processes, and the
/// keeper's environment can change under a running app.
fn oauth_exact_stale_after_secs() -> i64 {
    let cache = keeper_cache_secs_env()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .map(|v| v.clamp(0, OAUTH_CACHE_MAX_SECS))
        .unwrap_or(OAUTH_CACHE_DEFAULT_SECS);
    OAUTH_EXACT_STALE_AFTER_SECS.max(cache.saturating_mul(3))
}

/// Mirror of the keeper's `safe_segment()` (`scripts/heddle-window-keeper.py`): every character
/// outside `[A-Za-z0-9._-]` becomes `_`. Only the OAuth sidecar is read through it, because that is
/// the filename the keeper builds this way — the tap/keeper-anchor/attrib reads elsewhere in this
/// module still use the raw id, a pre-existing inconsistency that is tracked separately rather than
/// widened here.
fn safe_segment(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// One registered Claude account.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Account {
    pub id: String,
    /// `None` = the default `~/.claude` (never set `CLAUDE_CONFIG_DIR` for it).
    pub config_dir: Option<PathBuf>,
    pub email: Option<String>,
    pub logged_in: Option<bool>,
}

pub(super) fn limit(now: i64) -> Option<ProviderLimit> {
    let registry = read_registry(&home().join(REGISTRY_REL));
    let active_env = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    build(&usage_dir(), &registry, active_env.as_deref(), now)
}

/// Rebuild Claude from its per-account captures, pinning the active-account selection to the id the
/// out-of-process limits mirror already carries. The headless Cursor keeper runs with no
/// `CLAUDE_CONFIG_DIR`, so resolving the active account from the environment would flip the mirror's
/// top-level to the default account; routing the mirror's own account through `build` keeps it.
/// This is exactly `build`'s active-account semantics — the top level shows the pinned account when
/// it has a capture, and otherwise falls back to the legacy last-seen file named by ITS account (not
/// the pinned one), so the label never disagrees with the numbers.
pub(super) fn limit_preserving_active(active_id: Option<&str>, now: i64) -> Option<ProviderLimit> {
    let registry = read_registry(&home().join(REGISTRY_REL));
    build_preserving_active(&usage_dir(), &registry, active_id, now)
}

/// Path-injectable implementation of [`limit_preserving_active`] for tests. A known active id
/// selects that account through `build` (via its `configDir`, or `None` for the null-configDir
/// default account); an absent or unknown id uses the same environment/default resolution as
/// [`limit`], never short-circuiting to `None`.
pub(super) fn build_preserving_active(
    dir: &Path,
    registry: &[Account],
    active_id: Option<&str>,
    now: i64,
) -> Option<ProviderLimit> {
    match active_id.and_then(|id| registry.iter().find(|account| account.id == id)) {
        Some(account) => build(dir, registry, account.config_dir.as_deref(), now),
        None => {
            let active_env = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
            build(dir, registry, active_env.as_deref(), now)
        }
    }
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
                        logged_in: a["loggedIn"].as_bool(),
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

/// The registered account whose non-default config directory exactly matches a running Claude
/// process. Unlike `active_account`, this never falls back to a default or first account: a pocket
/// client must not attribute a process when its environment was absent or not registered.
pub(crate) fn account_id_for_config_dir(config_dir: &Path) -> Option<String> {
    let registry = read_registry(&home().join(REGISTRY_REL));
    let want = config_dir.canonicalize().unwrap_or_else(|_| config_dir.to_path_buf());
    registry
        .into_iter()
        .find(|account| {
            account
                .config_dir
                .as_deref()
                .map(|path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf()) == want)
                .unwrap_or(false)
        })
        .map(|account| account.id)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `claude-<id>.<suffix>` files in the usage dir that are NOT a tap capture: our attribution state
/// plus every sidecar the window-keeper writes per account (`scripts/heddle-window-keeper.py`).
/// Matched by `ends_with`, so a one-off unregistered id literally ending in `.oauth-usage`,
/// `.keeper`, `.turns`, or `.dispatch` (e.g. `claude-foo.turns.json`) is excluded too — accepted:
/// real account ids never end in these tokens, and silently dropping such an id is strictly safer
/// than surfacing a phantom row for it. This just extends the long-standing `.attrib.json` exclusion.
/// A slice (not a fixed array) so adding a suffix needs no manual length bump.
const NON_ACCOUNT_SUFFIXES: &[&str] = &[
    ".attrib.json",
    ".oauth-usage.json",
    ".keeper.json",
    ".turns.json",
    // HED-181: the HED-178 dispatchability sidecar. It carries `checkedAt` not `capturedAt`, so the
    // recency gate below skips it TODAY — but that is the same schema-accident this list exists to
    // stop depending on. Exclude it by name so a future `capturedAt` (or a gate change) can't phantom it.
    ".dispatch.json",
];

/// Build the claude entry from `dir` (tap files) and the registry. Pure given the filesystem.
/// One row per registered account (registry order), plus rows for recent unregistered
/// `claude-<id>.json` files the tap wrote (a one-off `CLAUDE_CONFIG_DIR`); stale one-offs are
/// skipped so they can't haunt the roster forever.
fn account_rows(dir: &Path, registry: &[Account], now: i64) -> Vec<AccountLimit> {
    let mut rows: Vec<AccountLimit> = Vec::new();
    for a in registry {
        // Freshest of tap capture vs keeper anchor (HED-87), then Fable attribution (HED-75) —
        // an anchor-shaped file has null used_percentage, which attribute() already treats as
        // no-capture (it never seeds a historical estimate from nothing).
        let file = freshest_account_file(dir, &a.id);
        let attrib = attribute(dir, &a.id, file.as_ref(), now);
        rows.push(row(a, file.as_ref(), now, attrib.as_ref()));
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return rows;
    };
    let mut extra: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // Our own attribution state and the window-keeper's per-account sidecars are never
            // account files — excluded BY NAME, not by accident of their schema. `.oauth-usage.json`
            // is why this list exists: it strips to the id `<id>.oauth-usage`, and unlike the other
            // sidecars it carries a `capturedAt`, so the recency gate below waved it through as a
            // phantom account row that inflated the drawer's account count (HED-150 pt2 review).
            if NON_ACCOUNT_SUFFIXES.iter().any(|s| name.ends_with(s)) {
                return None;
            }
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
        let recent = file
            .as_ref()
            .and_then(|v| v["capturedAt"].as_i64())
            .map(|t| now - t <= UNREGISTERED_MAX_AGE_SECS)
            .unwrap_or(false);
        if !recent {
            continue;
        }
        let acct = Account {
            id: id.clone(),
            config_dir: file
                .as_ref()
                .and_then(|v| v["configDir"].as_str().map(PathBuf::from)),
            email: None,
            logged_in: None,
        };
        let attrib = attribute(dir, &id, file.as_ref(), now);
        rows.push(row(&acct, file.as_ref(), now, attrib.as_ref()));
    }
    rows
}

/// The statusline tap has measured usage; the keeper anchor records an otherwise invisible
/// headless ping. Match the keeper's `window()` rule: whichever was captured most recently wins.
fn freshest_account_file(dir: &Path, id: &str) -> Option<Value> {
    let tap = read_json(&dir.join(format!("claude-{id}.json")));
    let keeper = read_json(&dir.join(format!("claude-{id}.keeper.json"))).map(|anchor| {
        serde_json::json!({
            "capturedAt": anchor["startedAt"],
            "rate_limits": {
                "five_hour": {"used_percentage": Value::Null, "resets_at": anchor["resets_at"]},
                "seven_day": {"used_percentage": Value::Null, "resets_at": Value::Null},
            },
        })
    });
    match (tap, keeper) {
        (Some(tap), Some(keeper)) => {
            let tap_at = tap["capturedAt"].as_i64().unwrap_or_default();
            let keeper_at = keeper["capturedAt"].as_i64().unwrap_or_default();
            Some(if tap_at >= keeper_at { tap } else { keeper })
        }
        (tap, keeper) => tap.or(keeper),
    }
}

/// A fresh, valid reading from `claude-<id>.oauth-usage.json` (the window-keeper's sidecar,
/// HED-150 pt1): `{fablePct, fiveHourPct, sevenDayPct, byModel, capturedAt, source[, windowResetsAt]}`.
/// `fiveHourPct`/`sevenDayPct` are for Part-1 reconciliation/other consumers — never read here, the
/// tap alone drives the displayed 5h/7d windows. `None` for anything absent, malformed, out of
/// range, or stale — best-effort, same as the rest of `attribute()`.
struct OauthExact {
    fable_pct: f64,
    captured_at: i64,
    /// The Fable entry's own reset time, when the sidecar carries one — the weekly Fable window is
    /// not guaranteed to share the tap's `seven_day.resets_at` boundary. Verified against the
    /// shipped keeper (`scripts/heddle-window-keeper.py::oauth_usage_for`, 2026-08-18): it does NOT
    /// emit this field today, so callers fall back to the tap's own 7-day reset.
    window_resets_at: Option<i64>,
}

fn oauth_exact(dir: &Path, id: &str, now: i64) -> Option<OauthExact> {
    // Sanitized exactly as the keeper names the file it writes — an id with out-of-class characters
    // would otherwise look up a path that can never exist.
    let v = read_json(&dir.join(format!("claude-{}.oauth-usage.json", safe_segment(id))))?;
    let fable_pct = v["fablePct"]
        .as_f64()
        .filter(|p| p.is_finite() && (0.0..=100.0).contains(p))?;
    let captured_at = v["capturedAt"].as_i64()?;
    // A stamp from the FUTURE is clock skew or corruption, never freshness: `is_stale` reads its
    // negative age as "captured moments ago", which would pin that reading as exact indefinitely.
    if captured_at > now {
        return None;
    }
    if is_stale(Some(captured_at), now, oauth_exact_stale_after_secs()).unwrap_or(true) {
        return None;
    }
    Some(OauthExact {
        fable_pct,
        captured_at,
        window_resets_at: v["windowResetsAt"].as_i64(),
    })
}

/// Load this account's attribution state, fold in the current capture (if any), persist when it
/// changed, and return the state. Best-effort: an unreadable/unwritable attrib file just yields
/// whatever we could compute in memory.
/// Serializes every attribution read-modify-write: two overlapping `heddle_provider_limits` calls
/// must not both fold from the same persisted baseline and then overwrite each other's sample.
static ATTRIB_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn attribute(dir: &Path, id: &str, file: Option<&Value>, now: i64) -> Option<Attrib> {
    let _serialized = ATTRIB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join(format!("claude-{id}.attrib.json"));
    let mut state: Attrib = read_json(&path)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let mut cap = file.and_then(fable_attrib::capture_from_tap);
    // Stamp the OAuth exact reading onto EVERY capture while the sidecar is fresh, not just when it
    // changes: a statusline tap carries no Fable field, so a tap-only capture reaching `ingest()`
    // without `exact_fable_pct` set would hit its `seed_from_exact` branch and demote exact→estimate
    // — flickering the drawer between OAuth refreshes. Overrides any tap-derived exact (there isn't
    // one today — the tap never carries a Fable window — but the OAuth reading is authoritative
    // regardless).
    if let Some(exact) = oauth_exact(dir, id, now) {
        match &mut cap {
            Some(c) => {
                c.exact_fable_pct = Some(exact.fable_pct);
                if let Some(w) = exact.window_resets_at {
                    c.seven_day_resets_at = Some(w);
                }
            }
            None => {
                cap = Some(fable_attrib::Capture {
                    captured_at: exact.captured_at,
                    model: String::new(),
                    seven_day_used: None,
                    seven_day_resets_at: exact.window_resets_at,
                    exact_fable_pct: Some(exact.fable_pct),
                });
            }
        }
    }
    // Nothing this run carries an exact reading, yet the persisted state still claims one: the
    // sidecar went stale or vanished (in pt2 it is the ONLY source of exact), so the value behind it
    // is no longer backed by anything. Demote HERE rather than leaving it to `ingest`'s
    // `seed_from_exact` branch: with the tap capture UNCHANGED — the ordinary case when the keeper
    // stops refreshing — the duplicate guard drops that capture before the branch can run, and the
    // row would keep publishing the last exact % as exact for as long as the tap sat still. A merely
    // transient miss demotes too, and should: a fresh sidecar makes this `false` again on the same
    // run, and the estimator resumes from the seeded books.
    let demoted = state.exact && !cap.as_ref().is_some_and(|c| c.exact_fable_pct.is_some());
    if demoted {
        fable_attrib::expire_exact(&mut state, now);
    }
    let ingested = match &cap {
        Some(c) => fable_attrib::ingest(&mut state, c, now),
        None => false,
    };
    if demoted || ingested {
        // A lost write means the next process restart re-ingests from the older baseline and
        // double-counts a delta — rare, but never silent.
        match serde_json::to_value(&state) {
            Ok(v) => {
                if let Err(e) = write_json_atomic(&path, &v) {
                    eprintln!("[heddle] fable attribution for {id} not persisted: {e}");
                }
            }
            Err(e) => eprintln!("[heddle] fable attribution for {id} not serialized: {e}"),
        }
    }
    state.last_captured_at.is_some().then_some(state)
}

/// The tap-shaped empty entry, for when neither the active account nor the legacy file has data.
fn empty_top() -> ProviderLimit {
    ProviderLimit {
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
        fable_weekly_estimate_pct: None,
        fable_weekly_samples: None,
    }
}

/// No registry: the plain single-file tap entry, with the Fable estimate still accumulating
/// (attribution keyed "default").
fn single_file_mode(
    dir: &Path,
    legacy_file: Option<&Value>,
    legacy: Option<ProviderLimit>,
    now: i64,
) -> Option<ProviderLimit> {
    let attrib = attribute(dir, "default", legacy_file, now);
    let mut l = legacy?;
    l.fable_weekly_estimate_pct = attrib.as_ref().and_then(fable_attrib::estimate);
    l.fable_weekly_samples = attrib.map(|s| s.samples);
    Some(l)
}

pub(super) fn build(
    dir: &Path,
    registry: &[Account],
    env_dir: Option<&Path>,
    now: i64,
) -> Option<ProviderLimit> {
    let legacy_file = read_json(&dir.join("claude.json"));
    let legacy = legacy_file
        .as_ref()
        .and_then(|v| tap_limit("claude", v, now));
    if registry.is_empty() {
        return single_file_mode(dir, legacy_file.as_ref(), legacy, now);
    }
    let active = active_account(registry, env_dir);
    let rows = account_rows(dir, registry, now);
    // Top level = the active account's own file; fall back to the legacy last-seen file so the
    // summary never blanks just because the active account hasn't rendered since install — but
    // then `activeAccount` names the account the legacy capture actually came from (its `account`
    // field), never the selected one, so the label can't disagree with the numbers.
    let active_file = active.and_then(|a| read_json(&dir.join(format!("claude-{}.json", a.id))));
    let (top_from_active, legacy_account) = match &active_file {
        Some(_) => (true, None),
        None => (
            false,
            read_json(&dir.join("claude.json"))
                .and_then(|v| v["account"].as_str().map(str::to_string)),
        ),
    };
    let mut top = active_file
        .and_then(|v| tap_limit("claude", &v, now))
        .or(legacy)
        .unwrap_or_else(empty_top);
    top.model = top
        .model
        .map(|m| format!("{m} · {} acct", rows.len()))
        .or_else(|| Some(format!("{} acct", rows.len())));
    // On legacy fallback, only name an account that actually has a row — a stale/unknown id in
    // the legacy capture must not produce an `activeAccount` no consumer can resolve.
    top.active_account = if top_from_active {
        active.map(|a| a.id.clone())
    } else {
        legacy_account.filter(|id| rows.iter().any(|r| &r.id == id))
    };
    top.note_codes = Some(Vec::new());
    // The top-level Fable estimate belongs to whichever account the top level shows.
    if let Some(id) = top.active_account.clone() {
        if let Some(r) = rows.iter().find(|r| r.id == id) {
            top.fable_weekly_estimate_pct = r.fable_weekly_estimate_pct;
            top.fable_weekly_samples = r.fable_weekly_samples;
        }
    }
    top.accounts = Some(rows);
    top.windows = Some(Vec::new());
    Some(top)
}

/// One account row from its tap file (or none yet).
/// The row for an account with no tap file yet: everything unknown, explained by a note.
fn row_no_capture(
    a: &Account,
    label: String,
    detail: Value,
    fable_est: Option<f64>,
    fable_samples: Option<i64>,
) -> AccountLimit {
    AccountLimit {
        id: a.id.clone(),
        label,
        plan: None,
        logged_in: a.logged_in,
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
        fable_weekly_estimate_pct: fable_est,
        fable_weekly_samples: fable_samples,
    }
}

/// One account row from its tap file (or none yet) plus its Fable attribution state.
fn row(a: &Account, file: Option<&Value>, now: i64, attrib: Option<&Attrib>) -> AccountLimit {
    let label = a
        .email
        .as_deref()
        .map(mask_email)
        .unwrap_or_else(|| a.id.clone());
    let detail = serde_json::json!({
        "account": a.id,
        "configDir": a.config_dir.as_ref().map(|p| p.to_string_lossy().to_string()),
        "model": file.and_then(|v| v["model"].as_str()),
        "fableWeekly": attrib.map(fable_attrib::detail),
    });
    let fable_est = attrib.and_then(fable_attrib::estimate);
    let fable_samples = attrib.map(|s| s.samples);
    let Some(v) = file else {
        // No current capture: don't surface a historical estimate next to a "no capture yet" note —
        // UNLESS the attribution is a FRESH exact OAuth reading (HED-150 pt2): that's a live current
        // signal, not a stale guess, so it surfaces even though the tap itself is silent right now.
        // A non-exact (or now-stale) estimate stays suppressed exactly as before; the breakdown
        // (with lastCapturedAt) is always in `detail.fableWeekly` for the tooltip.
        let fresh_exact = attrib.is_some_and(|s| {
            s.exact
                && !is_stale(s.last_captured_at, now, oauth_exact_stale_after_secs())
                    .unwrap_or(true)
        });
        return row_no_capture(
            a,
            label,
            detail,
            if fresh_exact { fable_est } else { None },
            if fresh_exact { fable_samples } else { None },
        );
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
    AccountLimit {
        id: a.id.clone(),
        label,
        plan: None,
        logged_in: a.logged_in,
        captured_at,
        stale: is_stale(captured_at, now, TAP_STALE_AFTER_SECS),
        five_hour,
        seven_day,
        windows: Vec::new(),
        limit_reached: if has_data { Some(reached) } else { None },
        note: reached.then(|| "rate limit reached (a window is at 100%)".to_string()),
        note_codes: if reached {
            vec![CODE_LIMIT_REACHED.to_string()]
        } else {
            Vec::new()
        },
        detail: Some(detail),
        fable_weekly_estimate_pct: fable_est,
        fable_weekly_samples: fable_samples,
    }
}

#[cfg(test)]
#[path = "claude_tests.rs"]
mod tests;
