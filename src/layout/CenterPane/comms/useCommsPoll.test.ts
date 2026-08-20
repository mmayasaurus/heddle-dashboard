//! Behavioral tests for the polling/cursor/schema/unread logic (HED-74b spec items 5-9), using
//! fake timers exactly like the reference panels' pattern (window.setInterval + vi.advanceTimersByTimeAsync).
//! `invoke`/`isTauri` are mocked so these tests have zero dependency on the parallel Rust worker.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../ipc/transport";
import { useCommsPoll } from "./useCommsPoll";
import type { CommsFloor, CommsMessage, CommsNeedsHumanRow, CommsRoom, FleetAgent } from "./useCommsPoll";

vi.mock("../../../ipc/transport", () => ({ invoke: vi.fn(), isTauri: true }));

const mockInvoke = vi.mocked(invoke);

function mkRoom(overrides: Partial<CommsRoom> & { target: string }): CommsRoom {
  return { open: true, topic: null, memberCount: null, latestId: 0, ...overrides };
}
function mkMsg(id: number, target: string): CommsMessage {
  return {
    id,
    ts: "2026-08-16T17:00:00Z",
    sender: "R",
    target,
    kind: "chat",
    tier: "agent",
    verified: false,
    body: `msg ${id}`,
    replyTo: null,
    dispatchId: null,
    fromNameClaim: null,
    senderKind: "agent",
    deliveries: null,
  };
}
function mkNeedsHumanRow(id: number): CommsNeedsHumanRow {
  return { id, ts: "2026-08-16T17:00:00Z", sender: "U", target: "#fleet", kind: "needs-human", body: `row ${id}` };
}

// Mutable fixture state, reset every test.
let roomsResponse: {
  schemaOk: boolean;
  schemaVersion: number;
  rooms: CommsRoom[];
  needsHuman: CommsNeedsHumanRow[];
  recentRefusals: number;
};
let roomsShouldFail: boolean;
let transcriptStore: Map<string, CommsMessage[]>;
let floorStore: Map<string, CommsFloor | null>;
let rosterResponse: FleetAgent[];

beforeEach(() => {
  roomsResponse = { schemaOk: true, schemaVersion: 1, rooms: [mkRoom({ target: "#fleet" })], needsHuman: [], recentRefusals: 0 };
  roomsShouldFail = false;
  transcriptStore = new Map();
  floorStore = new Map();
  rosterResponse = [];
  localStorage.clear();

  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "heddle_comms_rooms") {
      return roomsShouldFail ? Promise.reject(new Error("boom")) : Promise.resolve(roomsResponse);
    }
    if (cmd === "heddle_comms_transcript") {
      const target = args?.target as string;
      const sinceId = (args?.sinceId as number | null) ?? 0;
      const all = transcriptStore.get(target) ?? [];
      const messages = all.filter((m) => m.id > sinceId);
      return Promise.resolve({ schemaOk: true, schemaVersion: 1, messages, floor: floorStore.get(target) ?? null });
    }
    if (cmd === "heddle_fleet_roster") {
      return Promise.resolve(rosterResponse);
    }
    return Promise.reject(new Error("unexpected invoke cmd: " + cmd));
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Last element without `Array.prototype.at` — this repo's tsconfig lib is ES2020, and `.at()`
 *  needs ES2022. A stray home-directory @types/node masks the error locally, so a `.at(` here
 *  passes `tsc` on a dev machine and fails the CI gate. Indexed access is the repo convention. */
function lastCall<T>(calls: T[]): T | undefined {
  return calls.length > 0 ? calls[calls.length - 1] : undefined;
}

describe("useCommsPoll", () => {
  it("fetches rooms immediately on mount and sets loaded=true", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCommsPoll(true, null));
    await flush();
    expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_rooms");
    expect(result.current.loaded).toBe(true);
    expect(result.current.rooms).toEqual([mkRoom({ target: "#fleet" })]);
  });

  it("regression PR#71 — hidden chat panes do not poll rooms until they become visible", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ expanded, target }: { expanded: boolean; target: string | null }) => useCommsPoll(expanded, target, false), {
      initialProps: { expanded: false, target: null } as { expanded: boolean; target: string | null },
    });
    await flush();
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_rooms")).toHaveLength(0);
    expect(mockInvoke.mock.calls.some((c) => c[0] === "heddle_comms_transcript")).toBe(false);

    await flush(5000);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_rooms")).toHaveLength(0);
    expect(mockInvoke.mock.calls.some((c) => c[0] === "heddle_comms_transcript")).toBe(false);

    rerender({ expanded: true, target: "#fleet" });
    await flush();
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_rooms")).toHaveLength(1);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript")).toHaveLength(1);

    await flush(2500);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript")).toHaveLength(2);
    // Once visible, rooms polls on its normal cadence too.
    await flush(2500); // total 5000ms since expand
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_rooms")).toHaveLength(2);
  });

  it("test 6: a room switch fetches with sinceId:null and replaces messages; the next poll on that room appends only newer ids via a cursor sinceId", async () => {
    vi.useFakeTimers();
    transcriptStore.set("#fleet", [mkMsg(1, "#fleet"), mkMsg(2, "#fleet")]);
    transcriptStore.set("T", [mkMsg(50, "T")]);

    const { result, rerender } = renderHook(({ target }: { target: string | null }) => useCommsPoll(true, target), {
      initialProps: { target: "#fleet" },
    });
    await flush();
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]);
    const firstFetch = lastCall(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript"));
    expect(firstFetch?.[1]).toEqual({ target: "#fleet", sinceId: null });

    // A new message lands upstream; the next 2.5s cursor poll must append only it.
    transcriptStore.set("#fleet", [...transcriptStore.get("#fleet")!, mkMsg(3, "#fleet")]);
    await flush(2500);
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    const cursorFetch = lastCall(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript"));
    expect(cursorFetch?.[1]).toEqual({ target: "#fleet", sinceId: 2 });

    // Switching rooms replaces the visible messages with T's (not a union with #fleet's).
    rerender({ target: "T" });
    await flush();
    expect(result.current.messages.map((m) => m.id)).toEqual([50]);
    const switchFetch = lastCall(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript"));
    expect(switchFetch?.[1]).toEqual({ target: "T", sinceId: null });
  });

  it("fix 2: a slow initial fetch delays the poll interval, so a tick that would've raced it can't create duplicate rows", async () => {
    vi.useFakeTimers();
    transcriptStore.set("#fleet", [mkMsg(1, "#fleet"), mkMsg(2, "#fleet")]);

    let resolveFresh: (v: unknown) => void = () => {};
    const freshGate = new Promise((resolve) => {
      resolveFresh = resolve;
    });
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "heddle_comms_rooms") return Promise.resolve(roomsResponse);
      if (cmd === "heddle_comms_transcript") {
        const target = args?.target as string;
        const sinceId = (args?.sinceId as number | null) ?? null;
        const all = transcriptStore.get(target) ?? [];
        const payload = { schemaOk: true, schemaVersion: 1, messages: all.filter((m) => m.id > (sinceId ?? 0)), floor: null };
        // Only the initial fresh fetch (sinceId: null) is held open; cursor fetches resolve immediately.
        return sinceId === null ? freshGate.then(() => payload) : Promise.resolve(payload);
      }
      if (cmd === "heddle_fleet_roster") return Promise.resolve([]);
      return Promise.reject(new Error("unexpected invoke cmd: " + cmd));
    });

    const { result } = renderHook(() => useCommsPoll(true, "#fleet"));
    await flush(); // the initial fetchFresh() call is issued but stays pending on freshGate

    // Advance well past one (and then two) 2.5s poll intervals while still pending: since the
    // interval isn't created until fetchFresh settles, no second transcript call can happen yet.
    await flush(6000);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript")).toHaveLength(1);
    expect(result.current.messages).toEqual([]);

    resolveFresh(undefined);
    await flush();
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]); // no duplicates from a queued tick

    // The interval now runs normally post-settle, and still appends no duplicates (no new rows upstream).
    await flush(2500);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript")).toHaveLength(2);
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("fix 3: switching to a room whose fetch hasn't resolved yet clears floor synchronously, not the old room's floor", async () => {
    vi.useFakeTimers();
    floorStore.set("#fleet", { holder: "R", untilTs: null });
    transcriptStore.set("#fleet", [mkMsg(1, "#fleet")]);
    transcriptStore.set("T", [mkMsg(2, "T")]);

    const { result, rerender } = renderHook(({ target }: { target: string | null }) => useCommsPoll(true, target), {
      initialProps: { target: "#fleet" } as { target: string | null },
    });
    await flush();
    expect(result.current.floor).toEqual({ holder: "R", untilTs: null });

    let resolveT: (v: unknown) => void = () => {};
    const tGate = new Promise((resolve) => {
      resolveT = resolve;
    });
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "heddle_comms_rooms") return Promise.resolve(roomsResponse);
      if (cmd === "heddle_comms_transcript") {
        const target = args?.target as string;
        const all = transcriptStore.get(target) ?? [];
        const payload = { schemaOk: true, schemaVersion: 1, messages: all, floor: floorStore.get(target) ?? null };
        return target === "T" ? tGate.then(() => payload) : Promise.resolve(payload);
      }
      if (cmd === "heddle_fleet_roster") return Promise.resolve([]);
      return Promise.reject(new Error("unexpected invoke cmd: " + cmd));
    });

    rerender({ target: "T" });
    // Synchronous: floor must already be null even though T's fetch is still pending on tGate.
    expect(result.current.floor).toBeNull();

    resolveT(undefined);
    await flush();
    expect(result.current.floor).toBeNull(); // T has no floor in this fixture
  });

  it("test 5: needsHuman is replaced (not unioned) on each rooms poll — a row present in poll N is gone once poll N+1's payload omits it", async () => {
    vi.useFakeTimers();
    roomsResponse.needsHuman = [mkNeedsHumanRow(100)];
    const { result } = renderHook(() => useCommsPoll(true, null));
    await flush();
    expect(result.current.needsHuman.map((r) => r.id)).toEqual([100]);

    roomsResponse = { ...roomsResponse, needsHuman: [] }; // row 100 got a reply and dropped off
    await flush(5000);
    expect(result.current.needsHuman).toEqual([]);
  });

  it("test 8: unreadByTarget is true while latestId is newer than the stored lastSeen cursor, and clears once the room is opened", async () => {
    vi.useFakeTimers();
    roomsResponse.rooms = [mkRoom({ target: "#fleet", latestId: 5 })];
    transcriptStore.set("#fleet", [mkMsg(1, "#fleet"), mkMsg(5, "#fleet")]);

    const { result, rerender } = renderHook(({ target }: { target: string | null }) => useCommsPoll(true, target), {
      initialProps: { target: null } as { target: string | null },
    });
    await flush();
    expect(result.current.unreadByTarget["#fleet"]).toBe(true); // never viewed: 5 > 0

    rerender({ target: "#fleet" }); // "opening the room"
    await flush();
    expect(result.current.unreadByTarget["#fleet"]).toBe(false);
    expect(localStorage.getItem("heddle.comms.lastSeen.#fleet")).toBe("5");
  });

  it("passes schemaOk/schemaVersion straight through from the rooms payload", async () => {
    vi.useFakeTimers();
    roomsResponse = { schemaOk: false, schemaVersion: 2, rooms: [], needsHuman: [], recentRefusals: 0 };
    const { result } = renderHook(() => useCommsPoll(true, null));
    await flush();
    expect(result.current.schemaOk).toBe(false);
    expect(result.current.schemaVersion).toBe(2);
    expect(result.current.loaded).toBe(true);
  });

  it("keeps the last good rooms data and surfaces a dim error string when a poll fails", async () => {
    vi.useFakeTimers();
    roomsResponse.rooms = [mkRoom({ target: "#fleet", latestId: 1 })];
    const { result } = renderHook(() => useCommsPoll(true, null));
    await flush();
    expect(result.current.rooms).toHaveLength(1);
    expect(result.current.roomsError).toBeNull();

    roomsShouldFail = true;
    await flush(5000);
    expect(result.current.rooms).toHaveLength(1); // unchanged
    expect(result.current.roomsError).toContain("boom");
  });

  it("roster polls every 10s while expanded and not at all while collapsed", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ expanded }: { expanded: boolean }) => useCommsPoll(expanded, "#fleet"), {
      initialProps: { expanded: false },
    });
    await flush();
    expect(mockInvoke.mock.calls.some((c) => c[0] === "heddle_fleet_roster")).toBe(false);

    rerender({ expanded: true });
    await flush();
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_fleet_roster")).toHaveLength(1);

    await flush(10_000);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_fleet_roster")).toHaveLength(2);
  });
});
