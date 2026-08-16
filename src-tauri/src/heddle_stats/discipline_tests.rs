//! Behavioral tests for the discipline reader (HED-85). Fixtures include Agent S's three REAL
//! sample lines from the shipped emitter (workspace commit 40531d0) verbatim — the contract test:
//! if the emitter's format drifts, these fail before the panel lies to Maya.

use super::*;

fn write(path: &std::path::PathBuf, lines: &[&str]) {
    std::fs::write(path, lines.join("\n")).unwrap();
}

const S_SAMPLE_1: &str = r#"{"ts": "2026-08-16T00:54:30Z", "session_id": "emit-a1", "agent": "S", "cwd": "/Users/mayatobi/Developer/heddle", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": true}"#;
const S_SAMPLE_2: &str = r#"{"ts": "2026-08-16T00:54:30Z", "session_id": "emit-a2", "agent": "S", "cwd": "/Users/mayatobi/Developer/heddle-dashboard/.worktrees/S-ci", "repo_id": "heddle-dashboard", "tool_name": "mcp__serena__find_symbol", "hook_event_name": "PostToolUse", "gate": true}"#;
const S_SAMPLE_3: &str = r#"{"ts": "2026-08-16T00:54:31Z", "session_id": "emit-a3", "agent": "S", "cwd": "/Users/mayatobi/Developer/Spinventory-Rebuild-App", "repo_id": null, "tool_name": "mcp__memtrace__find_symbol", "hook_event_name": "PostToolUse", "gate": false}"#;

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// The emitter's real sample lines produce the rows a user reads: per (agent, repo) counts split
/// memtrace vs serena, null repo bucketed "?", per-group gate from its rows.
#[test]
fn s_sample_lines_group_and_count_correctly() {
    let d = tmp();
    let fleet = d.path().join("discipline.jsonl");
    let vendor = d.path().join("adoption.jsonl");
    write(&fleet, &[S_SAMPLE_1, S_SAMPLE_2, S_SAMPLE_3]);
    write(&vendor, &[]);
    let out = discipline_from_paths_for_test(&fleet, &vendor, 24, "2026-08-16T00:00:00.000Z");
    assert_eq!(out.rows.len(), 3);
    let by = |a: &str, r: &str| out.rows.iter().find(|x| x.agent == a && x.repo_id == r).unwrap();
    let h = by("S", "heddle");
    assert_eq!((h.memtrace_calls, h.serena_calls, h.gate), (1, 0, true));
    let dash = by("S", "heddle-dashboard");
    assert_eq!((dash.memtrace_calls, dash.serena_calls, dash.gate), (0, 1, true));
    let unindexed = by("S", "?");
    assert_eq!((unindexed.memtrace_calls, unindexed.gate), (1, false));
}

/// Null agent buckets as "unattributed" — old or unlabeled sessions stay visible, never silently
/// attributed to nobody.
#[test]
fn null_agent_buckets_as_unattributed() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &[r#"{"ts": "2026-08-16T01:00:00Z", "session_id": "x", "agent": null, "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": true}"#]);
    write(&vendor, &[]);
    let out = discipline_from_paths_for_test(&fleet, &vendor, 24, "2026-08-16T00:00:00.000Z");
    assert_eq!(out.rows[0].agent, "unattributed");
    assert_eq!(out.rows[0].memtrace_calls, 1);
}

/// Denied-gate rows (the emitter's planned PreToolUse-denied) count as denials, not as usage —
/// and an unknown future hook event must not inflate any usage counter.
#[test]
fn denied_rows_count_as_denials_never_usage() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    // First line is the emitter's REAL denied sample (workspace 9a720c2): tool_name is the DENIED
    // tool (Bash), so the denied counter must key on hook_event_name, never tool_name.
    write(&fleet, &[
        r#"{"ts": "2026-08-16T00:57:56Z", "session_id": "deny-t1", "agent": "T", "cwd": "/Users/mayatobi/Developer/heddle", "repo_id": "heddle", "tool_name": "Bash", "hook_event_name": "PreToolUse-denied", "gate": true}"#,
        r#"{"ts": "2026-08-16T01:00:01Z", "session_id": "x", "agent": "T", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "SomeFutureEvent", "gate": true}"#,
    ]);
    write(&vendor, &[]);
    let out = discipline_from_paths_for_test(&fleet, &vendor, 24, "2026-08-16T00:00:00.000Z");
    let r = &out.rows[0];
    assert_eq!(r.denied_calls, 1);
    // The unknown event still carries a memtrace tool name: counted as usage by prefix, which is
    // the conservative reading (usage happened) — but the denial itself never is.
    assert_eq!(r.memtrace_calls, 1);
    assert_eq!(r.serena_calls, 0);
}

/// Gate is the LATEST row's value even when lines arrive out of order — a stale gate:true must not
/// mask a discipline regression that already turned enforcement off.
#[test]
fn gate_is_latest_by_timestamp_not_file_order() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &[
        r#"{"ts": "2026-08-16T02:00:00Z", "session_id": "x", "agent": "T", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": false}"#,
        r#"{"ts": "2026-08-16T01:00:00Z", "session_id": "x", "agent": "T", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": true}"#,
    ]);
    write(&vendor, &[]);
    let out = discipline_from_paths_for_test(&fleet, &vendor, 24, "2026-08-16T00:00:00.000Z");
    assert_eq!(out.rows[0].gate, false);
    assert_eq!(out.rows[0].last_ts, "2026-08-16T02:00:00Z");
}

/// The window cutoff drops old rows; vendor telemetry counts into the legacy total only (never
/// attributed); missing files are empty results, not errors.
#[test]
fn window_legacy_and_missing_files() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &[r#"{"ts": "2026-08-14T00:00:00Z", "session_id": "old", "agent": "T", "cwd": "/x", "repo_id": "heddle", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse", "gate": true}"#]);
    write(&vendor, &[
        r#"{"ts": "2026-08-16T00:45:22Z", "session_id": "ac6e", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse"}"#,
        r#"{"ts": "2026-08-13T00:00:00Z", "session_id": "old", "tool_name": "mcp__memtrace__find_code", "hook_event_name": "PostToolUse"}"#,
    ]);
    let out = discipline_from_paths_for_test(&fleet, &vendor, 24, "2026-08-16T00:00:00.000Z");
    assert!(out.rows.is_empty(), "old fleet rows must fall outside the window");
    assert_eq!(out.legacy_unattributed_memtrace, 1);

    let missing = d.path().join("nope.jsonl");
    let out = discipline_from_paths_for_test(&missing, &missing, 24, "2026-08-16T00:00:00.000Z");
    assert!(out.rows.is_empty() && out.legacy_unattributed_memtrace == 0);
}

/// Malformed lines (torn writes, partial appends) are skipped without failing the whole read.
#[test]
fn malformed_lines_are_skipped() {
    let d = tmp();
    let fleet = d.path().join("f.jsonl");
    let vendor = d.path().join("v.jsonl");
    write(&fleet, &["{not json", S_SAMPLE_1, r#"{"ts": 42}"#]);
    write(&vendor, &[]);
    let out = discipline_from_paths_for_test(&fleet, &vendor, 24, "2026-08-16T00:00:00.000Z");
    assert_eq!(out.rows.len(), 1);
    assert_eq!(out.rows[0].memtrace_calls, 1);
}
