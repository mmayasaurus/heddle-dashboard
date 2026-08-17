//! Read-only queries over `~/.heddle/comms.db` for the dashboard's fleet-chatroom panel.
//!
//! Schema authority is the heddle repo's `src/comms/log.ts` (the broker that writes this
//! database). Two Tauri commands are exposed: `heddle_comms_rooms` (rooms overview +
//! open needs-human/permission-request queue + a 24h refusal counter) and
//! `heddle_comms_transcript` (one target's paged message history + its room's floor lease).
//!
//! READ-ONLY CONTRACT: every connection here is opened `SQLITE_OPEN_READ_ONLY` (SQLite itself
//! refuses any write on the connection — see `open_readonly`) with `PRAGMA query_only = ON` on
//! top as defense-in-depth. This module must never write comms.db under any circumstance; that is
//! the fleet contract with the broker that owns it.
//!
//! SCHEMA STATE MACHINE (never deviate): missing db file → `schemaOk: true, schemaVersion: 0`,
//! empty payloads (fresh install, not an error). `user_version != 1` on an existing file →
//! `schemaOk: false` with the observed version, empty payloads, and no table is ever queried in
//! that state. Only a supported `user_version` reads tables.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

/// The `PRAGMA user_version` range this reader understands, tracking `COMMS_SCHEMA_VERSION` in the
/// broker's `src/comms/log.ts`.
///
/// A RANGE rather than one pinned version, because the broker's bumps so far are purely ADDITIVE:
/// v2 added a `message_mentions` table and changed nothing this reader touches (`messages`,
/// `deliveries`, `participants`, `rooms`, `room_members`, `room_floor`). Pinning v1 meant the panel
/// refused a live v2 database and rendered "unsupported" while perfectly readable data sat there —
/// found by pointing it at the real fleet log.
///
/// The safety property is unchanged and deliberate: anything ABOVE the max is still refused rather
/// than read optimistically, because a future bump could change a table we do read. Widen this only
/// after checking the broker's migration is additive for those tables.
const COMMS_SCHEMA_MIN: i64 = 1;
const COMMS_SCHEMA_MAX: i64 = 2;

fn schema_supported(v: i64) -> bool {
    (COMMS_SCHEMA_MIN..=COMMS_SCHEMA_MAX).contains(&v)
}

// ─────────────────────────────── output shapes (contract-fixed) ───────────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomsSnapshot {
    schema_ok: bool,
    schema_version: i64,
    rooms: Vec<RoomSummary>,
    needs_human: Vec<NeedsHumanRow>,
    recent_refusals: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomSummary {
    target: String,
    open: bool,
    topic: Option<String>,
    /// `null` for open rooms; `COUNT(room_members)` for closed ones.
    member_count: Option<i64>,
    /// `MAX(messages.id)` for this room's target; 0 when the room has no messages yet.
    latest_id: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NeedsHumanRow {
    id: i64,
    ts: String,
    sender: String,
    target: String,
    kind: String,
    body: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    schema_ok: bool,
    schema_version: i64,
    messages: Vec<TranscriptMessage>,
    floor: Option<FloorInfo>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    id: i64,
    ts: String,
    sender: String,
    target: String,
    kind: String,
    tier: String,
    verified: bool,
    body: String,
    reply_to: Option<i64>,
    dispatch_id: Option<i64>,
    /// `meta`'s `fromName` when present — a CLAIM, surfaced separately. NEVER merged into `sender`.
    from_name_claim: Option<String>,
    /// `participants.kind` for `sender`, when registered ("operator" | "agent" | "child" | null).
    sender_kind: Option<String>,
    /// Aggregated per message from `deliveries`; `null` when the message has no delivery rows.
    deliveries: Option<DeliveryCounts>,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryCounts {
    sent: i64,
    held: i64,
    released: i64,
    refused: i64,
    failed: i64,
    logged: i64,
}

impl DeliveryCounts {
    /// `outcome` comes straight from the grouped SQL result (one row per distinct outcome for
    /// this message), so each bucket is set at most once. An outcome outside the schema's CHECK
    /// list is ignored rather than fabricated into an unrelated bucket (strict row honesty).
    fn record(&mut self, outcome: &str, n: i64) {
        match outcome {
            "sent" => self.sent = n,
            "held" => self.held = n,
            "released" => self.released = n,
            "refused" => self.refused = n,
            "failed" => self.failed = n,
            "logged" => self.logged = n,
            _ => {}
        }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FloorInfo {
    holder: String,
    until_ts: Option<String>,
}

// ───────────────────────────────── path / connection helpers ──────────────────────────────────

/// `None` when no home directory exists — callers treat that as a fresh install rather than
/// ever touching a cwd-relative path.
fn comms_db_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".heddle").join("comms.db"))
}

/// Open read-only: `SQLITE_OPEN_READ_ONLY` is the hard guarantee (SQLite refuses any write on
/// this connection, full stop); `PRAGMA query_only` is defense-in-depth on top. Best-effort on the
/// pragma/busy-timeout, matching `heddle_stats::ledger()` — the open flag alone already proves
/// read-only-ness even if either soft setting fails.
fn open_readonly(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("comms.db open failed: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(3)).ok();
    conn.execute_batch("PRAGMA query_only = ON;").ok();
    Ok(conn)
}

fn read_user_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// Run a blocking read on the blocking pool — every command here touches SQLite/the filesystem,
/// and synchronous Tauri commands run on the main thread, so a slow disk must never stall the UI.
/// (Same rationale as `heddle_stats::blocking`; duplicated here since this module is independent.)
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// ──────────────────────────────────── heddle_comms_rooms ──────────────────────────────────────

/// Rooms overview: every room's summary, the open needs-human/permission-request queue (all
/// targets), and a 24h refused-delivery counter. Best-effort read-only view for the Fleet drawer's
/// chatroom panel; a missing or version-mismatched db yields a typed empty state, never an error.
#[tauri::command]
pub async fn heddle_comms_rooms() -> Result<RoomsSnapshot, String> {
    blocking(|| match comms_db_path() {
        Some(p) => rooms_at(&p),
        None => Ok(empty_rooms_snapshot(0, true)),
    })
    .await
}

fn rooms_at(path: &Path) -> Result<RoomsSnapshot, String> {
    if !path.exists() {
        return Ok(empty_rooms_snapshot(0, true));
    }
    let conn = open_readonly(path)?;
    let version = read_user_version(&conn)?;
    if !schema_supported(version) {
        return Ok(empty_rooms_snapshot(version, false));
    }
    Ok(RoomsSnapshot {
        schema_ok: true,
        schema_version: version,
        rooms: query_rooms(&conn)?,
        needs_human: query_needs_human(&conn)?,
        recent_refusals: query_recent_refusals(&conn)?,
    })
}

fn empty_rooms_snapshot(version: i64, ok: bool) -> RoomsSnapshot {
    RoomsSnapshot {
        schema_ok: ok,
        schema_version: version,
        rooms: vec![],
        needs_human: vec![],
        recent_refusals: 0,
    }
}

fn query_rooms(conn: &Connection) -> Result<Vec<RoomSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT r.name AS target, r.open, r.topic, \
             CASE WHEN r.open = 0 \
                  THEN (SELECT COUNT(*) FROM room_members m WHERE m.room = r.name) \
                  ELSE NULL END AS member_count, \
             COALESCE((SELECT MAX(msg.id) FROM messages msg WHERE msg.target = r.name), 0) AS latest_id \
             FROM rooms r ORDER BY r.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(RoomSummary {
                target: r.get("target")?,
                open: r.get::<_, i64>("open")? != 0,
                topic: r.get("topic")?,
                member_count: r.get("member_count")?,
                latest_id: r.get("latest_id")?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The contract-fixed anti-join: OPEN needs-human/permission-request rows, all targets, newest
/// first, capped 50. An item is closed ONLY by a reply at tier='operator'.
///
/// The tier clause is the whole point and must not be "simplified" away (contract owned by the
/// comms broker, corrected 2026-08-16 after it was reproduced closing a live item): 'needs-human'
/// means a HUMAN decides. Only tier='operator' is the human at the keyboard — the broker stamps
/// that tier, senders cannot request it, and it is origin-verified against the operator token. An
/// agent-message reply ("noted, waiting on Maya") acknowledging an item must NOT remove it from
/// the queue, and neither must an orchestrator-directive: an orchestrator acknowledging is not
/// the human deciding. The bias is deliberate — a human who resolves an item WITHOUT using
/// reply_to leaves it open, i.e. this fails OPEN. A stale item in front of Maya costs a glance;
/// a silently-closed one costs a lost decision.
///
/// One statement, ONE pass over `messages`: the uncorrelated subquery is evaluated once (SQLite
/// builds an ephemeral index over it for the `NOT IN` probe) instead of the correlated
/// `NOT EXISTS` form, which rescans the log once per candidate because `reply_to` has no index in
/// the broker schema and a read-only connection cannot add one. `reply_to IS NOT NULL` in the
/// subquery is load-bearing: a single NULL in a `NOT IN` set makes the whole predicate UNKNOWN
/// and would return an empty queue — i.e. would silently hide every open item.
///
/// This also drops the candidate cap an earlier revision had, so an open item can never be
/// hidden behind a long run of replied ones, at no extra scan cost.
fn query_needs_human(conn: &Connection) -> Result<Vec<NeedsHumanRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.ts, m.sender, m.target, m.kind, m.body \
             FROM messages m \
             WHERE m.kind IN ('needs-human','permission-request') \
               AND m.id NOT IN (SELECT reply_to FROM messages \
                                WHERE reply_to IS NOT NULL AND tier = 'operator') \
             ORDER BY m.id DESC LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(NeedsHumanRow {
                id: r.get("id")?,
                ts: r.get("ts")?,
                sender: r.get("sender")?,
                target: r.get("target")?,
                kind: r.get("kind")?,
                body: r.get("body")?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Refused deliveries (no message row was ever created) in the last 24h. `strftime(..., 'now',
/// '-1 day')` builds the cutoff in the SAME canonical form the broker writes (`toISOString()`:
/// `YYYY-MM-DDTHH:MM:SS.sssZ`), so a plain TEXT `>=` comparison against `ts` is exact — no Rust
/// date parsing/formatting is needed, and no new dependency either.
fn query_recent_refusals(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM deliveries \
         WHERE outcome = 'refused' AND message_id IS NULL \
           AND ts >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

// ────────────────────────────────── heddle_comms_transcript ───────────────────────────────────

/// One target's message page (`target = ? AND id > sinceId`, ascending, `idx_messages_target`),
/// each row's delivery counts and sender kind, and the target room's active floor lease.
#[tauri::command]
pub async fn heddle_comms_transcript(
    target: String,
    since_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Transcript, String> {
    blocking(move || match comms_db_path() {
        Some(p) => transcript_at(&p, &target, since_id, limit),
        None => Ok(empty_transcript(0, true)),
    })
    .await
}

fn transcript_at(
    path: &Path,
    target: &str,
    since_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Transcript, String> {
    if !path.exists() {
        return Ok(empty_transcript(0, true));
    }
    let conn = open_readonly(path)?;
    let version = read_user_version(&conn)?;
    if !schema_supported(version) {
        return Ok(empty_transcript(version, false));
    }
    // One deferred read transaction so the page, its delivery aggregates, sender kinds and the
    // floor row all come from a single SQLite snapshot (the broker appends concurrently).
    conn.execute_batch("BEGIN DEFERRED").map_err(|e| e.to_string())?;
    // Clamped on both sides: non-positive/missing -> 200; ceiling 500 keeps page sizes and the
    // follow-up IN(...) parameter lists bounded no matter what the caller asks for.
    let limit = match limit {
        Some(n) if n > 0 => n.min(500),
        _ => 200,
    };
    let raws = match since_id {
        // Cursor poll: strictly-forward page from the cursor.
        Some(since) => query_transcript_page(&conn, target, since, limit)?,
        // Initial load: the NEWEST `limit` rows (tail), ascending for display. An oldest-first
        // page here would show ancient history and the cursor would then re-deliver everything
        // between it and the present.
        None => query_transcript_tail(&conn, target, limit)?,
    };
    let ids: Vec<i64> = raws.iter().map(|m| m.id).collect();
    let senders = dedup(raws.iter().map(|m| m.sender.clone()));
    let deliveries = query_delivery_counts(&conn, &ids)?;
    let sender_kinds = query_sender_kinds(&conn, &senders)?;
    let messages = raws
        .into_iter()
        .map(|m| finalize_message(m, &deliveries, &sender_kinds))
        .collect();
    let floor = query_floor(&conn, target)?;
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(Transcript {
        schema_ok: true,
        schema_version: version,
        messages,
        floor,
    })
}

fn empty_transcript(version: i64, ok: bool) -> Transcript {
    Transcript {
        schema_ok: ok,
        schema_version: version,
        messages: vec![],
        floor: None,
    }
}

fn dedup(items: impl Iterator<Item = String>) -> Vec<String> {
    items.collect::<HashSet<_>>().into_iter().collect()
}

/// Raw row shape straight off `messages`, before delivery/participant enrichment.
struct RawMessage {
    id: i64,
    ts: String,
    sender: String,
    target: String,
    kind: String,
    tier: String,
    verified: bool,
    body: String,
    reply_to: Option<i64>,
    dispatch_id: Option<i64>,
    meta: Option<String>,
}

/// Newest `limit` rows for `target`, returned ascending: select the tail DESC, then reverse.
fn query_transcript_tail(
    conn: &Connection,
    target: &str,
    limit: i64,
) -> Result<Vec<RawMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, ts, sender, target, kind, tier, verified, body, reply_to, dispatch_id, meta \
             FROM messages WHERE target = ?1 ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![target, limit], map_raw_message)
        .map_err(|e| e.to_string())?;
    let mut page = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    page.reverse();
    Ok(page)
}

fn query_transcript_page(
    conn: &Connection,
    target: &str,
    since_id: i64,
    limit: i64,
) -> Result<Vec<RawMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, ts, sender, target, kind, tier, verified, body, reply_to, dispatch_id, meta \
             FROM messages WHERE target = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![target, since_id, limit], map_raw_message)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn map_raw_message(r: &rusqlite::Row) -> rusqlite::Result<RawMessage> {
    Ok(RawMessage {
        id: r.get("id")?,
        ts: r.get("ts")?,
        sender: r.get("sender")?,
        target: r.get("target")?,
        kind: r.get("kind")?,
        tier: r.get("tier")?,
        verified: r.get::<_, i64>("verified")? != 0,
        body: r.get("body")?,
        reply_to: r.get("reply_to")?,
        dispatch_id: r.get("dispatch_id")?,
        meta: r.get("meta")?,
    })
}

/// `meta`'s `fromName`, or `None` on anything short of a perfect parse (missing/NULL meta,
/// invalid JSON, no `fromName` key, or a non-string value) — malformed meta must never abort the
/// row, only blank this one claim field.
fn from_name_claim(meta: Option<&str>) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(meta?).ok()?;
    value.get("fromName")?.as_str().map(str::to_string)
}

fn finalize_message(
    raw: RawMessage,
    deliveries: &HashMap<i64, DeliveryCounts>,
    sender_kinds: &HashMap<String, String>,
) -> TranscriptMessage {
    TranscriptMessage {
        from_name_claim: from_name_claim(raw.meta.as_deref()),
        sender_kind: sender_kinds.get(&raw.sender).cloned(),
        deliveries: deliveries.get(&raw.id).cloned(),
        id: raw.id,
        ts: raw.ts,
        sender: raw.sender,
        target: raw.target,
        kind: raw.kind,
        tier: raw.tier,
        verified: raw.verified,
        body: raw.body,
        reply_to: raw.reply_to,
        dispatch_id: raw.dispatch_id,
    }
}

/// Delivery counts for exactly this page's message ids, in one grouped query (`deliveries` has no
/// FK to `messages`, so this must never be one query per message). An id absent from the returned
/// map has zero delivery rows — callers render that as `null`, never as a zeroed `DeliveryCounts`.
fn query_delivery_counts(
    conn: &Connection,
    ids: &[i64],
) -> Result<HashMap<i64, DeliveryCounts>, String> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT message_id, outcome, COUNT(*) AS n FROM deliveries \
         WHERE message_id IN ({placeholders}) GROUP BY message_id, outcome"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (message_id, outcome, n) = row.map_err(|e| e.to_string())?;
        out.entry(message_id)
            .or_insert_with(DeliveryCounts::default)
            .record(&outcome, n);
    }
    Ok(out)
}

/// `participants.kind` for exactly this page's senders, one batched query (no N+1).
fn query_sender_kinds(
    conn: &Connection,
    senders: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    if senders.is_empty() {
        return Ok(out);
    }
    let placeholders = vec!["?"; senders.len()].join(",");
    let sql = format!("SELECT address, kind FROM participants WHERE address IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(senders.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (address, kind) = row.map_err(|e| e.to_string())?;
        out.insert(address, kind);
    }
    Ok(out)
}

/// The active (unexpired) `room_floor` row for `target`, else `None`. `target` need not be a room
/// at all (a DM peer address simply matches no row) — same `strftime('now')` canonical-string
/// comparison technique as `query_recent_refusals`, so no Rust date math here either.
fn query_floor(conn: &Connection, target: &str) -> Result<Option<FloorInfo>, String> {
    conn.query_row(
        "SELECT holder, expires_at FROM room_floor \
         WHERE room = ?1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [target],
        |r| {
            Ok(FloorInfo {
                holder: r.get(0)?,
                until_ts: r.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "reader_tests.rs"]
mod tests;
