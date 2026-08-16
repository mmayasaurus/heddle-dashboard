//! RouteMixPanel (HED-69) behavioral tests. Regressions each would catch, per TESTING-BAR.md:
//! wrong bucket rendering (a user reads token totals off the wrong hour), a cap-delta chip that
//! invents movement from a single sample, a reset rendered as negative usage, and orchestrator
//! counts silently dropped.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../ipc/transport", () => ({ invoke, isTauri: true }));
vi.mock("../../i18n", () => ({
  // Key + interpolated args, so assertions pin BOTH the key and the numbers users would see.
  useT: () => (key: string, ...args: unknown[]) =>
    args.length ? `${key}:${args.join(",")}` : key,
}));

import { foldCapSample, RouteMixPanel } from "./RouteMixPanel";

const NOW_HOUR = new Date().toISOString().slice(0, 13);

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
    invoke.mockReset();
    invoke.mockResolvedValue(mixFixture());
  });
  afterEach(cleanup);

  it("renders per-hour provider token totals (input+output summed) and orchestrator counts", async () => {
    render(<RouteMixPanel claudeFiveHourPct={null} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("heddle_route_mix", { hours: 6 }));
    // 150k in + 10k out = 160.0k — the number a user reads off the row.
    expect(await screen.findByText("codex 160.0k")).toBeTruthy();
    expect(screen.getByText("gemini 7.0k")).toBeTruthy();
    expect(screen.getByText("cursor 1.0k")).toBeTruthy();
    // Orchestrator counts: full success shows bare count; partial shows the ✓ split.
    expect(screen.getByText("R×12")).toBeTruthy();
    expect(screen.getByText("T×5 (4✓)")).toBeTruthy();
  });

  it("shows the honest empty state when the ledger window has no dispatches", async () => {
    invoke.mockResolvedValue({ windowHours: 6, hours: [], orchestrators: [] });
    render(<RouteMixPanel claudeFiveHourPct={null} />);
    expect(await screen.findByText("fleet.routeMix.empty")).toBeTruthy();
  });

  it("cap chip stays pending on one sample, shows the delta after movement, and never goes negative on a window reset", async () => {
    const { rerender } = render(<RouteMixPanel claudeFiveHourPct={70} />);
    await screen.findByText("cursor 1.0k");
    // One sample in this hour: no invented movement.
    expect(screen.getByText("fleet.routeMix.capPending")).toBeTruthy();
    // Second sample, +2.5pt in the same hour: delta renders.
    await act(async () => rerender(<RouteMixPanel claudeFiveHourPct={72.5} />));
    expect(screen.getByText("fleet.routeMix.capDelta:2.5")).toBeTruthy();
    // Window reset (percentage drops): reset marker, not a negative delta.
    await act(async () => rerender(<RouteMixPanel claudeFiveHourPct={3} />));
    expect(screen.getByText("fleet.routeMix.capReset")).toBeTruthy();
    expect(screen.queryByText(/capDelta:-/)).toBeNull();
  });
});

describe("foldCapSample — the cap-delta arithmetic", () => {
  const at = (hourIso: string) => Date.parse(`${hourIso}:30:00.000Z`);

  it("one sample in an hour yields no delta; two yield the movement", () => {
    let r = foldCapSample(null, 70, at("2026-08-16T03"));
    expect(r.delta.kind).toBe("none");
    r = foldCapSample(r.samples, 74, at("2026-08-16T03"));
    expect(r.delta).toEqual({ kind: "delta", points: 4 });
  });

  it("an hour rollover starts a fresh baseline instead of carrying yesterday's", () => {
    let r = foldCapSample(null, 70, at("2026-08-16T03"));
    r = foldCapSample(r.samples, 74, at("2026-08-16T03"));
    r = foldCapSample(r.samples, 75, at("2026-08-16T04"));
    expect(r.delta.kind).toBe("none");
    r = foldCapSample(r.samples, 76, at("2026-08-16T04"));
    expect(r.delta).toEqual({ kind: "delta", points: 1 });
  });

  it("a drop within the hour is a reset, and a null sample changes nothing", () => {
    let r = foldCapSample(null, 90, at("2026-08-16T03"));
    r = foldCapSample(r.samples, 5, at("2026-08-16T03"));
    expect(r.delta.kind).toBe("reset");
    const before = r.samples;
    r = foldCapSample(r.samples, null, at("2026-08-16T03"));
    expect(r.samples).toBe(before);
  });
});
