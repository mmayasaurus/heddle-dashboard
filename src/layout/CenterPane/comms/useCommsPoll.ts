//! Polling data layer for the fleet chatroom (read-only). Owns two backend surfaces:
//!   - heddle_comms_rooms: rooms list + needs-human queue + refusal count. Polled every 5s
//!     ALWAYS (drives the collapsed-strip badge), independent of expanded/collapsed state.
//!   - heddle_comms_transcript: messages for the active room. Polled every 2.5s ONLY while
//!     expanded. A room switch (or first expand) fetches with sinceId:null and REPLACES that
//!     room's messages; every subsequent poll on the same room uses the tracked cursor (last
//!     max id) and APPENDS only newer rows.
//! Also polls the existing heddle_fleet_roster command (same shape FleetDrawer uses) every 10s
//! while expanded, for the member presence list.
//!
//! Errors on any surface keep the last good data and surface a dim one-line message; they never
//! clear already-rendered content (see docs/TESTING-BAR.md — guards and failure paths matter).

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "../../../ipc/transport";

// ── Backend payload shapes (heddle-comms.db, HED-74a contract — field names fixed) ──

export interface CommsRoom {
  target: string;
  open: boolean;
  topic: string | null;
  memberCount: number | null;
  latestId: number;
}

export interface CommsNeedsHumanRow {
  id: number;
  ts: string;
  sender: string;
  target: string;
  kind: string;
  body: string;
}

interface RoomsSnapshot {
  schemaOk: boolean;
  schemaVersion: number;
  rooms: CommsRoom[];
  needsHuman: CommsNeedsHumanRow[];
  recentRefusals: number;
}

export interface CommsDeliveries {
  sent: number;
  held: number;
  released: number;
  refused: number;
  failed: number;
  logged: number;
}

export interface CommsMessage {
  id: number;
  ts: string;
  sender: string;
  target: string;
  kind: string;
  tier: string;
  verified: boolean;
  body: string;
  replyTo: number | null;
  dispatchId: number | null;
  /** meta JSON's fromName, if present — a CLAIM surfaced separately. NEVER merge into sender. */
  fromNameClaim: string | null;
  senderKind: "operator" | "agent" | "child" | null;
  deliveries: CommsDeliveries | null;
}

export interface CommsFloor {
  holder: string;
  untilTs: string | null;
}

interface TranscriptPayload {
  schemaOk: boolean;
  schemaVersion: number;
  messages: CommsMessage[];
  floor: CommsFloor | null;
}

// Fleet roster: same shape FleetDrawer.tsx invokes via heddle_fleet_roster (copied, not
// imported — FleetDrawer does not export these types, and it must not be edited).
export interface FleetWorker {
  id: number;
  taskClass: string;
  provider: string;
  model: string;
  startedAt: string;
  cwd: string;
  elapsedMs: number;
  stale: boolean;
}

export interface FleetAgent {
  name: string;
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  kind: string;
  updatedAtMs: number;
  alive: boolean;
  workers: FleetWorker[];
}

/** Client-side cap per room: cursor polls append forever in a long session; the backend pages
 *  at most 200 per fetch, so trimming to the newest 500 keeps memory flat without ever hiding
 *  anything the operator hasn't already scrolled past hours ago. */
const MAX_ROOM_MESSAGES = 500;
const ROOMS_POLL_MS = 5_000;
const TRANSCRIPT_POLL_MS = 2_500;
const ROSTER_POLL_MS = 10_000;
const LAST_SEEN_PREFIX = "heddle.comms.lastSeen.";

/** Per-agent letter color from the approved mock palette (HED-74 card 06). */
export const AGENT_COLORS: Record<string, string> = {
  R: "#7fb2ff",
  S: "#4fc08d",
  T: "#e3a857",
  U: "#5ec8d8",
  V: "#ef8fb6",
  W: "#b9c46a",
};

export function agentColor(name: string): string | undefined {
  const key = name?.trim()[0]?.toUpperCase();
  return key ? AGENT_COLORS[key] : undefined;
}

/** Read localStorage, returning null on any failure (disabled/full/unavailable storage) instead
 *  of throwing. Every localStorage touch in this module and ChatroomPane.tsx goes through this. */
export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write localStorage; no-op on failure instead of throwing. */
export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage unavailable/full — the write is best-effort. */
  }
}

/** The backend caps needsHuman at 50 rows; render an exact 50 as "50+" so a capped count never
 *  looks like a precise total. */
export function formatNeedsHumanCount(n: number): string {
  return n === 50 ? "50+" : String(n);
}

function getLastSeen(target: string): number {
  return Number(lsGet(LAST_SEEN_PREFIX + target)) || 0;
}

export interface UseCommsPollResult {
  /** True once the first heddle_comms_rooms response (success or failure) has landed. Gates the
   *  expanded view so it never flashes the fresh-install empty state before real data arrives. */
  loaded: boolean;
  schemaOk: boolean;
  schemaVersion: number;
  rooms: CommsRoom[];
  needsHuman: CommsNeedsHumanRow[];
  recentRefusals: number;
  roomsError: string | null;
  /** Messages for the active room only (already replace/append-resolved). */
  messages: CommsMessage[];
  floor: CommsFloor | null;
  transcriptError: string | null;
  roster: FleetAgent[];
  rosterError: string | null;
  /** target -> has content newer than this client's last-seen cursor for that room. */
  unreadByTarget: Record<string, boolean>;
}

/**
 * Polls the chatroom's read-only surfaces. `expanded` gates the transcript/roster polls;
 * `activeTarget` selects which room's transcript is tracked. Pass `null` for activeTarget until
 * a room is known (e.g. before the first rooms response resolves).
 */
export function useCommsPoll(expanded: boolean, activeTarget: string | null): UseCommsPollResult {
  const [loaded, setLoaded] = useState(false);
  const [schemaOk, setSchemaOk] = useState(true);
  const [schemaVersion, setSchemaVersion] = useState(1);
  const [rooms, setRooms] = useState<CommsRoom[]>([]);
  const [needsHuman, setNeedsHuman] = useState<CommsNeedsHumanRow[]>([]);
  const [recentRefusals, setRecentRefusals] = useState(0);
  const [roomsError, setRoomsError] = useState<string | null>(null);

  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, CommsMessage[]>>({});
  const [floor, setFloor] = useState<CommsFloor | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const [roster, setRoster] = useState<FleetAgent[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const [lastSeenTick, setLastSeenTick] = useState(0);
  // Per-room read cursor: last max message id seen from the backend (not the same as lastSeen,
  // which is the last id the OPERATOR has viewed). Keyed by target, survives room switches.
  const cursorsRef = useRef<Map<string, number>>(new Map());
  // In-flight guard for the transcript poll: true while a fetch (fresh or cursor) is running.
  const busyRef = useRef(false);

  // Rooms poll: every 5s, always, regardless of expanded/collapsed — drives the collapsed badge.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const fetchRooms = async () => {
      if (!isTauri) return;
      try {
        const snap = await invoke<RoomsSnapshot>("heddle_comms_rooms");
        if (cancelled) return;
        setSchemaOk(snap.schemaOk);
        setSchemaVersion(snap.schemaVersion);
        setRooms(snap.rooms);
        setNeedsHuman(snap.needsHuman);
        setRecentRefusals(snap.recentRefusals);
        setRoomsError(null);
      } catch (e) {
        if (!cancelled) setRoomsError(String(e));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void fetchRooms();
    const id = window.setInterval(() => void fetchRooms(), ROOMS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Transcript poll: only while expanded, for the active room. Re-runs (fresh replace fetch +
  // cursor reset) whenever the room switches or the pane (re-)expands.
  useEffect(() => {
    if (!isTauri) return;
    if (!expanded || !activeTarget) return;
    const target = activeTarget;
    let cancelled = false;
    let intervalId: number | undefined;
    // A room switch (or first expand) must not go on showing the previous room's floor while the
    // fresh fetch is still in flight — clear it synchronously, before any async work starts.
    setFloor(null);

    const applyFresh = (t: TranscriptPayload) => {
      setMessagesByRoom((prev) => ({ ...prev, [target]: t.messages }));
      const maxId = t.messages.reduce((m, x) => Math.max(m, x.id), 0);
      cursorsRef.current.set(target, maxId);
      setFloor(t.floor);
    };
    const applyCursor = (t: TranscriptPayload) => {
      // Defense in depth: only ever append ids strictly newer than this room's tracked cursor,
      // even though the backend was already asked to filter by sinceId.
      const cur = cursorsRef.current.get(target) ?? 0;
      const fresh = t.messages.filter((m) => m.id > cur);
      if (fresh.length > 0) {
        setMessagesByRoom((prev) => ({
          ...prev,
          [target]: [...(prev[target] ?? []), ...fresh].slice(-MAX_ROOM_MESSAGES),
        }));
        const maxId = fresh.reduce((m, x) => Math.max(m, x.id), cur);
        cursorsRef.current.set(target, maxId);
      }
      setFloor(t.floor);
    };

    const fetchFresh = async () => {
      if (!isTauri) return;
      busyRef.current = true;
      try {
        const t = await invoke<TranscriptPayload>("heddle_comms_transcript", { target, sinceId: null });
        if (cancelled) return;
        applyFresh(t);
        setTranscriptError(null);
      } catch (e) {
        if (!cancelled) setTranscriptError(String(e));
      } finally {
        busyRef.current = false;
      }
    };
    const fetchCursor = async () => {
      if (!isTauri) return;
      // In-flight guard: a tick that lands while a fetch is still running SKIPS — it never queues.
      if (busyRef.current) return;
      const since = cursorsRef.current.get(target) ?? 0;
      busyRef.current = true;
      try {
        const t = await invoke<TranscriptPayload>("heddle_comms_transcript", { target, sinceId: since });
        if (cancelled) return;
        applyCursor(t);
        setTranscriptError(null);
      } catch (e) {
        if (!cancelled) setTranscriptError(String(e));
      } finally {
        busyRef.current = false;
      }
    };

    // Start the poll interval only after the initial fetch settles, so a slow first load can't
    // race a since=0 cursor tick into appending a duplicate page.
    void fetchFresh().finally(() => {
      if (cancelled) return;
      intervalId = window.setInterval(() => void fetchCursor(), TRANSCRIPT_POLL_MS);
    });

    return () => {
      cancelled = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [expanded, activeTarget]);

  // Roster poll: every 10s while expanded (same command/shape FleetDrawer uses).
  useEffect(() => {
    if (!isTauri) return;
    if (!expanded) return;
    let cancelled = false;
    const fetchRoster = async () => {
      if (!isTauri) return;
      try {
        const r = await invoke<FleetAgent[]>("heddle_fleet_roster");
        if (cancelled) return;
        setRoster(r);
        setRosterError(null);
      } catch (e) {
        if (!cancelled) setRosterError(String(e));
      }
    };
    void fetchRoster();
    const id = window.setInterval(() => void fetchRoster(), ROSTER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [expanded]);

  // Viewing a room while expanded advances its lastSeen cursor to the max visible id.
  useEffect(() => {
    if (!expanded || !activeTarget) return;
    const msgs = messagesByRoom[activeTarget];
    if (!msgs || msgs.length === 0) return;
    const maxId = msgs.reduce((m, x) => Math.max(m, x.id), 0);
    const key = LAST_SEEN_PREFIX + activeTarget;
    if (maxId > (Number(lsGet(key)) || 0)) {
      lsSet(key, String(maxId));
      setLastSeenTick((n) => n + 1);
    }
  }, [expanded, activeTarget, messagesByRoom]);

  const unreadByTarget = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const r of rooms) map[r.target] = r.latestId > getLastSeen(r.target);
    return map;
    // lastSeenTick is a deliberate dependency: it has no direct field here, but its change is the
    // only signal that localStorage's lastSeen values (read fresh by getLastSeen above) moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, lastSeenTick]);

  return {
    loaded,
    schemaOk,
    schemaVersion,
    rooms,
    needsHuman,
    recentRefusals,
    roomsError,
    messages: activeTarget ? messagesByRoom[activeTarget] ?? [] : [],
    floor,
    transcriptError,
    roster,
    rosterError,
    unreadByTarget,
  };
}
