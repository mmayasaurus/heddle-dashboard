//! Behavioral tests for the operator write-path status poll (HED-74c), using fake timers exactly
//! like useCommsPoll.test.ts. `invoke`/`isTauri` are mocked so these tests have zero dependency on
//! the parallel Rust worker building the actual heddle_comms_* commands.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../ipc/transport";
import { t } from "../../../i18n";
import { operatorHint, useOperatorStatus, type OperatorStatusReason } from "./useOperatorStatus";

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
