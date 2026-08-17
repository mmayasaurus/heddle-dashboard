//! Fleet discipline telemetry (HED-85) — per-agent/per-repo memory-layer tool usage for the
//! Fleet drawer's scoreboard: "are agents actually using memtrace?" as a glance, not log spelunking.
//!
//! Sources (both best-effort; a missing home dir or file is an empty result, never an error):
//!  - `~/.heddle/discipline.jsonl` — the fleet sink emitted by the workspace `require-memtrace-first`
//!    record hook (S's HED-82 contract, workspace commits 40531d0/9a720c2). Append-only JSONL with
//!    exactly: ts (ISO8601Z), session_id, agent (str|null), cwd, repo_id (str|null), tool_name,
//!    hook_event_name, gate (bool). Rows exist only for MEMORY-LAYER calls (memtrace valid-query
//!    tools + the eight serena symbol tools) plus `hook_event_name: "PreToolUse-denied"` rows for
//!    gate denials (whose tool_name is the DENIED tool — Bash/Grep — never a memory-layer tool).
//!  - `~/.memtrace/adoption.jsonl` — the memtrace PACKAGE's own vendor telemetry (4 keys, no
//!    agent/cwd). Both sinks record the SAME successful memtrace calls when both hooks are active,
//!    so the vendor total is reported ONLY when the fleet sink has no rows in the window (a
//!    pre-contract machine) — otherwise it would double-count attributed work.
//!
//! Row validation is strict per contract: ts/tool_name/hook_event_name strings and a boolean
//! `gate` must be present, or the row is skipped — a schema-drifted producer must not fabricate a
//! red "gate OFF" state from a missing field. `agent`/`repo_id` may be null by contract (bucketed
//! "unattributed"/"?"). Future-dated rows (clock skew) are excluded by an upper bound at "now".
//! Ties on the per-group `gate`/`last_ts` at EQUAL timestamps resolve to the later row in file
//! order — the file is append-only, so later-in-file IS the later event at second precision.
//!
//! Reads are TAIL-BOUNDED (default 4 MiB per file, first partial line dropped): the sinks are
//! append-only and unrotated, so a full scan per poll would grow without bound; a 24h window fits
//! comfortably in the tail at current emit rates, and the bound is stated here rather than hidden.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

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
    /// Vendor-telemetry memtrace calls in the window, reported only when `rows` is empty (both
    /// sinks record the same successful calls; see module doc).
    pub legacy_unattributed_memtrace: i64,
}

/// Read cap per sink file — see module doc.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// Discipline usage over the last `hours` (default 24, clamped 1..=168).
#[tauri::command]
pub async fn heddle_discipline(hours: Option<i64>) -> Result<Discipline, String> {
    super::blocking(move || {
        let hours = hours.unwrap_or(24).clamp(1, 168);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let cutoff = super::route_mix::epoch_to_iso(now - hours * 3600);
        let now_iso = super::route_mix::epoch_to_iso(now);
        // No resolvable home ⇒ no telemetry, honestly empty — never read paths relative to the
        // process cwd, which could pick up unrelated files.
        let Some(home) = dirs::home_dir() else {
            return Ok(Discipline { window_hours: hours, rows: vec![], legacy_unattributed_memtrace: 0 });
        };
        Ok(discipline_from(
            &home.join(".heddle").join("discipline.jsonl"),
            &home.join(".memtrace").join("adoption.jsonl"),
            hours,
            &cutoff,
            &now_iso,
            TAIL_BYTES,
        ))
    })
    .await
}

/// Pure core over explicit paths/bounds so tests drive it with fixture files.
fn discipline_from(
    fleet_sink: &Path,
    vendor_sink: &Path,
    window_hours: i64,
    cutoff: &str,
    now_iso: &str,
    tail_bytes: u64,
) -> Discipline {
    let mut rows = parse_fleet_sink(fleet_sink, cutoff, now_iso, tail_bytes);
    // Most active first — the glance should lead with who IS using the tools.
    rows.sort_by(|a, b| {
        (b.memtrace_calls + b.serena_calls)
            .cmp(&(a.memtrace_calls + a.serena_calls))
            .then(a.agent.cmp(&b.agent))
            .then(a.repo_id.cmp(&b.repo_id))
    });
    let legacy = if rows.is_empty() {
        parse_vendor_sink(vendor_sink, cutoff, now_iso, tail_bytes)
    } else {
        0
    };
    Discipline { window_hours, rows, legacy_unattributed_memtrace: legacy }
}

/// Parse the fleet sink into grouped rows. Strict per-row validation (see module doc).
fn parse_fleet_sink(path: &Path, cutoff: &str, now_iso: &str, tail_bytes: u64) -> Vec<DisciplineRow> {
    let mut groups: std::collections::BTreeMap<(String, String), DisciplineRow> = Default::default();
    for line in tail_lines(path, tail_bytes) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        // Required by contract; a row missing any of these is schema drift and is skipped rather
        // than letting a defaulted gate fabricate a red state.
        let (Some(ts), Some(tool), Some(event), Some(gate)) = (
            v["ts"].as_str(),
            v["tool_name"].as_str(),
            v["hook_event_name"].as_str(),
            v["gate"].as_bool(),
        ) else {
            continue;
        };
        // ISO8601Z compares chronologically as strings; both bounds applied (future rows = skew).
        if ts < cutoff || ts > now_iso {
            continue;
        }
        let agent = v["agent"].as_str().unwrap_or("unattributed").to_string();
        let repo = v["repo_id"].as_str().unwrap_or("?").to_string();
        let e = groups.entry((agent.clone(), repo.clone())).or_insert(DisciplineRow {
            agent,
            repo_id: repo,
            memtrace_calls: 0,
            serena_calls: 0,
            denied_calls: 0,
            gate,
            last_ts: ts.to_string(),
        });
        // Denials first: their tool_name is the DENIED tool, never usage.
        if event == "PreToolUse-denied" {
            e.denied_calls += 1;
        } else if tool.starts_with("mcp__memtrace__") {
            e.memtrace_calls += 1;
        } else if tool.starts_with("mcp__serena__") {
            e.serena_calls += 1;
        }
        // `>=`: at equal (second-precision) timestamps the later row in the append-only file is
        // the later event, so it deliberately wins the gate/last_ts tie.
        if ts >= e.last_ts.as_str() {
            e.last_ts = ts.to_string();
            e.gate = gate;
        }
    }
    groups.into_values().collect()
}

/// Count vendor-telemetry memtrace rows in the window (4-key format; never attributed).
fn parse_vendor_sink(path: &Path, cutoff: &str, now_iso: &str, tail_bytes: u64) -> i64 {
    let mut n = 0i64;
    for line in tail_lines(path, tail_bytes) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let Some(ts) = v["ts"].as_str() else { continue };
        if ts >= cutoff
            && ts <= now_iso
            && v["tool_name"].as_str().unwrap_or("").starts_with("mcp__memtrace__")
        {
            n += 1;
        }
    }
    n
}

/// Last `tail_bytes` of `path` as lines. Lossy UTF-8 (a torn multibyte append corrupts one line,
/// never truncates the rest of the file), and when the read starts mid-file the first partial
/// line is dropped. Missing/unreadable file ⇒ no lines.
fn tail_lines(path: &Path, tail_bytes: u64) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else { return vec![] };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(tail_bytes);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    if f.read_to_end(&mut buf).is_err() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines().map(str::to_string).collect::<Vec<_>>();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // partial first line from seeking mid-file
    }
    lines
}

/// Test-only helper so fixtures can live in a temp dir with a controllable tail bound.
#[cfg(test)]
pub(crate) fn discipline_from_paths_for_test(
    fleet: &Path,
    vendor: &Path,
    hours: i64,
    cutoff: &str,
    now_iso: &str,
    tail_bytes: u64,
) -> Discipline {
    discipline_from(fleet, vendor, hours, cutoff, now_iso, tail_bytes)
}

#[cfg(test)]
#[path = "discipline_tests.rs"]
mod tests;
