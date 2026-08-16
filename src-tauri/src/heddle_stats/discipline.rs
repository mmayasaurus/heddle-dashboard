//! Fleet discipline telemetry (HED-85) — per-agent/per-repo memory-layer tool usage for the
//! Fleet drawer's scoreboard: "are agents actually using memtrace?" as a glance, not log spelunking.
//!
//! Sources (both best-effort; a missing file is an empty result, never an error):
//!  - `~/.heddle/discipline.jsonl` — the fleet sink emitted by the workspace `require-memtrace-first`
//!    record hook (S's HED-82 contract, workspace commit 40531d0). Append-only JSONL, one object per
//!    line with exactly: ts (ISO8601Z), session_id, agent (str|null), cwd, repo_id (str|null),
//!    tool_name, hook_event_name, gate (bool). Rows exist only for MEMORY-LAYER calls (memtrace
//!    valid-query tools + the eight serena symbol tools) plus, when the emitter adds them,
//!    `hook_event_name: "PreToolUse-denied"` rows for gate denials.
//!  - `~/.memtrace/adoption.jsonl` — the memtrace PACKAGE's own vendor telemetry (4 keys, no
//!    agent/cwd, memtrace tools only). Counted as one unattributed total so pre-contract history
//!    isn't invisible; never parsed for attribution.
//!
//! Grouping key is (agent ?? "unattributed", repo_id ?? "?"); `gate` reported per group is the
//! LATEST row's value (the current enforcement state for that agent/repo, per-row by contract).
//! The red-flag decision ("live agent, zero calls, gate off") is made in the frontend, which also
//! holds the live roster — this module only reports what the sinks contain.

use serde::Serialize;
use std::io::BufRead;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DisciplineRow {
    pub agent: String,
    pub repo_id: String,
    pub memtrace_calls: i64,
    pub serena_calls: i64,
    pub denied_calls: i64,
    /// Latest row's gate for this (agent, repo) — the current enforcement state.
    pub gate: bool,
    /// ISO timestamp of the newest row in the window.
    pub last_ts: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discipline {
    pub window_hours: i64,
    pub rows: Vec<DisciplineRow>,
    /// Memtrace calls from the vendor telemetry file (no attribution possible) in the window.
    pub legacy_unattributed_memtrace: i64,
}

/// Discipline usage over the last `hours` (default 24, clamped 1..=168).
#[tauri::command]
pub async fn heddle_discipline(hours: Option<i64>) -> Result<Discipline, String> {
    super::blocking(move || {
        let hours = hours.unwrap_or(24).clamp(1, 168);
        let cutoff = super::route_mix::cutoff_iso_pub(hours);
        let home = dirs::home_dir().unwrap_or_default();
        Ok(discipline_from(
            &home.join(".heddle").join("discipline.jsonl"),
            &home.join(".memtrace").join("adoption.jsonl"),
            hours,
            &cutoff,
        ))
    })
    .await
}

/// Pure core over explicit paths so tests drive it with fixture files.
fn discipline_from(fleet_sink: &Path, vendor_sink: &Path, window_hours: i64, cutoff: &str) -> Discipline {
    let mut groups: std::collections::BTreeMap<(String, String), DisciplineRow> = Default::default();

    for line in read_lines(fleet_sink) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let Some(ts) = v["ts"].as_str() else { continue };
        // ISO8601Z strings compare chronologically as strings; the emitter writes second precision.
        if ts < cutoff {
            continue;
        }
        let agent = v["agent"].as_str().unwrap_or("unattributed").to_string();
        let repo = v["repo_id"].as_str().unwrap_or("?").to_string();
        let tool = v["tool_name"].as_str().unwrap_or("");
        let event = v["hook_event_name"].as_str().unwrap_or("");
        let gate = v["gate"].as_bool().unwrap_or(false);
        let e = groups.entry((agent.clone(), repo.clone())).or_insert(DisciplineRow {
            agent,
            repo_id: repo,
            memtrace_calls: 0,
            serena_calls: 0,
            denied_calls: 0,
            gate,
            last_ts: ts.to_string(),
        });
        if event == "PreToolUse-denied" {
            e.denied_calls += 1;
        } else if tool.starts_with("mcp__memtrace__") {
            e.memtrace_calls += 1;
        } else if tool.starts_with("mcp__serena__") {
            e.serena_calls += 1;
        }
        // Latest row wins for gate/last_ts (file is append-only, but don't rely on ordering).
        if ts >= e.last_ts.as_str() {
            e.last_ts = ts.to_string();
            e.gate = gate;
        }
    }

    let mut legacy = 0i64;
    for line in read_lines(vendor_sink) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let Some(ts) = v["ts"].as_str() else { continue };
        if ts >= cutoff && v["tool_name"].as_str().unwrap_or("").starts_with("mcp__memtrace__") {
            legacy += 1;
        }
    }

    // Most active first — the glance should lead with who IS using the tools.
    let mut rows: Vec<DisciplineRow> = groups.into_values().collect();
    rows.sort_by(|a, b| {
        (b.memtrace_calls + b.serena_calls)
            .cmp(&(a.memtrace_calls + a.serena_calls))
            .then(a.agent.cmp(&b.agent))
            .then(a.repo_id.cmp(&b.repo_id))
    });
    Discipline { window_hours, rows, legacy_unattributed_memtrace: legacy }
}

fn read_lines(path: &Path) -> Box<dyn Iterator<Item = String>> {
    let Ok(f) = std::fs::File::open(path) else { return Box::new(std::iter::empty()) };
    Box::new(std::io::BufReader::new(f).lines().map_while(Result::ok))
}

/// Test-only helper so fixtures can live in a temp dir.
#[cfg(test)]
pub(crate) fn discipline_from_paths_for_test(
    fleet: &PathBuf, vendor: &PathBuf, hours: i64, cutoff: &str,
) -> Discipline {
    discipline_from(fleet, vendor, hours, cutoff)
}

#[cfg(test)]
#[path = "discipline_tests.rs"]
mod tests;
