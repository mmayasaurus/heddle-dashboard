//! Fleet roster for the Fleet drawer (Agent R's feature, moved here verbatim from the pre-split
//! `heddle_stats.rs`): live Claude Code fleet orchestrators (`~/.claude/sessions/*.json`, alive by
//! `kill(pid, 0)`) with the in-flight heddle workers each one owns, plus an "(orphaned)" bucket
//! for workers whose orchestrator is gone.

use std::collections::HashMap;

use serde::Serialize;

use super::{home, ledger};

/// One in-flight heddle worker, grouped under its live fleet orchestrator for the Fleet drawer.
#[derive(Serialize)]
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetAgent {
    name: String,
    /// The agent's own `claude --model <id>` argv, when its process is live and the flag is
    /// present. Never guessed: absent flag, dead process, or an unreadable ps call all yield `None`.
    model: Option<String>,
    pid: i64,
    session_id: String,
    cwd: String,
    status: String,
    kind: String,
    updated_at_ms: i64,
    alive: bool,
    workers: Vec<Worker>,
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

/// Parse `ps -o pid=,comm=` output into a liveness verdict per listed PID. A session PID may be
/// reused after Claude exits, so existence alone is not enough: its executable must still be Claude.
fn parse_ps_liveness(output: &str, expect: &str) -> HashMap<i32, bool> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim_start().splitn(2, char::is_whitespace);
            let pid = fields.next()?.trim().parse().ok()?;
            let comm = fields.next()?.trim();
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
/// would be ambiguous to split. Two columns keeps the same "first token is pid, rest of the line
/// is the field" split the liveness parser already uses.
fn parse_ps_args(output: &str) -> HashMap<i32, String> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim_start().splitn(2, char::is_whitespace);
            let pid = fields.next()?.trim().parse().ok()?;
            let args = fields.next()?.trim().to_string();
            Some((pid, args))
        })
        .collect()
}

/// Parse a `--model <id>` / `--model=<id>` flag out of a process's argv string. The heddle
/// launcher always passes `--model` on resumes; a process with no flag, or a trailing `--model`
/// with nothing after it, yields `None` rather than a guess.
fn parse_model_flag(args: &str) -> Option<String> {
    let tokens: Vec<&str> = args.split_whitespace().collect();
    for (index, token) in tokens.iter().enumerate() {
        if let Some(value) = token.strip_prefix("--model=") {
            return (!value.is_empty()).then(|| value.to_string());
        }
        if *token == "--model" {
            return tokens.get(index + 1).map(|value| value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
            },
        ];

        assert_eq!(matching_agent_index(&agents, Some("r")), Some(1));
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
        agents.push(FleetAgent {
            name: name.to_string(),
            model: None,
            pid,
            session_id: session["sessionId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            cwd: session["cwd"].as_str().unwrap_or_default().to_string(),
            status: session["status"].as_str().unwrap_or_default().to_string(),
            kind: session["kind"].as_str().unwrap_or_default().to_string(),
            updated_at_ms: session["updatedAt"].as_i64().unwrap_or_default(),
            alive: false,
            workers: vec![],
        });
    }
    if agents.is_empty() {
        return agents;
    }

    verify_and_retain(agents)
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
            .args(["-p", &verified_pids, "-o", "pid=,args="])
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
/// inaccessible sessions or ledger data simply produce a partial roster rather than failing the drawer.
#[tauri::command]
pub async fn heddle_fleet_roster() -> Result<Vec<FleetAgent>, String> {
    Ok(tauri::async_runtime::spawn_blocking(|| {
        let mut agents = live_fleet_agents();
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
            });
        }
        agents
    })
    .await
    .unwrap_or_default())
}
