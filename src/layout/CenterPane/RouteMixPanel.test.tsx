//! RouteMixPanel (HED-69) behavioral tests. Regressions each would catch, per TESTING-BAR.md:
//! wrong bucket rendering, a cap chip that shows the previous hour's movement after a rollover,
//! a baseline lost when the drawer closes, a reset rendered as negative usage or measured against
//! the invalidated pre-reset baseline, a chip hidden because the current hour had no dispatches,
//! and an empty-state flash before the first load. Time is faked so hour-boundary behavior is
//! deterministic (no real-clock flake at :59).

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../ipc/transport", () => ({ invoke, isTauri: true }));
vi.mock("../../i18n", () => ({
  // Key + interpolated args, so assertions pin BOTH the key and the numbers users would see.
  useT: () => (key: string, ...args: unknown[]) =>
    args.length ? `${key}:${args.join(",")}` : key,
}));

import {
  deriveCapDelta,
  foldCapSample,
  resetCapStoreForTest,
  RouteMixPanel,
  type CapSamples,
} from "./RouteMixPanel";

// Fixed clock: 2026-08-16T02:20:00Z — current UTC hour bucket is "2026-08-16T02".
const T0 = Date.parse("2026-08-16T02:20:00.000Z");
const NOW_HOUR = "2026-08-16T02";

function mixFixture() {
  return {
    windowHours: 6,
    hours: [
      {
        hour: "2026-08-16T01",
        providers: [
          { provider: "codex", dispatches: 2, inputTokens: 150_000, outputTokens: 10_000 },
          { provider: "gemini", dispatches: 1, inputTokens: 0, outputTokens: 7_000 },
        ],
      },
      {
        hour: NOW_HOUR,
        providers: [{ provider: "cursor", dispatches: 1, inputTokens: 500, outputTokens: 500 }],
      },
    ],
    orchestrators: [
      { orchestrator: "R", dispatches: 12, succeeded: 12 },
      { orchestrator: "T", dispatches: 5, succeeded: 4 },
    ],
  };
}

describe("RouteMixPanel — route-mix scoreboard (HED-69)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0);
    resetCapStoreForTest();
    invoke.mockReset();
    invoke.mockResolvedValue(mixFixture());
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders per-hour provider token totals (input+output summed) and orchestrator counts", async () => {
    render(<RouteMixPanel claudeFiveHourPct={null} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("heddle_route_mix", { hours: 6 }));
    expect(await screen.findByText("codex 160.0k")).toBeTruthy();
    expect(screen.getByText("gemini 7.0k")).toBeTruthy();
    expect(screen.getByText("cursor 1.0k")).toBeTruthy();
    expect(screen.getByText("R×12")).toBeTruthy();
    expect(screen.getByText("T×5 (4✓)")).toBeTruthy();
  });

  it("never flashes the empty state before the first load, then shows it honestly", async () => {
    invoke.mockReturnValue(new Promise(() => undefined)); // a load that never settles
    const pending = render(<RouteMixPanel claudeFiveHourPct={null} />);
    // Pending load: no empty-state claim about a ledger nobody has read yet.
    expect(screen.queryByText("fleet.routeMix.empty")).toBeNull();
    pending.unmount();
    invoke.mockResolvedValue({ windowHours: 6, hours: [], orchestrators: [] });
    render(<RouteMixPanel claudeFiveHourPct={null} />);
    expect(await screen.findByText("fleet.routeMix.empty")).toBeTruthy();
  });

  it("shows the cap chip on its own current-hour row even when the hour has no dispatch bucket", async () => {
    invoke.mockResolvedValue({ windowHours: 6, hours: [], orchestrators: [] });
    const { rerender } = render(<RouteMixPanel claudeFiveHourPct={70} />);
    await screen.findByText("fleet.routeMix.empty");
    act(() => {
      rerender(<RouteMixPanel claudeFiveHourPct={73} />);
    });
    // "Cap moved, nothing dispatched" — the failure-to-delegate signal must stay visible.
    expect(screen.getByText("fleet.routeMix.capDelta:3")).toBeTruthy();
  });

  it("cap chip: pending on one sample, +0 when flat, delta on movement, ↻-anchored after a reset", async () => {
    const { rerender } = render(<RouteMixPanel claudeFiveHourPct={70} />);
    await screen.findByText("cursor 1.0k");
    expect(screen.getByText("fleet.routeMix.capPending")).toBeTruthy();
    // Flat hour: the next poll tick folds the UNCHANGED percentage (React never re-fires the prop
    // effect on identical values) — sampling works, usage is genuinely zero, so +0, not "pending".
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(screen.getByText("fleet.routeMix.capDelta:0")).toBeTruthy();
    act(() => {
      rerender(<RouteMixPanel claudeFiveHourPct={72.5} />);
    });
    expect(screen.getByText("fleet.routeMix.capDelta:2.5")).toBeTruthy();
    // Window reset: ↻ marker, then movement measured from the POST-reset baseline (3 → 5 = +2),
    // never against the invalidated 70/72.5.
    act(() => {
      rerender(<RouteMixPanel claudeFiveHourPct={3} />);
    });
    expect(screen.getByText("fleet.routeMix.capReset")).toBeTruthy();
    act(() => {
      rerender(<RouteMixPanel claudeFiveHourPct={5} />);
    });
    expect(screen.getByText("fleet.routeMix.capDeltaAfterReset:2")).toBeTruthy();
    expect(screen.queryByText(/capDelta:-/)).toBeNull();
  });

  it("an hour rollover returns the chip to pending instead of showing the previous hour's movement", async () => {
    const { rerender } = render(<RouteMixPanel claudeFiveHourPct={70} />);
    await screen.findByText("cursor 1.0k");
    act(() => {
      rerender(<RouteMixPanel claudeFiveHourPct={74} />);
    });
    expect(screen.getByText("fleet.routeMix.capDelta:4")).toBeTruthy();
    // Cross into 03:xx; the percentage has NOT changed — the poll tick re-renders the panel.
    await act(async () => {
      vi.setSystemTime(Date.parse("2026-08-16T03:01:00.000Z"));
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(screen.getByText("fleet.routeMix.capPending")).toBeTruthy();
    expect(screen.queryByText("fleet.routeMix.capDelta:4")).toBeNull();
  });

  it("the in-hour baseline survives a drawer close/reopen (unmount/remount)", async () => {
    const first = render(<RouteMixPanel claudeFiveHourPct={70} />);
    await first.findByText("cursor 1.0k");
    first.unmount();
    render(<RouteMixPanel claudeFiveHourPct={76} />);
    // Same UTC hour: the module store kept the 70 baseline, so this is +6, not pending.
    expect(await screen.findByText("fleet.routeMix.capDelta:6")).toBeTruthy();
  });
});

describe("foldCapSample / deriveCapDelta — the cap-delta arithmetic", () => {
  const at = (iso: string) => Date.parse(iso);
  const fold = (s: CapSamples | null, pct: number | null, iso: string) =>
    foldCapSample(s, pct, at(iso));

  it("derives pending for a store from another hour — rollover can never leak a stale delta", () => {
    let s = fold(null, 70, "2026-08-16T03:10:00.000Z");
    s = fold(s, 74, "2026-08-16T03:20:00.000Z");
    expect(deriveCapDelta(s, "2026-08-16T03")).toEqual({ kind: "delta", points: 4, afterReset: false });
    expect(deriveCapDelta(s, "2026-08-16T04")).toEqual({ kind: "pending" });
  });

  it("a new hour restarts the baseline; a null sample changes nothing", () => {
    let s = fold(null, 70, "2026-08-16T03:10:00.000Z");
    s = fold(s, 75, "2026-08-16T04:00:30.000Z");
    expect(deriveCapDelta(s, "2026-08-16T04")).toEqual({ kind: "pending" });
    const before = s;
    s = fold(s, null, "2026-08-16T04:01:00.000Z");
    expect(s).toBe(before);
  });

  it("a drop re-anchors: reset first, then post-reset movement flagged afterReset", () => {
    let s = fold(null, 90, "2026-08-16T03:10:00.000Z");
    s = fold(s, 5, "2026-08-16T03:20:00.000Z");
    expect(deriveCapDelta(s, "2026-08-16T03")).toEqual({ kind: "reset" });
    s = fold(s, 9, "2026-08-16T03:30:00.000Z");
    expect(deriveCapDelta(s, "2026-08-16T03")).toEqual({ kind: "delta", points: 4, afterReset: true });
  });
});

describe("RouteMixPanel — malformed payloads must not take the drawer down", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0);
    resetCapStoreForTest();
    invoke.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // This panel renders inside FleetDrawer: a throw here unmounts the WHOLE drawer, taking the
  // roster, caps and dispatch list with it. Regression caught for real — FleetDrawer's browser
  // test resolves unknown commands to [], and `[].hours.map` crashed the drawer.
  it.each([
    ["an array (a catch-all mock or an older backend)", [] as unknown],
    ["null", null as unknown],
    ["an object with no hours key", { windowHours: 6 } as unknown],
  ])("renders the honest empty state instead of throwing for %s", async (_label, payload) => {
    invoke.mockResolvedValue(payload);
    render(<RouteMixPanel claudeFiveHourPct={null} />);
    // Reaching the empty state at all proves the component mounted and survived the payload.
    expect(await screen.findByText("fleet.routeMix.empty")).toBeTruthy();
  });

  it("drops malformed buckets and still renders the good ones", async () => {
    invoke.mockResolvedValue({
      windowHours: 6,
      hours: [
        null, // no bucket at all
        { hour: "2026-08-16T01" }, // missing providers array — would crash .map
        { hour: NOW_HOUR, providers: [{ provider: "codex", dispatches: 1, inputTokens: 900, outputTokens: 100 }] },
      ],
      orchestrators: [null, { orchestrator: "R", dispatches: 2, succeeded: 2 }],
    });
    render(<RouteMixPanel claudeFiveHourPct={null} />);
    // The one well-formed bucket and orchestrator survive; the malformed entries are dropped
    // rather than taking the drawer down with them.
    expect(await screen.findByText("codex 1.0k")).toBeTruthy();
    expect(screen.getByText("R×2")).toBeTruthy();
    expect(screen.queryByText("fleet.routeMix.empty")).toBeNull();
  });
});
