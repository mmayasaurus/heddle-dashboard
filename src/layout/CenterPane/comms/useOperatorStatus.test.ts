//! Behavioral tests for the operator write-path status poll (HED-74c), using fake timers exactly
//! like useCommsPoll.test.ts. `invoke`/`isTauri` are mocked so these tests have zero dependency on
//! the parallel Rust worker building the actual heddle_comms_* commands.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../ipc/transport";
import { t } from "../../../i18n";
import {
  isCommsOperatorResult,
  isOperatorFailure,
  operatorHint,
  parseOperatorResult,
  useOperatorStatus,
  type OperatorStatusReason,
} from "./useOperatorStatus";

vi.mock("../../../ipc/transport", () => ({ invoke: vi.fn(), isTauri: true }));

const mockInvoke = vi.mocked(invoke);

let statusResponse: { available: boolean; revoked: boolean; reason: OperatorStatusReason } | null;
let statusShouldReject: boolean;

beforeEach(() => {
  statusResponse = { available: true, revoked: false, reason: null };
  statusShouldReject = false;
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "heddle_comms_operator_status") {
      return statusShouldReject ? Promise.reject(new Error("boom")) : Promise.resolve(statusResponse);
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

describe("useOperatorStatus", () => {
  it("never calls invoke while not expanded", async () => {
    vi.useFakeTimers();
    renderHook(() => useOperatorStatus(false));
    await flush();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("fetches immediately once expanded and reflects an available response", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOperatorStatus(true));
    await flush();
    expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_operator_status");
    expect(result.current.loaded).toBe(true);
    expect(result.current.available).toBe(true);
    expect(result.current.reason).toBeNull();
  });

  it("polls every 30s while expanded", async () => {
    vi.useFakeTimers();
    renderHook(() => useOperatorStatus(true));
    await flush();
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_operator_status")).toHaveLength(1);

    await flush(30_000);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_operator_status")).toHaveLength(2);

    await flush(30_000);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "heddle_comms_operator_status")).toHaveLength(3);
  });

  it("surfaces a well-formed unavailable response with its reason", async () => {
    statusResponse = { available: false, revoked: false, reason: "no-token" };
    vi.useFakeTimers();
    const { result } = renderHook(() => useOperatorStatus(true));
    await flush();
    expect(result.current.available).toBe(false);
    expect(result.current.reason).toBe("no-token");
  });

  it("surfaces revoked:true from a revoked response", async () => {
    statusResponse = { available: false, revoked: true, reason: "revoked" };
    vi.useFakeTimers();
    const { result } = renderHook(() => useOperatorStatus(true));
    await flush();
    expect(result.current.revoked).toBe(true);
    expect(result.current.reason).toBe("revoked");
  });

  it("a malformed payload falls back to unavailable/no-reason, never throws, and still marks loaded", async () => {
    // @ts-expect-error deliberately malformed for the test
    statusResponse = { available: "yes" };
    vi.useFakeTimers();
    const { result } = renderHook(() => useOperatorStatus(true));
    await flush();
    expect(result.current.available).toBe(false);
    expect(result.current.reason).toBeNull();
    expect(result.current.loaded).toBe(true);
  });

  it("an invoke rejection falls back to unavailable/no-reason, never throws, and still marks loaded", async () => {
    statusShouldReject = true;
    vi.useFakeTimers();
    const { result } = renderHook(() => useOperatorStatus(true));
    await flush();
    expect(result.current.available).toBe(false);
    expect(result.current.reason).toBeNull();
    expect(result.current.loaded).toBe(true);
  });

  it("fails closed on re-expand: a prior 'available' does not survive a collapse (copilot #39)", async () => {
    vi.useFakeTimers();
    statusResponse = { available: true, revoked: false, reason: null };
    const { result, rerender } = renderHook(({ e }) => useOperatorStatus(e), {
      initialProps: { e: true },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.available).toBe(true);
    expect(result.current.loaded).toBe(true);

    // Collapse the pane: availability must drop to fail-closed immediately, so a later re-expand
    // cannot briefly re-enable write affordances on the stale value before the fresh poll lands.
    act(() => rerender({ e: false }));
    expect(result.current.available).toBe(false);
    expect(result.current.loaded).toBe(false);
  });

  it("loaded stays false before the first response settles", () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation(() => new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useOperatorStatus(true));
    expect(result.current.loaded).toBe(false);
    expect(result.current.available).toBe(false);
  });
});

describe("operatorHint", () => {
  it("returns null when there is no reason (available, or not yet known)", () => {
    expect(operatorHint(t, null)).toBeNull();
  });

  it("returns a distinct, non-generic hint for each disabled reason", () => {
    const reasons: Exclude<OperatorStatusReason, null>[] = ["no-binary", "no-token", "revoked", "spawn-failed"];
    const hints = reasons.map((r) => operatorHint(t, r));
    for (const hint of hints) {
      expect(hint).toBeTruthy();
    }
    // Every reason maps to a DIFFERENT hint — never a shared generic string.
    expect(new Set(hints).size).toBe(reasons.length);
  });
});

// HED-196: the composer showed the generic "The broker refused this message." on a message the
// broker had actually LOGGED to the room. Root cause: a room (pull-model) post returns
// {outcome:"logged", code:"room-pull"} with NO `reason` key, and the old validator rejected any
// payload whose `reason` was not null-or-string (undefined failed), collapsing a successful send to
// the error sentinel. Fixtures below are the REAL broker payloads captured under a clean operator
// env (scratchpad repro2/repro3/verify), so this regression cannot silently return.
describe("write-path result shape (HED-196)", () => {
  it("accepts a room post that omits `reason` and treats it as SUCCESS, not a refusal", () => {
    const roomPost = { outcome: "logged", code: "room-pull" }; // real #fleet post payload — no reason key
    expect(isCommsOperatorResult(roomPost)).toBe(true);
    expect(parseOperatorResult(roomPost)).toEqual({ outcome: "logged", code: "room-pull", reason: null });
    // The fix: a logged room post is success — no banner, and the composer clears + the poll surfaces it.
    expect(isOperatorFailure(parseOperatorResult(roomPost))).toBe(false);
  });

  it("normalizes a missing `code` too (not only `reason`)", () => {
    const onlyOutcome = { outcome: "logged" };
    expect(isCommsOperatorResult(onlyOutcome)).toBe(true);
    expect(parseOperatorResult(onlyOutcome)).toEqual({ outcome: "logged", code: null, reason: null });
  });

  it("keeps a broker 'refused' outcome a failure, surfacing its real reason", () => {
    const refused = { outcome: "refused", code: "floor-held", reason: "S holds the floor" };
    expect(isCommsOperatorResult(refused)).toBe(true);
    expect(isOperatorFailure(parseOperatorResult(refused))).toBe(true);
    expect(parseOperatorResult(refused).reason).toBe("S holds the floor");
  });

  it("treats a no-live-session DM (has reason) as success — the message is logged for pull", () => {
    const dm = { outcome: "failed", code: "no-live-session", reason: "R has no live comms session; it can pull the message from the log" };
    expect(isCommsOperatorResult(dm)).toBe(true);
    expect(isOperatorFailure(parseOperatorResult(dm))).toBe(false);
  });

  it("accepts an @all broadcast reply (has a reason string)", () => {
    const bcast = { outcome: "sent", code: "broadcast", reason: "0/10 pushed, 10/10 to inbox" };
    expect(isCommsOperatorResult(bcast)).toBe(true);
    expect(isOperatorFailure(parseOperatorResult(bcast))).toBe(false);
  });

  it("still rejects a present-but-wrong-typed code/reason, falling to the error sentinel", () => {
    expect(isCommsOperatorResult({ outcome: "logged", code: 5 })).toBe(false);
    expect(isCommsOperatorResult({ outcome: "logged", reason: {} })).toBe(false);
    expect(parseOperatorResult({ outcome: "logged", code: 5 })).toEqual({ outcome: "error", code: null, reason: null });
  });

  it("documents the SEPARATE room-management shape gap: success payloads carry no `outcome`", () => {
    // HED-196 discovery (scratchpad repro4b): create_room/join_room/leave_room SUCCESS return
    // {room}/{member}/{removed} with NO `outcome` field — a DIFFERENT shape the shared
    // CommsOperatorResult model does not cover, so isOperatorFailure would flag a *successful* room
    // creation/member change as a failure. The missing-key fix here does NOT address that; wiring the
    // room-management UIs is tracked separately (folds into the HED-166 room-management surface). This
    // test pins the current behavior so that follow-up is deliberate, not an accidental regression.
    expect(isCommsOperatorResult({ room: { name: "#fleet" } })).toBe(false);
    expect(isCommsOperatorResult({ member: { room: "#fleet", address: "T" } })).toBe(false);
    expect(isCommsOperatorResult({ removed: true })).toBe(false);
  });
});
