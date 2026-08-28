//! Fleet roster for the Fleet drawer (Agent R's feature, moved here verbatim from the pre-split
//! `heddle_stats.rs`): live Claude Code fleet orchestrators (`~/.claude/sessions/*.json`, alive by
//! `kill(pid, 0)`) with the in-flight heddle workers each one owns, plus an "(orphaned)" bucket
//! for workers whose orchestrator is gone.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{home, ledger};

/// One in-flight heddle worker, grouped under its live fleet orchestrator for the Fleet drawer.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    id: i64,
    task_class: String,
    provider: String,
    model: String,
    started_at: String,
    cwd: String,
    elapsed_ms: i64,
    stale: bool,
}

/// A live Claude Code fleet orchestrator and the heddle workers it currently owns.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetAgent {
    pub(crate) name: String,
    /// The agent's own `claude --model <id>` argv, when its process is live and the flag is
    /// present. Never guessed: absent flag, dead process, or an unreadable ps call all yield `None`.
    pub(crate) model: Option<String>,
    pub(crate) pid: i64,
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) status: String,
    pub(crate) kind: String,
    pub(crate) updated_at_ms: i64,
    pub(crate) alive: bool,
    pub(crate) workers: Vec<Worker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hud: Option<Hud>,
}

/// Per-session statusline and project facts for the Fleet drawer.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hud {
    pub model: Option<String>,
    pub context_pct: Option<f64>,
    pub captured_at: i64,
    /// The capture updates each statusline render, so a live-but-idle session can age; `alive`
    /// remains the primary liveness signal and stale only dims the hud numbers, never hides the row.
    pub stale: bool,
    pub git_branch: Option<String>,
    pub git_dirty: bool,
    pub claude_md_count: u32,
    pub rules_count: u32,
    pub mcp_count: u32,
}

/// The capture updates each statusline render, so a live-but-idle session can age; `alive` remains
/// the primary liveness signal and stale only dims the hud numbers, never hides the row.
const HUD_STALE_SECS: i64 = 900;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SessionCapture {
    model: Option<String>,
    context_pct: Option<f64>,
    captured_at: Option<i64>,
}

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

/// Mirrors `safeSessionSegment` / `shortHash` in `scripts/heddle-usage-tap.mjs`.
fn session_capture_path(home: &Path, session_id: &str) -> PathBuf {
    let safe: String = session_id
        .encode_utf16()
        .map(|unit| {
            if matches!(unit, 0x41..=0x5a | 0x61..=0x7a | 0x30..=0x39 | 0x2e | 0x5f | 0x2d) {
                char::from_u32(unit as u32).unwrap()
            } else {
                '_'
            }
        })
        .collect();
    let base = if safe == session_id {
        safe
    } else {
        let hash = Sha256::digest(session_id.as_bytes());
        format!(
            "{safe}-{:02x}{:02x}{:02x}{:02x}",
            hash[0], hash[1], hash[2], hash[3]
        )
    };
    home.join(".heddle")
        .join("sessions")
        .join(format!("{base}.json"))
}

fn claude_md_count(cwd: &str) -> u32 {
    if cwd.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut directory = PathBuf::from(cwd);
    loop {
        if directory.join("CLAUDE.md").is_file() {
            count += 1;
        }
        if !directory.pop() {
            break;
        }
    }
    count
}

fn rules_count(cwd: &str) -> u32 {
    if cwd.is_empty() {
        return 0;
    }
    let mut directory = PathBuf::from(cwd);
    loop {
        let rules = directory.join(".claude").join("rules");
        if rules.is_dir() {
            return std::fs::read_dir(rules)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .filter(|entry| {
                    entry
                        .file_type()
                        .map(|kind| kind.is_file())
                        .unwrap_or(false)
                        && entry
                            .path()
                            .extension()
                            .and_then(|extension| extension.to_str())
                            == Some("md")
                })
                .count() as u32;
        }
        if !directory.pop() {
            return 0;
        }
    }
}

fn mcp_server_names(path: &Path) -> HashSet<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashSet::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return HashSet::new();
    };
    let Some(top_level) = value.as_object() else {
        return HashSet::new();
    };
    let servers = match top_level.get("mcpServers") {
        Some(value) => match value.as_object() {
            Some(servers) => servers,
            None => return HashSet::new(),
        },
        None => top_level,
    };
    servers
        .keys()
        .cloned()
        .collect()
}

fn mcp_count(cwd: &str) -> u32 {
    if cwd.is_empty() {
        return 0;
    }
    let mut directory = PathBuf::from(cwd);
    loop {
        let mcp = directory.join(".mcp.json");
        let claude_mcp = directory.join(".claude").join("mcp.json");
        if mcp.is_file() || claude_mcp.is_file() {
            return mcp_server_names(&mcp)
                .into_iter()
                .chain(mcp_server_names(&claude_mcp))
                .collect::<HashSet<_>>()
                .len() as u32;
        }
        if !directory.pop() {
            return 0;
        }
    }
}

/// Joins an agent's session capture with best-effort project facts. Missing or invalid data simply
/// leaves the row without a HUD.
fn hud_for(home: &Path, session_id: &str, cwd: &str) -> Option<Hud> {
    if session_id.is_empty() {
        return None;
    }
    let text = std::fs::read_to_string(session_capture_path(home, session_id)).ok()?;
    let capture = serde_json::from_str::<SessionCapture>(&text).ok()?;
    let captured_at = capture.captured_at.unwrap_or_default();
    let now = now_epoch_secs();
    let git = crate::git::status(cwd);
    Some(Hud {
        model: capture.model,
        context_pct: capture.context_pct,
        captured_at,
        stale: now.saturating_sub(captured_at) > HUD_STALE_SECS,
        git_branch: git.branch,
        git_dirty: git.staged + git.unstaged + git.untracked > 0,
        claude_md_count: claude_md_count(cwd),
        rules_count: rules_count(cwd),
        mcp_count: mcp_count(cwd),
    })
}

fn process_alive(pid: i32) -> bool {
    // `kill(pid, 0)` does not send a signal; EPERM means the process exists but belongs to another
    // user, which is still live for roster purposes. Only positive pids are probed: 0 / negative
    // values address process groups (or every process), which is never what a session file means.
    if pid <= 0 {
        return false;
    }
    // Audited: signal 0 is a pure existence probe (POSIX kill(2)); the only argument is a
    // range-checked i32, no memory is touched, and no pointer crosses the FFI boundary.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// Split one `ps -o pid=,...=` output line into its leading pid and the rest of the line (comm or
/// args, depending on which ps call produced it). Shared by `parse_ps_liveness` and
/// `parse_ps_args`: both `-o pid=,comm=` and `-o pid=,args=` output share the same "first token is
/// pid, rest of the line is the field" shape (a combined pid/comm/args line would be ambiguous to
/// split, since `comm` can itself contain spaces — see the `Google Chrome H` fixture below).
fn parse_ps_pid_line(line: &str) -> Option<(i32, &str)> {
    let mut fields = line.trim_start().splitn(2, char::is_whitespace);
    let pid = fields.next()?.trim().parse().ok()?;
    let rest = fields.next()?.trim();
    Some((pid, rest))
}

/// Parse `ps -o pid=,comm=` output into a liveness verdict per listed PID. A session PID may be
/// reused after Claude exits, so existence alone is not enough: its executable must still be Claude.
fn parse_ps_liveness(output: &str, expect: &str) -> HashMap<i32, bool> {
    output
        .lines()
        .filter_map(|line| {
            let (pid, comm) = parse_ps_pid_line(line)?;
            let basename = std::path::Path::new(comm)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(comm);
            // Linux caveat: `comm` truncates to 15 characters and node-wrapper launches report
            // `node`; this macOS-only app does not handle either case.
            let basename = basename.to_ascii_lowercase();
            let expect = expect.to_ascii_lowercase();
            Some((
                pid,
                basename == expect || basename == format!("{expect}.exe"),
            ))
        })
        .collect()
}

/// Parse `ps -o pid=,args=` output into the raw argv string per listed PID. A SEPARATE ps call
/// from `parse_ps_liveness` rather than a third `-o` column tacked onto it: `comm` can itself
/// contain spaces (see the `Google Chrome H` fixture below), so a combined pid/comm/args line
/// would be ambiguous to split. Shares the same pid-line split as the liveness parser via
/// `parse_ps_pid_line`.
fn parse_ps_args(output: &str) -> HashMap<i32, String> {
    output
        .lines()
        .filter_map(|line| {
            let (pid, args) = parse_ps_pid_line(line)?;
            Some((pid, args.to_string()))
        })
        .collect()
}

/// Parse a `--model <id>` / `--model=<id>` flag out of a process's argv string. The heddle
/// launcher always passes `--model` on resumes; a process with no flag, a trailing `--model` with
/// nothing after it, or a `--model` immediately followed by another flag (never a value) all yield
/// `None` rather than a guess. Requires argv[0] — the leading token, i.e. the executable path — to
/// itself be a `claude`/`claude.exe` basename: this argv snapshot comes from a SEPARATE ps call
/// from the liveness one (see `verify_and_retain`), so a pid reused in the gap between the two
/// calls (old claude exited, new unrelated process reused the pid) would otherwise hand back that
/// unrelated process's argv as this agent's "model"; it also blocks a non-claude row whose visible
/// text (e.g. prompt content in someone else's args) happens to contain the literal `--model`.
fn parse_model_flag(args: &str) -> Option<String> {
    let mut tokens = args.split_whitespace();
    let exe = tokens.next()?;
    let basename = std::path::Path::new(exe)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(exe)
        .to_ascii_lowercase();
    if basename != "claude" && basename != "claude.exe" {
        return None;
    }
    let tokens: Vec<&str> = tokens.collect();
    for (index, token) in tokens.iter().enumerate() {
        if let Some(value) = token.strip_prefix("--model=") {
            return (!value.is_empty()).then(|| value.to_string());
        }
        if *token == "--model" {
            return tokens
                .get(index + 1)
                .filter(|value| !value.starts_with('-'))
                .map(|value| value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn write_session_capture(home: &Path, session_id: &str, capture: serde_json::Value) {
        let path = session_capture_path(home, session_id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, capture.to_string()).unwrap();
    }

    #[test]
    fn hud_joins_session_capture_and_project_counts() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().join("agent/subdir");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(project.path().join("CLAUDE.md"), "project instructions").unwrap();
        std::fs::write(cwd.join("CLAUDE.md"), "agent instructions").unwrap();
        let rules = project.path().join(".claude/rules");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::write(rules.join("one.md"), "one").unwrap();
        std::fs::write(rules.join("two.md"), "two").unwrap();
        std::fs::write(
            project.path().join(".mcp.json"),
            r#"{"mcpServers":{"alpha":{},"beta":{}}}"#,
        )
        .unwrap();
        std::fs::write(
            project.path().join(".claude/mcp.json"),
            r#"{"mcpServers":{"beta":{},"gamma":{}}}"#,
        )
        .unwrap();
        let session_id = "session/with slash";
        write_session_capture(
            home.path(),
            session_id,
            serde_json::json!({
                "sessionId": session_id,
                "model": "claude-test",
                "contextPct": 42.0,
                "capturedAt": super::now_epoch_secs(),
            }),
        );

        let hud = hud_for(home.path(), session_id, &cwd.display().to_string())
            .expect("capture should attach a HUD");

        assert_eq!(hud.model.as_deref(), Some("claude-test"));
        assert_eq!(hud.context_pct, Some(42.0));
        assert!(!hud.stale);
        assert_eq!(hud.claude_md_count, 2);
        assert_eq!(hud.rules_count, 2);
        assert_eq!(hud.mcp_count, 3);
    }

    #[test]
    fn hud_marks_aged_captures_stale_but_not_fresh_ones() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let now = super::now_epoch_secs();
        write_session_capture(
            home.path(),
            "aged",
            serde_json::json!({"capturedAt": now - 1_000}),
        );
        write_session_capture(home.path(), "fresh", serde_json::json!({"capturedAt": now}));

        assert!(
            hud_for(home.path(), "aged", &cwd.path().display().to_string())
                .expect("aged capture")
                .stale
        );
        assert!(
            !hud_for(home.path(), "fresh", &cwd.path().display().to_string())
                .expect("fresh capture")
                .stale
        );
    }

    #[test]
    fn hud_is_absent_without_a_capture_or_session_id() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        assert!(hud_for(home.path(), "missing", &cwd.path().display().to_string()).is_none());
        assert!(hud_for(home.path(), "", &cwd.path().display().to_string()).is_none());
    }

    #[test]
    fn hud_reports_dirty_git_facts_and_non_repo_fallback() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let repo_path = repo.path().to_str().unwrap();
        // A realistic agent cwd has at least one commit, so HEAD resolves and the branch name is
        // returned. A fresh `git init` with no commit leaves HEAD unborn and `rev-parse
        // --abbrev-ref HEAD` yields no branch — not the state a live roster ever sees.
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .status()
                .unwrap()
                .success()
        };
        assert!(git(&["init", "--quiet", "-b", "main", repo_path]));
        assert!(git(&["-C", repo_path, "config", "user.email", "t@example.com"]));
        assert!(git(&["-C", repo_path, "config", "user.name", "Test"]));
        std::fs::write(repo.path().join("seed.txt"), "seed").unwrap();
        assert!(git(&["-C", repo_path, "add", "-A"]));
        assert!(git(&[
            "-C",
            repo_path,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "--quiet",
            "-m",
            "seed",
        ]));
        // A staged-only change must still mark the tree dirty.
        std::fs::write(repo.path().join("staged.txt"), "staged").unwrap();
        assert!(git(&["-C", repo_path, "add", "staged.txt"]));
        let plain = tempfile::tempdir().unwrap();
        let now = super::now_epoch_secs();
        write_session_capture(home.path(), "repo", serde_json::json!({"capturedAt": now}));
        write_session_capture(home.path(), "plain", serde_json::json!({"capturedAt": now}));

        let repo_hud = hud_for(home.path(), "repo", &repo.path().display().to_string())
            .expect("repo HUD");
        assert!(repo_hud.git_branch.is_some());
        assert!(repo_hud.git_dirty);

        let plain_hud = hud_for(home.path(), "plain", &plain.path().display().to_string())
            .expect("plain HUD");
        assert_eq!(plain_hud.git_branch, None);
        assert!(!plain_hud.git_dirty);
    }

    #[test]
    fn hud_uses_tap_hashed_filename_for_sanitized_session_ids() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let session_id = "session/needs sanitizing";
        assert_eq!(
            session_capture_path(home.path(), session_id).file_name().unwrap(),
            "session_needs_sanitizing-58e0a636.json"
        );
        assert_eq!(
            session_capture_path(home.path(), "café").file_name().unwrap(),
            "caf_-850f7dc4.json"
        );
        assert_eq!(
            session_capture_path(home.path(), "sess😀").file_name().unwrap(),
            "sess__-ee7cb0f6.json"
        );
        assert_eq!(
            session_capture_path(home.path(), "3b1e4c7a-0000-4000-8000-000000000000")
                .file_name()
                .unwrap(),
            "3b1e4c7a-0000-4000-8000-000000000000.json"
        );
        write_session_capture(
            home.path(),
            session_id,
            serde_json::json!({"model": "found-through-hash", "capturedAt": super::now_epoch_secs()}),
        );

        let hud = hud_for(home.path(), session_id, &cwd.path().display().to_string())
            .expect("hashed session filename should join");
        assert_eq!(hud.model.as_deref(), Some("found-through-hash"));
    }

    #[test]
    fn fleet_agent_hud_serialization_is_optional_and_camel_case() {
        let agent = |hud| FleetAgent {
            name: "T".to_string(),
            model: None,
            pid: 1,
            session_id: "session".to_string(),
            cwd: String::new(),
            status: String::new(),
            kind: String::new(),
            updated_at_ms: 0,
            alive: true,
            workers: vec![],
            hud,
        };

        let without_hud = serde_json::to_value(agent(None)).unwrap();
        assert!(without_hud.get("hud").is_none());

        let with_hud = serde_json::to_value(agent(Some(Hud {
            model: Some("claude-test".to_string()),
            context_pct: Some(12.0),
            captured_at: 123,
            stale: false,
            git_branch: Some("main".to_string()),
            git_dirty: true,
            claude_md_count: 1,
            rules_count: 2,
            mcp_count: 3,
        })))
        .unwrap();
        let hud = &with_hud["hud"];
        assert_eq!(hud["contextPct"], 12.0);
        assert_eq!(hud["gitBranch"], "main");
        assert_eq!(hud["claudeMdCount"], 1);
        assert_eq!(hud["rulesCount"], 2);
        assert_eq!(hud["mcpCount"], 3);
    }

    #[test]
    fn empty_ps_output_means_all_dead_not_ps_failure() {
        // macOS `ps -p` exits non-zero with EMPTY stdout when none of the pids exist — that is a
        // legitimate all-dead verdict, not a ps failure, and must map every pid to dead rather
        // than falling back to the pid-reuse-prone kill(2) probe (gitar, PR #23 round 3).
        let live = parse_ps_liveness("", "claude");
        assert!(live.is_empty());
        assert!(!live.get(&101).copied().unwrap_or(false));
    }

    #[test]
    fn ps_liveness_requires_a_claude_executable_for_each_candidate_pid() {
        let live = parse_ps_liveness(
            "  101 Google Chrome H\n  102 claude\n  103 /Users/x/.local/bin/claude\n  104 claude-helper\n  105 not-claude\n  106 CLAUDE.EXE\n",
            "claude",
        );

        assert_eq!(live.get(&101), Some(&false));
        assert_eq!(live.get(&102), Some(&true));
        assert_eq!(live.get(&103), Some(&true));
        assert_eq!(live.get(&104), Some(&false));
        assert_eq!(live.get(&105), Some(&false));
        assert_eq!(live.get(&106), Some(&true));
        assert!(!live.get(&104).copied().unwrap_or(false));
    }

    #[test]
    fn worker_matching_prefers_the_live_duplicate_agent_name() {
        let agents = vec![
            FleetAgent {
                name: "r".to_string(),
                model: None,
                pid: 1,
                session_id: String::new(),
                cwd: String::new(),
                status: String::new(),
                kind: String::new(),
                updated_at_ms: 0,
                alive: false,
                workers: vec![],
                hud: None,
            },
            FleetAgent {
                name: "r".to_string(),
                model: None,
                pid: 2,
                session_id: String::new(),
                cwd: String::new(),
                status: String::new(),
                kind: String::new(),
                updated_at_ms: 0,
                alive: true,
                workers: vec![],
                hud: None,
            },
        ];

        assert_eq!(matching_agent_index(&agents, Some("r")), Some(1));
    }

    #[test]
    fn regression_pr_169_project_agents_use_their_broker_addresses_from_exact_worktrees() {
        let agents = vec![
            FleetAgent {
                name: "R".to_string(),
                model: None,
                pid: 1,
                session_id: String::new(),
                cwd: "/projects/spinventory/.worktrees/r".to_string(),
                status: String::new(),
                kind: String::new(),
                updated_at_ms: 0,
                alive: true,
                workers: vec![],
                hud: None,
            },
            FleetAgent {
                name: "S".to_string(),
                model: None,
                pid: 2,
                session_id: String::new(),
                cwd: "/projects/spinventory".to_string(),
                status: String::new(),
                kind: String::new(),
                updated_at_ms: 0,
                alive: true,
                workers: vec![],
                hud: None,
            },
            FleetAgent {
                name: "T".to_string(),
                model: None,
                pid: 3,
                session_id: String::new(),
                cwd: "/projects/spinventory-not-a-worktree".to_string(),
                status: String::new(),
                kind: String::new(),
                updated_at_ms: 0,
                alive: true,
                workers: vec![],
                hud: None,
            },
        ];
        let worktrees = vec![
            "/projects/spinventory".to_string(),
            "/projects/spinventory/.worktrees/r".to_string(),
        ];

        assert_eq!(
            project_agent_addresses_in_worktrees(&worktrees, &agents),
            std::collections::BTreeSet::from(["R".to_string(), "S".to_string()])
        );
    }

    #[test]
    fn regression_pr_83_non_git_project_root_remains_an_agent_scope() {
        let non_git_root = "/projects/plain-directory";
        let worktrees = project_worktrees_or_root(
            non_git_root,
            Err("Not a git repository: /projects/plain-directory".to_string()),
        );
        let agents = vec![FleetAgent {
            name: "R".to_string(),
            model: None,
            pid: 1,
            session_id: String::new(),
            cwd: "/projects/plain-directory/nested".to_string(),
            status: String::new(),
            kind: String::new(),
            updated_at_ms: 0,
            alive: true,
            workers: vec![],
            hud: None,
        }];

        assert_eq!(worktrees, vec![non_git_root.to_string()]);
        assert_eq!(
            project_agent_addresses_in_worktrees(&worktrees, &agents),
            BTreeSet::from(["R".to_string()])
        );
    }

    #[test]
    fn regression_pr_83_dead_agents_are_excluded_from_room_membership() {
        // `live_fleet_agents` keeps recently-exited sessions with alive = false for display; those
        // must NOT be provisioned as default-room members. Only the live in-scope agent is retained.
        let worktrees = vec!["/projects/app".to_string()];
        let agents = vec![
            FleetAgent {
                name: "LIVE".to_string(),
                model: None,
                pid: 1,
                session_id: String::new(),
                cwd: "/projects/app".to_string(),
                status: String::new(),
                kind: String::new(),
                updated_at_ms: 0,
                alive: true,
                workers: vec![],
                hud: None,
            },
            FleetAgent {
                name: "DEAD".to_string(),
                model: None,
                pid: 2,
                session_id: String::new(),
                cwd: "/projects/app".to_string(),
                status: String::new(),
                kind: String::new(),
                updated_at_ms: 0,
                alive: false,
                workers: vec![],
                hud: None,
            },
        ];

        assert_eq!(
            project_agent_addresses_in_worktrees(&worktrees, &agents),
            BTreeSet::from(["LIVE".to_string()])
        );
    }

    #[test]
    fn ps_args_parses_pid_and_full_argv_line() {
        let args = parse_ps_args(
            "  101 claude --resume abc123 --model claude-opus-4-8\n  102 /usr/bin/claude --model=claude-fable-5\n",
        );
        assert_eq!(
            args.get(&101).map(String::as_str),
            Some("claude --resume abc123 --model claude-opus-4-8")
        );
        assert_eq!(
            args.get(&102).map(String::as_str),
            Some("/usr/bin/claude --model=claude-fable-5")
        );
    }

    #[test]
    fn model_flag_parses_space_form() {
        assert_eq!(
            parse_model_flag("claude --resume abc123 --model claude-opus-4-8"),
            Some("claude-opus-4-8".to_string())
        );
    }

    #[test]
    fn model_flag_parses_equals_form() {
        assert_eq!(
            parse_model_flag("claude --model=claude-fable-5 --resume abc123"),
            Some("claude-fable-5".to_string())
        );
    }

    #[test]
    fn model_flag_absent_is_none() {
        assert_eq!(parse_model_flag("claude --resume abc123"), None);
    }

    #[test]
    fn model_flag_last_token_missing_value_is_none() {
        assert_eq!(parse_model_flag("claude --resume abc123 --model"), None);
    }

    #[test]
    fn model_flag_next_token_starting_with_dash_is_none() {
        assert_eq!(
            parse_model_flag("claude --resume abc123 --model --resume xyz789"),
            None
        );
    }

    #[test]
    fn model_flag_requires_claude_argv0() {
        assert_eq!(parse_model_flag("not-claude --model claude-opus-4-8"), None);
    }

    #[test]
    fn model_flag_equals_form_with_full_path_argv0() {
        assert_eq!(
            parse_model_flag("/usr/local/bin/claude --model=claude-fable-5"),
            Some("claude-fable-5".to_string())
        );
    }

    #[test]
    fn model_flag_truncated_line_missing_trailing_value_is_none() {
        // Shape a `-ww`-less ps call could produce: the line runs right up to `--model` and gets
        // cut before its value — must fail safe to None, never guess from whatever follows.
        assert_eq!(
            parse_model_flag(
                "claude --resume abc123def456ghi789jkl012mno345pqr678stu901vwx234 --model"
            ),
            None
        );
    }
}

fn live_fleet_agents() -> Vec<FleetAgent> {
    let dir = home().join(".claude").join("sessions");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };

    let mut agents = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(name) = session["name"].as_str() else {
            continue;
        };
        if !(1..=3).contains(&name.chars().count()) {
            continue;
        }
        let Some(pid) = session["pid"].as_i64() else {
            continue;
        };
        let Ok(pid_for_kill) = i32::try_from(pid) else {
            continue;
        };
        if pid_for_kill <= 0 {
            continue;
        }
        let session_id = session["sessionId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let cwd = session["cwd"].as_str().unwrap_or_default().to_string();
        agents.push(FleetAgent {
            name: name.to_string(),
            model: None,
            pid,
            session_id,
            cwd,
            status: session["status"].as_str().unwrap_or_default().to_string(),
            kind: session["kind"].as_str().unwrap_or_default().to_string(),
            updated_at_ms: session["updatedAt"].as_i64().unwrap_or_default(),
            alive: false,
            workers: vec![],
            hud: None,
        });
    }
    if agents.is_empty() {
        return agents;
    }

    verify_and_retain(agents)
}

/// Broker addresses for fleet agents whose working directories belong to one of the project's
/// registered worktrees. `FleetAgent::name` is the broker address: the existing room member picker
/// passes it directly to `heddle_comms_add_member`.
pub fn project_agent_addresses(project_root: &str) -> Result<BTreeSet<String>, String> {
    let worktrees = project_worktrees_or_root(project_root, crate::git::list_project_worktrees(project_root));
    Ok(project_agent_addresses_in_worktrees(&worktrees, &live_fleet_agents()))
}

/// A non-Git project has no worktree registry. Its root is still the project's only legitimate
/// agent scope, so use it as the singleton membership set rather than aborting room provisioning.
/// Falling back also lets a project receive its closed default room when Git is temporarily
/// unavailable; the roster is simply empty unless a live agent is rooted below that directory.
fn project_worktrees_or_root(project_root: &str, worktrees: Result<Vec<String>, String>) -> Vec<String> {
    worktrees.unwrap_or_else(|_| vec![project_root.to_string()])
}

fn project_agent_addresses_in_worktrees(
    worktrees: &[String],
    agents: &[FleetAgent],
) -> BTreeSet<String> {
    agents
        .iter()
        // `live_fleet_agents` retains recently-exited sessions (alive = false) for the roster's
        // display; room membership must converge to the LIVE project agents, so exclude the dead.
        .filter(|agent| agent.alive && agent_in_project_worktrees(&agent.cwd, worktrees))
        .map(|agent| agent.name.clone())
        .collect()
}

/// Rust counterpart to HED-167's `agentInProjectWorktrees`: compare the agent cwd against the
/// exact registered worktree set, allowing descendants but never a loose shared-prefix match.
fn agent_in_project_worktrees(agent_cwd: &str, worktrees: &[String]) -> bool {
    let cwd = normalize_worktree_path(agent_cwd);
    worktrees.iter().any(|worktree| {
        let root = normalize_worktree_path(worktree);
        !root.is_empty() && (cwd == root || cwd.starts_with(&(root + "/")))
    })
}

fn normalize_worktree_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn verify_and_retain(agents: Vec<FleetAgent>) -> Vec<FleetAgent> {
    let pids = agents
        .iter()
        .map(|agent| agent.pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let ps_liveness = std::process::Command::new("ps")
        .args(["-p", &pids, "-o", "pid=,comm="])
        .output()
        .ok()
        .and_then(|output| {
            // ps -p exit status is USELESS here: it is non-zero whenever ANY listed pid is missing,
            // including the legitimate all-dead case (empty stdout, empty stderr). Trust the parsed
            // output whenever ps ran without complaining; fall back to kill(2) only on a spawn
            // error or a diagnostic — non-empty stderr with nothing parsed (gitar, #23 round 3).
            (!output.stdout.is_empty() || output.stderr.is_empty())
                .then(|| parse_ps_liveness(&String::from_utf8_lossy(&output.stdout), "claude"))
        });

    // Model capture: a SEPARATE, second batched ps call keyed only by pids the first call already
    // proved are a live `claude` executable — never the kill(2) fallback below, which verifies
    // nothing about the executable and could hand back an unrelated (reused) pid's argv as this
    // agent's "model". Keeping this off the liveness ps call also leaves `parse_ps_liveness`
    // (and its exact-basename semantics, HED-77) completely untouched.
    let verified_pids = ps_liveness
        .as_ref()
        .map(|liveness| {
            liveness
                .iter()
                .filter(|(_, &live)| live)
                .map(|(pid, _)| pid.to_string())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let ps_args = if verified_pids.is_empty() {
        HashMap::new()
    } else {
        std::process::Command::new("ps")
            // -ww: unlimited output width. Without it, ps truncates each line to the terminal
            // width (80 cols when there is none, as here); a real launch argv — resume id, model
            // flag, cwd-derived flags — regularly exceeds that, and a truncated line would
            // silently drop `--model` off the end.
            .args(["-ww", "-p", &verified_pids, "-o", "pid=,args="])
            .output()
            .ok()
            .map(|output| parse_ps_args(&String::from_utf8_lossy(&output.stdout)))
            .unwrap_or_default()
    };

    const SESSION_STALE_AFTER_MS: i64 = 48 * 60 * 60 * 1000;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    let mut kept = Vec::with_capacity(agents.len());
    for mut agent in agents {
        let stale = now_ms.saturating_sub(agent.updated_at_ms) > SESSION_STALE_AFTER_MS;
        let process_live = match &ps_liveness {
            Some(liveness) => liveness.get(&(agent.pid as i32)).copied().unwrap_or(false),
            None => process_alive(agent.pid as i32),
        };
        // Dead process + stale session file = a session that ended long ago — drop the row.
        // Recently died (fresh file) or alive-but-parked (live process, silent 48h) stays, struck.
        if !process_live && stale {
            continue;
        }
        agent.alive = process_live && !stale;
        if process_live {
            agent.model = ps_args
                .get(&(agent.pid as i32))
                .and_then(|args| parse_model_flag(args));
        }
        kept.push(agent);
    }
    kept
}

fn matching_agent_index(agents: &[FleetAgent], orchestrator: Option<&str>) -> Option<usize> {
    agents
        .iter()
        .position(|agent| agent.alive && Some(agent.name.as_str()) == orchestrator)
        .or_else(|| {
            agents
                .iter()
                .position(|agent| Some(agent.name.as_str()) == orchestrator)
        })
}

fn attach_in_flight_workers(agents: &mut [FleetAgent]) -> Vec<Worker> {
    let Ok(Some(conn)) = ledger() else {
        return vec![];
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, orchestrator, task_class, provider, model, started_at, cwd, \
         (julianday('now') - julianday(started_at)) * 86400000.0 AS elapsed_ms \
         FROM dispatches WHERE finished_at IS NULL ORDER BY id DESC",
    ) else {
        return vec![];
    };
    let Ok(rows) = stmt.query_map([], |row| {
        let elapsed_ms = row
            .get::<_, Option<f64>>("elapsed_ms")?
            .unwrap_or_default()
            .max(0.0) as i64;
        Ok((
            row.get::<_, Option<String>>("orchestrator")?,
            Worker {
                id: row.get("id")?,
                task_class: row.get("task_class")?,
                provider: row.get("provider")?,
                model: row.get("model")?,
                started_at: row.get("started_at")?,
                cwd: row.get("cwd")?,
                elapsed_ms,
                stale: elapsed_ms > 12 * 60 * 60 * 1000,
            },
        ))
    }) else {
        return vec![];
    };

    let mut orphaned = Vec::new();
    for (orchestrator, worker) in rows.flatten() {
        if let Some(index) = matching_agent_index(agents, orchestrator.as_deref()) {
            let agent = &mut agents[index];
            agent.workers.push(worker);
        } else {
            orphaned.push(worker);
        }
    }
    orphaned
}

/// Live Claude Code fleet agents plus their in-flight heddle workers. Both sources are optional:
/// inaccessible sessions or ledger data simply produce a partial roster rather than failing callers.
pub(crate) fn fleet_roster() -> Vec<FleetAgent> {
    let mut agents = live_fleet_agents();
    let home = home();
    for agent in &mut agents {
        if agent.alive {
            agent.hud = hud_for(&home, &agent.session_id, &agent.cwd);
        }
    }
    let orphaned = attach_in_flight_workers(&mut agents);
    agents.sort_by(|a, b| {
        b.alive
            .cmp(&a.alive)
            .then((!a.cwd.contains("heddle")).cmp(&(!b.cwd.contains("heddle"))))
            .then(a.name.cmp(&b.name))
    });
    if !orphaned.is_empty() {
        agents.push(FleetAgent {
            name: "(orphaned)".to_string(),
            model: None,
            pid: 0,
            session_id: String::new(),
            cwd: String::new(),
            status: String::new(),
            kind: String::new(),
            updated_at_ms: 0,
            alive: false,
            workers: orphaned,
            hud: None,
        });
    }
    agents
}

#[tauri::command]
pub async fn heddle_fleet_roster() -> Result<Vec<FleetAgent>, String> {
    Ok(tauri::async_runtime::spawn_blocking(fleet_roster)
    .await
    .map_err(|e| format!("failed to compute fleet roster: {e}"))?)
}
