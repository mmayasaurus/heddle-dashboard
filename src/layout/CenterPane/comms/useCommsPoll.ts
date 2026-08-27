//! Polling data layer for the fleet chatroom (read-only). Owns two backend surfaces:
//!   - heddle_comms_rooms: rooms list + needs-human queue + refusal count. Polled every 5s,
//!     including for the visible collapsed global strip; hidden session panes opt out.
//!   - heddle_comms_transcript: messages for the active room. Polled every 2.5s ONLY while
//!     expanded. A room switch (or first expand) fetches with sinceId:null and REPLACES that
//!     room's messages; every subsequent poll on the same room uses the tracked cursor (last
//!     max id) and APPENDS only newer rows.
//! Also polls the existing heddle_fleet_roster command (same shape FleetDrawer uses) every 10s
//! while expanded, for the member presence list.
//!
//! Errors on any surface keep the last good data and surface a dim one-line message; they never
//! clear already-rendered content (see docs/TESTING-BAR.md — guards and failure paths matter).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

interface NeedsMayaSnapshotRow {
  issue: string;
  agent: string;
  ts: string;
  askPreview: string;
}

/** Client-owned row for the read-only Linear decision queue. It deliberately remains separate
 * from CommsNeedsHumanRow: its identifier is a Linear issue key, not a numeric comms message id. */
export interface NeedsMayaRow {
  issue: string;
  agent: string;
  ask: string;
  ts: string;
  linearUrl: string;
}

interface RoomsSnapshot {
  schemaOk: boolean;
  schemaVersion: number;
  rooms: CommsRoom[];
  needsHuman: CommsNeedsHumanRow[];
  needsMaya: NeedsMayaSnapshotRow[];
  needsMayaError: string | null;
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
export const AGENT_COLORS: Map<string, string> = new Map([
  ["R", "#7fb2ff"],
  ["S", "#4fc08d"],
  ["T", "#e3a857"],
  ["U", "#5ec8d8"],
  ["V", "#ef8fb6"],
  ["W", "#b9c46a"],
]);

export function agentColor(name: string): string | undefined {
  const key = name?.trim()[0]?.toUpperCase();
  return key ? AGENT_COLORS.get(key) : undefined;
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
  needsMaya: NeedsMayaRow[];
  needsMayaError: string | null;
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
  /** Immediately fetches the active transcript through its existing cursor append path. */
  refresh: () => void;
}

/**
 * Polls the chatroom's read-only surfaces. `expanded` gates transcript/roster polls;
 * `pollRoomsWhenCollapsed` lets hidden keep-alive session panes opt out of rooms polling while
 * preserving the visible collapsed global strip's badge refresh;
 * `activeTarget` selects which room's transcript is tracked. Pass `null` for activeTarget until
 * a room is known (e.g. before the first rooms response resolves).
 */
export function useCommsPoll(
  expanded: boolean,
  activeTarget: string | null,
  pollRoomsWhenCollapsed = true,
): UseCommsPollResult {
  const [loaded, setLoaded] = useState(false);
  const [schemaOk, setSchemaOk] = useState(true);
  const [schemaVersion, setSchemaVersion] = useState(1);
  const [rooms, setRooms] = useState<CommsRoom[]>([]);
  const [needsHuman, setNeedsHuman] = useState<CommsNeedsHumanRow[]>([]);
  const [needsMaya, setNeedsMaya] = useState<NeedsMayaRow[]>([]);
  const [needsMayaError, setNeedsMayaError] = useState<string | null>(null);
  const [recentRefusals, setRecentRefusals] = useState(0);
  const [roomsError, setRoomsError] = useState<string | null>(null);

  const [messagesByRoom, setMessagesByRoom] = useState<Map<string, CommsMessage[]>>(new Map());
  const [floor, setFloor] = useState<CommsFloor | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const [roster, setRoster] = useState<FleetAgent[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const [lastSeenTick, setLastSeenTick] = useState(0);
  // Per-room read cursor: last max message id seen from the backend (not the same as lastSeen,
  // which is the last id the OPERATOR has viewed). Keyed by target, survives room switches.
  const cursorsRef = useRef<Map<string, number>>(new Map());
  const refreshRef = useRef<() => void>(() => {
    /* no-op until the transcript effect installs the real refresh */
  });
  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);

  // The visible collapsed global strip retains its rooms poll for its needs-human badge. Hidden
  // keep-alive session panes pass false and therefore make no background request.
  useEffect(() => {
    if (!isTauri) return;
    if (!expanded && !pollRoomsWhenCollapsed) return;
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
        setNeedsMaya(
          (snap.needsMaya ?? []).map((row) => ({
            issue: row.issue,
            agent: row.agent,
            ask: row.askPreview,
            ts: row.ts,
            linearUrl: `https://linear.app/spinventory/issue/${row.issue}`,
          })),
        );
        setNeedsMayaError(snap.needsMayaError ?? null);
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
  }, [expanded, pollRoomsWhenCollapsed]);

  // Transcript poll: only while expanded, for the active room. Re-runs (fresh replace fetch +
  // cursor reset) whenever the room switches or the pane (re-)expands.
  useEffect(() => {
    if (!isTauri) return;
    if (!expanded || !activeTarget) return;
    const target = activeTarget;
    let cancelled = false;
    let intervalId: number | undefined;
    // In-flight guard, PER effect run (not a shared ref): a cancelled fetch's finally must never
    // clear a NEWER effect's guard on a room switch (codeant HED-164 review). `refreshPending`
    // remembers a refresh() requested while a fetch was in flight, so an eager sent-echo refresh is
    // never silently dropped to the next 2.5s tick when it races the poll — it re-fetches the instant
    // the in-flight fetch settles.
    let busy = false;
    let refreshPending = false;
    // A room switch (or first expand) must not go on showing the previous room's floor while the
    // fresh fetch is still in flight — clear it synchronously, before any async work starts.
    setFloor(null);

    const applyFresh = (t: TranscriptPayload) => {
      setMessagesByRoom((prev) => {
        const next = new Map(prev);
        next.set(target, t.messages);
        return next;
      });
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
        setMessagesByRoom((prev) => {
          const next = new Map(prev);
          next.set(target, [...(prev.get(target) ?? []), ...fresh].slice(-MAX_ROOM_MESSAGES));
          return next;
        });
        const maxId = fresh.reduce((m, x) => Math.max(m, x.id), cur);
        cursorsRef.current.set(target, maxId);
      }
      setFloor(t.floor);
    };

    const fetchFresh = async () => {
      if (!isTauri) return;
      busy = true;
      try {
        const t = await invoke<TranscriptPayload>("heddle_comms_transcript", { target, sinceId: null });
        if (cancelled) return;
        applyFresh(t);
        setTranscriptError(null);
      } catch (e) {
        if (!cancelled) setTranscriptError(String(e));
      } finally {
        busy = false;
        if (refreshPending && !cancelled) {
          refreshPending = false;
          void fetchCursor();
        }
      }
    };
    const fetchCursor = async () => {
      if (!isTauri || cancelled) return;
      // In-flight guard: a tick (or refresh) that lands while a fetch is running does not run
      // concurrently; a refresh() sets refreshPending so its fetch is re-issued, never lost.
      if (busy) return;
      const since = cursorsRef.current.get(target) ?? 0;
      busy = true;
      try {
        const t = await invoke<TranscriptPayload>("heddle_comms_transcript", { target, sinceId: since });
        if (cancelled) return;
        applyCursor(t);
        setTranscriptError(null);
      } catch (e) {
        if (!cancelled) setTranscriptError(String(e));
      } finally {
        busy = false;
        if (refreshPending && !cancelled) {
          refreshPending = false;
          void fetchCursor();
        }
      }
    };

    // Eager sent-echo refresh (HED-164): fetch now if idle; if a fetch is in flight, remember it and
    // re-fetch the instant that fetch settles — so a send racing the poll is never silently dropped.
    // Renders only what the broker logged (no optimistic insert).
    refreshRef.current = () => {
      if (busy) {
        refreshPending = true;
      } else {
        void fetchCursor();
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
      refreshRef.current = () => {
        /* no-op: the effect for this room is torn down */
      };
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
    const msgs = messagesByRoom.get(activeTarget);
    if (!msgs || msgs.length === 0) return;
    const maxId = msgs.reduce((m, x) => Math.max(m, x.id), 0);
    const key = LAST_SEEN_PREFIX + activeTarget;
    if (maxId > (Number(lsGet(key)) || 0)) {
      lsSet(key, String(maxId));
      setLastSeenTick((n) => n + 1);
    }
  }, [expanded, activeTarget, messagesByRoom]);

  const unreadByTarget = useMemo(() => {
    // Object.create(null): rooms[].target is externally-derived (backend-controlled string
    // keys), so the map is built with no prototype chain rather than a {} literal.
    const map: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
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
    needsMaya,
    needsMayaError,
    recentRefusals,
    roomsError,
    messages: activeTarget ? (messagesByRoom.get(activeTarget) ?? []) : [],
    floor,
    transcriptError,
    roster,
    rosterError,
    unreadByTarget,
    refresh,
  };
}
