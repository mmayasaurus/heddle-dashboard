//! Behavioral tests for the discipline reader (HED-85). Fixtures mirror Agent S's real emitter
//! sample lines (workspace 40531d0/9a720c2) with the developer home path anonymized — `cwd` is
//! never read by this module, so the JSON shape and keys stay pinned exactly. If the emitter's
//! format drifts, these fail before the panel lies to Maya.

use super::*;

fn write(path: &std::path::PathBuf, lines: &[&str]) {
    std::fs::write(path, lines.join("\n")).unwrap();
}

const S_SAMPLE_1: &str = r#"{"ts": "2026-08-16T00:54:30Z", "session_id": "emit-a1", "agent": "S", "cwd": "/Users/dev/Developer/heddle", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": true}"#;
const S_SAMPLE_2: &str = r#"{"ts": "2026-08-16T00:54:30Z", "session_id": "emit-a2", "agent": "S", "cwd": "/Users/dev/Developer/heddle-dashboard/.worktrees/S-ci", "repo_id": "heddle-dashboard", "tool_name": "mcp__serena__find_symbol", "hook_event_name": "PostToolUse", "gate": true}"#;
const S_SAMPLE_3: &str = r#"{"ts": "2026-08-16T00:54:31Z", "session_id": "emit-a3", "agent": "S", "cwd": "/Users/dev/Developer/Spinventory-Rebuild-App", "repo_id": null, "tool_name": "mcp__memtrace__find_symbol", "hook_event_name": "PostToolUse", "gate": false}"#;
const S_DENIED: &str = r#"{"ts": "2026-08-16T00:57:56Z", "session_id": "deny-t1", "agent": "S", "cwd": "/Users/dev/Developer/heddle", "repo_id": "heddle", "tool_name": "Bash", "hook_event_name": "PreToolUse-denied", "gate": true}"#;

const CUTOFF: &str = "2026-08-16T00:00:00.000Z";
const NOW: &str = "2026-08-16T12:00:00.000Z";
const TAIL: u64 = 4 * 1024 * 1024;

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn run(fleet: &std::path::PathBuf, vendor: &std::path::PathBuf) -> Discipline {
    discipline_from_paths_for_test(fleet, vendor, 24, CUTOFF, NOW, TAIL)
}

/// The emitter's sample lines produce the rows a user reads: per (agent, repo) counts split
/// memtrace vs serena, null repo bucketed "?", per-group gate from its rows, denials counted by
/// hook_event_name (the denied row's tool_name is Bash — usage counters must not move).
#[test]
fn s_sample_lines_group_count_and_denials() {
    let d = tmp();
    let fleet = d.path().join("discipline.jsonl");
    let vendor = d.path().join("adoption.jsonl");
    write(&fleet, &[S_SAMPLE_1, S_SAMPLE_2, S_SAMPLE_3, S_DENIED]);
    write(&vendor, &[]);
    let out = run(&fleet, &vendor);
    assert_eq!(out.rows.len(), 3);
    let by = |a: &str, r: &str| out.rows.iter().find(|x| x.agent == a && x.repo_id == r).unwrap();
    let h = by("S", "heddle");
    assert_eq!(
        (h.memtrace_calls, h.serena_calls, h.denied_calls, h.gate),
        (1, 0, 1, true),
        "denied Bash row counts as a denial only; gate follows the latest row"
    );
    let dash = by("S", "heddle-dashboard");
    assert_eq!((dash.memtrace_calls, dash.serena_calls), (0, 1));
    let unindexed = by("S", "?");
    assert_eq!((unindexed.memtrace_calls, unindexed.gate), (1, false));
}

/// Null agent buckets as "unattributed" — unlabeled sessions stay visible.
#[test]
fn null_agent_buckets_as_unattributed() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &[r#"{"ts": "2026-08-16T01:00:00Z", "session_id": "x", "agent": null, "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": true}"#]);
    write(&vendor, &[]);
    let out = run(&fleet, &vendor);
    assert_eq!(out.rows[0].agent, "unattributed");
    assert_eq!(out.rows[0].memtrace_calls, 1);
}

/// Rows missing a REQUIRED field (here: gate) are schema drift and are skipped — a defaulted
/// gate:false would fabricate a red "gate OFF" state out of nothing.
#[test]
fn missing_gate_row_is_skipped_not_defaulted_red() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &[
        r#"{"ts": "2026-08-16T01:00:00Z", "session_id": "x", "agent": "T", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse"}"#,
        S_SAMPLE_1,
    ]);
    write(&vendor, &[]);
    let out = run(&fleet, &vendor);
    assert_eq!(out.rows.len(), 1, "only the contract-complete row survives");
    assert_eq!(out.rows[0].agent, "S");
}

/// Future-dated rows (clock skew) are excluded — they must not control the displayed gate state
/// before they "happen".
#[test]
fn future_dated_rows_are_excluded() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &[
        S_SAMPLE_1,
        r#"{"ts": "2026-08-17T09:00:00Z", "session_id": "skew", "agent": "S", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": false}"#,
    ]);
    write(&vendor, &[]);
    let out = run(&fleet, &vendor);
    let h = out.rows.iter().find(|x| x.repo_id == "heddle").unwrap();
    assert_eq!((h.memtrace_calls, h.gate), (1, true), "the skewed row neither counts nor flips the gate");
}

/// Gate is the LATEST row's value; at equal timestamps the later append wins (file order IS event
/// order in an append-only file at second precision).
#[test]
fn gate_latest_by_timestamp_equal_ts_later_append_wins() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &[
        r#"{"ts": "2026-08-16T02:00:00Z", "session_id": "x", "agent": "T", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": false}"#,
        r#"{"ts": "2026-08-16T01:00:00Z", "session_id": "x", "agent": "T", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": true}"#,
        r#"{"ts": "2026-08-16T02:00:00Z", "session_id": "x", "agent": "T", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": true}"#,
    ]);
    write(&vendor, &[]);
    let out = run(&fleet, &vendor);
    assert_eq!(out.rows[0].gate, true, "equal-ts tie resolves to the later append");
    assert_eq!(out.rows[0].last_ts, "2026-08-16T02:00:00Z");
}

/// Vendor telemetry is a fallback total for pre-contract machines ONLY: when the fleet sink has
/// window rows, the vendor count is suppressed (both sinks record the same successful calls —
/// showing both would double-count attributed work).
#[test]
fn vendor_total_only_when_fleet_sink_is_empty() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&vendor, &[
        r#"{"ts": "2026-08-16T00:45:22Z", "session_id": "ac6e", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse"}"#,
        r#"{"ts": "2026-08-13T00:00:00Z", "session_id": "old", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse"}"#,
    ]);
    write(&fleet, &[]);
    let out = run(&fleet, &vendor);
    assert_eq!(out.legacy_unattributed_memtrace, 1, "in-window vendor rows count when fleet is silent");
    write(&fleet, &[S_SAMPLE_1]);
    let out = run(&fleet, &vendor);
    assert_eq!(out.legacy_unattributed_memtrace, 0, "fleet rows suppress the overlapping vendor total");
}

/// A torn append with invalid UTF-8 corrupts ONE line and never truncates the rest of the file —
/// under-counting after a torn write is exactly the "panel lies" failure this reader must not have.
#[test]
fn invalid_utf8_line_does_not_truncate_the_read() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"{\"torn\": \"\xff\xfe");
    bytes.push(b'\n');
    bytes.extend_from_slice(S_SAMPLE_1.as_bytes());
    std::fs::write(&fleet, bytes).unwrap();
    write(&vendor, &[]);
    let out = run(&fleet, &vendor);
    assert_eq!(out.rows.len(), 1, "the valid line AFTER the torn one is still read");
    assert_eq!(out.rows[0].memtrace_calls, 1);
}

/// The tail bound drops the oldest content (and the partial first line), never the newest — with a
/// tiny bound only the final complete lines survive.
#[test]
fn tail_bound_keeps_newest_lines_and_drops_partial_first() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &[S_SAMPLE_2, S_SAMPLE_1]); // S_SAMPLE_1 (heddle) is the last line
    write(&vendor, &[]);
    let tail = (S_SAMPLE_1.len() as u64) + 10; // covers the last line + a fragment of the previous
    let out = discipline_from_paths_for_test(&fleet, &vendor, 24, CUTOFF, NOW, tail);
    assert_eq!(out.rows.len(), 1, "only the newest complete line is inside the bound");
    assert_eq!(out.rows[0].repo_id, "heddle");
}

/// Missing files and malformed-JSON lines are skipped without failing the read.
#[test]
fn missing_files_and_malformed_lines() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &["{not json", S_SAMPLE_1, r#"{"ts": 42}"#]);
    write(&vendor, &[]);
    let out = run(&fleet, &vendor);
    assert_eq!(out.rows.len(), 1);
    let missing = d.path().join("nope.jsonl");
    let out = discipline_from_paths_for_test(&missing, &missing, 24, CUTOFF, NOW, TAIL);
    assert!(out.rows.is_empty() && out.legacy_unattributed_memtrace == 0);
}
