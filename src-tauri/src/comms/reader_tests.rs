//! Behavioral tests for the comms.db reader (HED-74a), against fixture databases built from the
//! exact broker schema (`comms-fixtures.output.md`, cross-checked against `src/comms/log.ts`).
//!
//! Wall-clock-sensitive assertions (`recentRefusals`, floor expiry) insert rows with SQLite
//! `strftime('now', modifier)` expressions rather than hardcoded dates, so these tests pass on any
//! day they run rather than only near the fixture doc's authoring date.

use super::*;
use rusqlite::Connection;
use std::path::Path;

/// Verbatim broker schema (pragmas, tables, indexes, append-only/lineage triggers) from
/// `comms-fixtures.output.md` section 1, itself cross-checked against `src/comms/log.ts`.
const SCHEMA_SQL: &str = r#"
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  sender      TEXT    NOT NULL,
  target      TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'chat',
  tier        TEXT    NOT NULL DEFAULT 'agent-message',
  verified    INTEGER NOT NULL DEFAULT 0,
  body        TEXT    NOT NULL,
  reply_to    INTEGER,
  issue       TEXT,
  thread      TEXT,
  dispatch_id INTEGER,
  meta        TEXT,
  CHECK (tier IN ('operator', 'orchestrator-directive', 'agent-message')),
  CHECK (verified IN (0, 1)),
  CHECK ((tier = 'agent-message' AND verified = 0) OR (tier <> 'agent-message' AND verified = 1))
);
CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target, id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender, id);
CREATE INDEX IF NOT EXISTS idx_messages_ts     ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread, id);

CREATE TRIGGER IF NOT EXISTS messages_append_only_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'comms log is append-only: UPDATE refused'); END;
CREATE TRIGGER IF NOT EXISTS messages_append_only_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'comms log is append-only: DELETE refused'); END;
CREATE TRIGGER IF NOT EXISTS messages_sender_registered BEFORE INSERT ON messages
WHEN NOT EXISTS (SELECT 1 FROM participants WHERE address = NEW.sender)
BEGIN SELECT RAISE(ABORT, 'sender is not a registered participant'); END;

CREATE TABLE IF NOT EXISTS deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,
  message_id INTEGER,
  sender     TEXT    NOT NULL,
  target     TEXT    NOT NULL,
  outcome    TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  reason     TEXT,
  transport  TEXT,
  attempt    INTEGER NOT NULL DEFAULT 1,
  CHECK (outcome IN ('sent', 'held', 'released', 'refused', 'failed', 'logged'))
);
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(message_id, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_target  ON deliveries(target, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_sender  ON deliveries(sender, id);

CREATE TRIGGER IF NOT EXISTS deliveries_append_only_update BEFORE UPDATE ON deliveries
BEGIN SELECT RAISE(ABORT, 'delivery log is append-only: UPDATE refused'); END;
CREATE TRIGGER IF NOT EXISTS deliveries_append_only_delete BEFORE DELETE ON deliveries
BEGIN SELECT RAISE(ABORT, 'delivery log is append-only: DELETE refused'); END;

CREATE TABLE IF NOT EXISTS sessions (
  address      TEXT PRIMARY KEY,
  session_id   TEXT,
  session_name TEXT,
  pid          INTEGER,
  socket       TEXT,
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  name       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  topic      TEXT,
  open       INTEGER NOT NULL DEFAULT 0,
  CHECK (open IN (0, 1))
);
CREATE TABLE IF NOT EXISTS room_members (
  room     TEXT NOT NULL REFERENCES rooms(name),
  address  TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (room, address)
);
CREATE TABLE IF NOT EXISTS room_floor (
  room       TEXT PRIMARY KEY REFERENCES rooms(name),
  holder     TEXT NOT NULL,
  since      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  address     TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  parent      TEXT REFERENCES participants(address),
  seq         INTEGER,
  dispatch_id INTEGER,
  label       TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  CHECK (kind IN ('agent', 'child', 'operator')),
  CHECK ((kind = 'child' AND parent IS NOT NULL AND seq IS NOT NULL AND address = parent || '.' || seq)
      OR (kind <> 'child' AND parent IS NULL AND seq IS NULL AND dispatch_id IS NULL)),
  CHECK ((kind = 'child') = (instr(address, '.') > 0)),
  CHECK (kind <> 'operator' OR address = 'operator'),
  UNIQUE (parent, seq)
);
CREATE INDEX IF NOT EXISTS idx_participants_parent ON participants(parent, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_dispatch ON participants(dispatch_id)
  WHERE dispatch_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS participants_lineage_immutable BEFORE UPDATE ON participants
WHEN NEW.address <> OLD.address OR NEW.kind <> OLD.kind OR NEW.parent IS NOT OLD.parent
  OR NEW.seq IS NOT OLD.seq OR NEW.dispatch_id IS NOT OLD.dispatch_id
  OR NEW.first_seen <> OLD.first_seen
BEGIN SELECT RAISE(ABORT, 'participant lineage is immutable: only last_seen/label may change'); END;
"#;

/// Verbatim fixture rows from `comms-fixtures.output.md` section 1 ("INSERT FIXTURES"):
/// participants first (the `messages_sender_registered` trigger requires it), then messages, then
/// deliveries. Msg 4 (needs-human) is unreplied; Msg 5 (permission-request) is replied by Msg 6
/// from `K` — a plain agent, not the operator.
const BASE_FIXTURE_SQL: &str = r#"
INSERT INTO participants (address, kind, first_seen, last_seen)
VALUES ('operator', 'operator', '2026-08-16T12:00:00.000Z', '2026-08-16T12:00:00.000Z');

INSERT INTO participants (address, kind, first_seen, last_seen)
VALUES ('K', 'agent', '2026-08-16T12:00:00.000Z', '2026-08-16T12:00:00.000Z');

INSERT INTO participants (address, kind, parent, seq, dispatch_id, first_seen, last_seen)
VALUES ('K.1', 'child', 'K', 1, 101, '2026-08-16T12:01:00.000Z', '2026-08-16T12:01:00.000Z');

INSERT INTO participants (address, kind, first_seen, last_seen)
VALUES ('peer', 'agent', '2026-08-16T12:00:00.000Z', '2026-08-16T12:00:00.000Z');

INSERT INTO messages (id, ts, sender, target, kind, tier, verified, body)
VALUES (1, '2026-08-16T12:02:00.000Z', 'operator', '@all', 'chat', 'operator', 1, 'Broadcast: system updating');

INSERT INTO messages (id, ts, sender, target, kind, tier, verified, body)
VALUES (2, '2026-08-16T12:03:00.000Z', 'K', 'K.1', 'chat', 'orchestrator-directive', 1, 'Run the tests');

INSERT INTO messages (id, ts, sender, target, kind, tier, verified, body, meta)
VALUES (3, '2026-08-16T12:04:00.000Z', 'peer', 'K', 'chat', 'agent-message', 0, 'Hi from R', '{"fromName":"R"}');

INSERT INTO messages (id, ts, sender, target, kind, tier, verified, body)
VALUES (4, '2026-08-16T12:05:00.000Z', 'K.1', 'operator', 'needs-human', 'agent-message', 0, 'I need help debugging the tests');

INSERT INTO messages (id, ts, sender, target, kind, tier, verified, body)
VALUES (5, '2026-08-16T12:06:00.000Z', 'K.1', 'operator', 'permission-request', 'agent-message', 0, 'Can I run git push --force?');

INSERT INTO messages (id, ts, sender, target, kind, tier, verified, body, reply_to)
VALUES (6, '2026-08-16T12:07:00.000Z', 'K', 'K.1', 'chat', 'agent-message', 0, 'Do NOT force push!', 5);

INSERT INTO deliveries (ts, message_id, sender, target, outcome, code)
VALUES ('2026-08-16T12:02:01.000Z', 1, 'operator', 'K', 'sent', 'broadcast');

INSERT INTO deliveries (ts, message_id, sender, target, outcome, code, reason)
VALUES ('2026-08-16T12:03:01.000Z', 2, 'K', 'K.1', 'held', 'permission-gate', 'Awaiting operator approval');

INSERT INTO deliveries (ts, message_id, sender, target, outcome, code, attempt)
VALUES ('2026-08-16T12:08:00.000Z', 2, 'K', 'K.1', 'released', 'gate-cleared', 2);

INSERT INTO deliveries (ts, message_id, sender, target, outcome, code, reason)
VALUES ('2026-08-16T12:09:00.000Z', NULL, 'K', 'K.1', 'refused', 'rate-limited', '5 per 10s exceeded');
"#;

/// Create `path` with just the broker schema (no data) — used by the version-mismatch and
/// missing-table-touch tests.
fn empty_schema_db(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
}

/// Create `path` with the schema plus the shared base fixture rows.
fn seeded_db(path: &Path) {
    empty_schema_db(path);
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(BASE_FIXTURE_SQL).unwrap();
}

// ─────────────────────────────────────── test 1 ───────────────────────────────────────

#[test]
fn wrong_schema_version_reports_not_ok_with_zero_rows_and_no_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v2.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA user_version = 2;").unwrap();
    drop(conn);

    let snap = rooms_at(&path).expect("version mismatch must not Err");
    assert!(!snap.schema_ok);
    assert_eq!(snap.schema_version, 2);
    assert!(snap.rooms.is_empty() && snap.needs_human.is_empty());
    assert_eq!(snap.recent_refusals, 0);

    let ts = transcript_at(&path, "#fleet", None, None).expect("version mismatch must not Err");
    assert!(!ts.schema_ok);
    assert_eq!(ts.schema_version, 2);
    assert!(ts.messages.is_empty());
    assert!(ts.floor.is_none());
}

// ─────────────────────────────────────── test 2 ───────────────────────────────────────

#[test]
fn missing_db_file_is_a_fresh_install_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("does-not-exist.db");

    let snap = rooms_at(&path).unwrap();
    assert!(snap.schema_ok);
    assert_eq!(snap.schema_version, 0);
    assert!(snap.rooms.is_empty() && snap.needs_human.is_empty());
    assert_eq!(snap.recent_refusals, 0);

    let ts = transcript_at(&path, "#fleet", None, None).unwrap();
    assert!(ts.schema_ok);
    assert_eq!(ts.schema_version, 0);
    assert!(ts.messages.is_empty());
    assert!(ts.floor.is_none());
}

// ─────────────────────────────────────── test 3 ───────────────────────────────────────

#[test]
fn needs_human_anti_join_matches_only_the_truly_unreplied_row() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    seeded_db(&path);

    let snap = rooms_at(&path).unwrap();
    let ids: Vec<i64> = snap.needs_human.iter().map(|r| r.id).collect();
    // BOTH stay open. Msg 4 was never replied to at all. Msg 5 has a reply (Msg 6) — but that
    // reply is tier='agent-message' (K telling K.1 "Do NOT force push!"), and an agent
    // acknowledging a human-decision item must never remove it from Maya's queue. Before the
    // tier guard this returned just [4], i.e. the permission-request silently vanished.
    assert_eq!(ids, vec![5, 4], "newest first; an agent-tier reply closes nothing");
    assert_eq!(snap.needs_human[1].kind, "needs-human");
    assert_eq!(snap.needs_human[0].kind, "permission-request");
}

#[test]
fn only_an_operator_tier_reply_closes_a_needs_human_item() {
    // The tier semantics in one test: 'needs-human' means a HUMAN decides, and only
    // tier='operator' is the human at the keyboard (broker-stamped, origin-verified — a sender
    // cannot request it). An agent acknowledging, or an orchestrator directing, leaves the item
    // OPEN. Reproduced live on 2026-08-16 before this guard existed: one agent reply emptied the
    // queue while the decision was still outstanding.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    seeded_db(&path);
    let conn = Connection::open(&path).unwrap();

    let open_ids = |c: &Connection| -> Vec<i64> {
        drop(c);
        rooms_at(&path)
            .unwrap()
            .needs_human
            .iter()
            .map(|r| r.id)
            .collect()
    };

    // An orchestrator-directive reply to Msg 4 — R acknowledging is not Maya deciding.
    conn.execute_batch(
        "INSERT INTO messages (ts, sender, target, kind, tier, verified, body, reply_to) \
         VALUES ('2026-08-16T12:10:00.000Z', 'K', 'K.1', 'chat', 'orchestrator-directive', 1, \
                 'ack, holding for the operator', 4);",
    )
    .unwrap();
    assert_eq!(
        open_ids(&Connection::open(&path).unwrap()),
        vec![5, 4],
        "an orchestrator-directive reply must not close a human-decision item"
    );

    // The operator answers Msg 4 — now, and only now, it leaves the queue.
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO messages (ts, sender, target, kind, tier, verified, body, reply_to) \
         VALUES ('2026-08-16T12:11:00.000Z', 'operator', 'K.1', 'chat', 'operator', 1, \
                 'go ahead', 4);",
    )
    .unwrap();
    assert_eq!(
        open_ids(&conn),
        vec![5],
        "an operator reply closes it; Msg 5 is untouched and stays open"
    );
}

// ─────────────────────────────────────── test 4 ───────────────────────────────────────

#[test]
fn transcript_paging_respects_since_id_ordering_and_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    seeded_db(&path);

    let all = transcript_at(&path, "K.1", None, None).unwrap();
    let ids: Vec<i64> = all.messages.iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![2, 6], "both K.1-targeted rows, ascending");

    let since = transcript_at(&path, "K.1", Some(2), None).unwrap();
    assert_eq!(
        since.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
        vec![6],
        "sinceId=2 must exclude id 2 itself"
    );

    let limited = transcript_at(&path, "K.1", Some(0), Some(1)).unwrap();
    assert_eq!(limited.messages.len(), 1);
    assert_eq!(limited.messages[0].id, 2, "limit=1 keeps only the lowest remaining id");
}

// ─────────────────────────────────────── test 5 ───────────────────────────────────────

#[test]
fn delivery_counts_are_aggregated_per_message_and_null_when_absent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    seeded_db(&path);

    let k1 = transcript_at(&path, "K.1", None, None).unwrap();
    let msg2 = k1.messages.iter().find(|m| m.id == 2).unwrap();
    assert_eq!(
        msg2.deliveries,
        Some(DeliveryCounts { held: 1, released: 1, ..Default::default() })
    );
    let msg6 = k1.messages.iter().find(|m| m.id == 6).unwrap();
    assert_eq!(msg6.deliveries, None, "a message with zero delivery rows must be null, not zeros");

    let broadcast = transcript_at(&path, "@all", None, None).unwrap();
    let msg1 = broadcast.messages.iter().find(|m| m.id == 1).unwrap();
    assert_eq!(msg1.deliveries, Some(DeliveryCounts { sent: 1, ..Default::default() }));
}

// ─────────────────────────────────────── test 6 ───────────────────────────────────────

#[test]
fn recent_refusals_counts_only_the_last_24h_and_never_attaches_to_a_message() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    empty_schema_db(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO deliveries (ts, message_id, sender, target, outcome, code) \
         VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours'), NULL, 'K', 'K.1', 'refused', 'rate-limited'); \
         INSERT INTO deliveries (ts, message_id, sender, target, outcome, code) \
         VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), NULL, 'K', 'K.1', 'refused', 'rate-limited');",
    )
    .unwrap();
    drop(conn);

    let snap = rooms_at(&path).unwrap();
    assert_eq!(snap.recent_refusals, 1, "only the within-24h refusal counts");

    let ts = transcript_at(&path, "K.1", None, None).unwrap();
    assert!(ts.messages.is_empty(), "a refusal never creates a message row, so it appears on no transcript");
}

// ─────────────────────────────────────── test 7 ───────────────────────────────────────

#[test]
fn tier_and_meta_claim_pass_through_without_altering_sender() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    seeded_db(&path);

    let broadcast = transcript_at(&path, "@all", None, None).unwrap();
    let msg1 = &broadcast.messages[0];
    assert_eq!(msg1.tier, "operator");
    assert!(msg1.verified);
    assert_eq!(msg1.sender, "operator");

    let to_k = transcript_at(&path, "K", None, None).unwrap();
    let msg3 = to_k.messages.iter().find(|m| m.id == 3).unwrap();
    assert_eq!(msg3.tier, "agent-message");
    assert!(!msg3.verified);
    assert_eq!(msg3.sender, "peer", "the mirrored sender must never be overwritten by the meta claim");
    assert_eq!(msg3.from_name_claim.as_deref(), Some("R"));
}

// ─────────────────────────────────────── test 8 ───────────────────────────────────────

#[test]
fn closed_room_reports_member_count_open_room_reports_null() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    seeded_db(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO rooms (name, created_by, created_at, topic, open) \
         VALUES ('#fleet', 'operator', '2026-08-16T12:00:00.000Z', 'the whole fleet', 1); \
         INSERT INTO rooms (name, created_by, created_at, topic, open) \
         VALUES ('#leads', 'operator', '2026-08-16T12:00:00.000Z', 'leads only', 0); \
         INSERT INTO room_members (room, address, added_by, added_at) \
         VALUES ('#leads', 'K', 'operator', '2026-08-16T12:00:00.000Z'); \
         INSERT INTO room_members (room, address, added_by, added_at) \
         VALUES ('#leads', 'peer', 'operator', '2026-08-16T12:00:00.000Z');",
    )
    .unwrap();
    drop(conn);

    let snap = rooms_at(&path).unwrap();
    let fleet = snap.rooms.iter().find(|r| r.target == "#fleet").unwrap();
    assert!(fleet.open);
    assert_eq!(fleet.member_count, None);
    assert_eq!(fleet.latest_id, 0, "no messages target '#fleet' in this fixture");

    let leads = snap.rooms.iter().find(|r| r.target == "#leads").unwrap();
    assert!(!leads.open);
    assert_eq!(leads.member_count, Some(2));
}

// ─────────────────────────────────────── test 9 ───────────────────────────────────────

#[test]
fn active_floor_row_is_reported_room_without_one_is_null() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    seeded_db(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "INSERT INTO rooms (name, created_by, created_at, topic, open) \
         VALUES ('#fleet', 'operator', '2026-08-16T12:00:00.000Z', NULL, 1); \
         INSERT INTO room_floor (room, holder, since, expires_at) \
         VALUES ('#fleet', 'R', strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
                 strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')); \
         INSERT INTO rooms (name, created_by, created_at, topic, open) \
         VALUES ('#stale', 'operator', '2026-08-16T12:00:00.000Z', NULL, 1); \
         INSERT INTO room_floor (room, holder, since, expires_at) \
         VALUES ('#stale', 'V', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'), \
                 strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'));",
    )
    .unwrap();
    drop(conn);

    let active = transcript_at(&path, "#fleet", None, None).unwrap();
    let floor = active.floor.expect("an active (unexpired) floor row must be reported");
    assert_eq!(floor.holder, "R");
    assert!(floor.until_ts.is_some());

    let expired = transcript_at(&path, "#stale", None, None).unwrap();
    assert!(expired.floor.is_none(), "an expired lease must be treated as free, not held");

    let no_row = transcript_at(&path, "K.1", None, None).unwrap();
    assert!(no_row.floor.is_none(), "a target with no room_floor row at all must be null");
}

// ─────────────────────────────────────── test 10 ───────────────────────────────────────

#[cfg(unix)]
#[test]
fn read_only_file_permissions_do_not_block_either_command() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    seeded_db(&path);

    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o444);
    std::fs::set_permissions(&path, perms).unwrap();

    let snap = rooms_at(&path);
    assert!(snap.is_ok(), "heddle_comms_rooms must succeed against a 0o444 file: {:?}", snap.err());

    let ts = transcript_at(&path, "@all", None, None);
    assert!(ts.is_ok(), "heddle_comms_transcript must succeed against a 0o444 file: {:?}", ts.err());
}

#[test]
fn initial_load_returns_newest_tail_and_limit_is_capped_at_500() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    conn.execute_batch(
        "INSERT INTO participants (address, kind, first_seen, last_seen) \
         VALUES ('R', 'agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');",
    )
    .unwrap();
    conn.execute_batch(
        "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 510) \
         INSERT INTO messages (ts, sender, target, kind, tier, verified, body) \
         SELECT '2026-01-01T00:00:00.000Z', 'R', '#bulk', 'chat', 'agent-message', 0, 'm' || n FROM c;",
    )
    .unwrap();
    drop(conn);

    // sinceId:None is the INITIAL load — it must page from the newest end, ascending. An
    // oldest-first page here would show ancient history and re-deliver everything via the cursor.
    let tail = transcript_at(&path, "#bulk", None, Some(3)).unwrap();
    let ids: Vec<i64> = tail.messages.iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![508, 509, 510], "newest 3, ascending for display");

    // An absurd requested limit is clamped to 500 (bounds the page and the IN() param lists).
    let capped = transcript_at(&path, "#bulk", None, Some(9_999)).unwrap();
    assert_eq!(capped.messages.len(), 500, "ceiling must clamp the page size");
    assert_eq!(capped.messages.last().unwrap().id, 510, "still anchored at the newest row");

    // Cursor paging is unchanged: strictly-forward from the cursor, oldest-first.
    let forward = transcript_at(&path, "#bulk", Some(505), Some(2)).unwrap();
    let fids: Vec<i64> = forward.messages.iter().map(|m| m.id).collect();
    assert_eq!(fids, vec![506, 507]);
}

#[test]
fn an_open_needs_human_item_behind_a_long_run_of_replied_ones_is_still_reported() {
    // gitar's edge case on #25: with a single 200-row candidate batch, an open item sitting past
    // position 200 (because the newest candidates are all already replied) was silently dropped —
    // the queue would under-report an item that genuinely needs Maya. The descending page walk
    // must keep descending until it finds open items or the rows run out.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    conn.execute_batch(
        "INSERT INTO participants (address, kind, first_seen, last_seen) VALUES \
         ('V', 'agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), \
         ('operator', 'operator', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');",
    )
    .unwrap();
    // id 1 = the OLD open item. ids 2..=261 = 260 newer needs-human rows, every one replied.
    conn.execute_batch(
        "INSERT INTO messages (ts, sender, target, kind, tier, verified, body) \
         VALUES ('2026-01-01T00:00:00.000Z', 'V', '#fleet', 'needs-human', 'agent-message', 0, \
                 'the genuinely open one, buried under 260 answered requests');",
    )
    .unwrap();
    conn.execute_batch(
        "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 260) \
         INSERT INTO messages (ts, sender, target, kind, tier, verified, body) \
         SELECT '2026-01-02T00:00:00.000Z', 'V', '#fleet', 'needs-human', 'agent-message', 0, \
                'answered ' || n FROM c;",
    )
    .unwrap();
    // The OPERATOR answers every one of those 260 (ids 2..=261) — only an operator-tier reply
    // closes a human-decision item — leaving exactly id 1 open.
    conn.execute_batch(
        "WITH RECURSIVE c(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM c WHERE n < 261) \
         INSERT INTO messages (ts, sender, target, kind, tier, verified, body, reply_to) \
         SELECT '2026-01-03T00:00:00.000Z', 'operator', '#fleet', 'chat', 'operator', 1, \
                'answered', n FROM c;",
    )
    .unwrap();
    drop(conn);

    let snap = rooms_at(&path).unwrap();
    let ids: Vec<i64> = snap.needs_human.iter().map(|r| r.id).collect();
    assert_eq!(
        ids,
        vec![1],
        "the one open item must survive the walk past 260 replied candidates"
    );
}
