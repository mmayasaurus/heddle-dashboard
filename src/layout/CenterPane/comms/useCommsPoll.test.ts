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

describe("useCommsPoll", () => {
  it("fetches rooms immediately on mount and sets loaded=true", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCommsPoll(false, null));
    await flush();
    expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_rooms");
    expect(result.current.loaded).toBe(true);
    expect(result.current.rooms).toEqual([mkRoom({ target: "#fleet" })]);
  });

  it("test 7: the rooms poll keeps running every 5s while collapsed; the transcript poll only starts once expanded, then runs every 2.5s", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ expanded, target }: { expanded: boolean; target: string | null }) => useCommsPoll(expanded, target), {
      initialProps: { expanded: false, target: null } as { expanded: boolean; target: string | null },
    });
    await flush();
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_rooms")).toHaveLength(1);
    expect(mockInvoke.mock.calls.some((c) => c[0] === "heddle_comms_transcript")).toBe(false);

    await flush(5000);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_rooms")).toHaveLength(2);
    expect(mockInvoke.mock.calls.some((c) => c[0] === "heddle_comms_transcript")).toBe(false);

    rerender({ expanded: true, target: "#fleet" });
    await flush();
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript")).toHaveLength(1);

    await flush(2500);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript")).toHaveLength(2);
    // Rooms keeps polling too, independent of expanded.
    await flush(2500); // total 5000ms since expand
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_rooms")).toHaveLength(3);
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
    const firstFetch = mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript").at(-1);
    expect(firstFetch?.[1]).toEqual({ target: "#fleet", sinceId: null });

    // A new message lands upstream; the next 2.5s cursor poll must append only it.
    transcriptStore.set("#fleet", [...transcriptStore.get("#fleet")!, mkMsg(3, "#fleet")]);
    await flush(2500);
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    const cursorFetch = mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript").at(-1);
    expect(cursorFetch?.[1]).toEqual({ target: "#fleet", sinceId: 2 });

    // Switching rooms replaces the visible messages with T's (not a union with #fleet's).
    rerender({ target: "T" });
    await flush();
    expect(result.current.messages.map((m) => m.id)).toEqual([50]);
    const switchFetch = mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_transcript").at(-1);
    expect(switchFetch?.[1]).toEqual({ target: "T", sinceId: null });
  });

  it("test 5: needsHuman is replaced (not unioned) on each rooms poll — a row present in poll N is gone once poll N+1's payload omits it", async () => {
    vi.useFakeTimers();
    roomsResponse.needsHuman = [mkNeedsHumanRow(100)];
    const { result } = renderHook(() => useCommsPoll(false, null));
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
    const { result } = renderHook(() => useCommsPoll(false, null));
    await flush();
    expect(result.current.schemaOk).toBe(false);
    expect(result.current.schemaVersion).toBe(2);
    expect(result.current.loaded).toBe(true);
  });

  it("keeps the last good rooms data and surfaces a dim error string when a poll fails", async () => {
    vi.useFakeTimers();
    roomsResponse.rooms = [mkRoom({ target: "#fleet", latestId: 1 })];
    const { result } = renderHook(() => useCommsPoll(false, null));
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
