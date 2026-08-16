//! DisciplinePanel (HED-85) behavioral tests. Regressions each would catch: the red flag failing
//! to fire for a live silent agent (the panel's whole purpose), a denied count rendered as usage,
//! a gate-off row rendered as healthy, and legacy vendor counts silently dropped.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../ipc/transport", () => ({ invoke, isTauri: true }));
vi.mock("../../i18n", () => ({
  useT: () => (key: string, ...args: unknown[]) =>
    args.length ? `${key}:${args.join(",")}` : key,
}));

import { DisciplinePanel, zeroCallAgents } from "./DisciplinePanel";

function fixture() {
  return {
    windowHours: 24,
    rows: [
      { agent: "S", repoId: "heddle", memtraceCalls: 3, serenaCalls: 1, deniedCalls: 0, gate: true, lastTs: "2026-08-16T00:54:30Z" },
      { agent: "T", repoId: "heddle-dashboard", memtraceCalls: 0, serenaCalls: 0, deniedCalls: 2, gate: false, lastTs: "2026-08-16T00:57:56Z" },
    ],
    legacyUnattributedMemtrace: 41,
  };
}

describe("DisciplinePanel — discipline telemetry (HED-85)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(fixture());
  });
  afterEach(cleanup);

  it("renders usage rows with denied and gate-off states, and the legacy vendor total", async () => {
    render(<DisciplinePanel liveAgents={["S", "T"]} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("heddle_discipline", { hours: 24 }));
    expect(await screen.findByText("memtrace ×3")).toBeTruthy();
    expect(screen.getByText("serena ×1")).toBeTruthy();
    // T's row: denials are denials, never usage; gate off renders as the red state.
    expect(screen.getByText("fleet.discipline.denied:2")).toBeTruthy();
    expect(screen.getByText("fleet.discipline.gateOff")).toBeTruthy();
    expect(screen.getByText("fleet.discipline.legacy:41")).toBeTruthy();
  });

  it("red-flags a LIVE agent with zero memory-layer calls — T has rows but no usage, so it flags", async () => {
    render(<DisciplinePanel liveAgents={["S", "T", "V"]} />);
    // T has rows (denials only, 0 usage) and V has nothing at all: both are red-flagged; S is not.
    expect(await screen.findByText("fleet.discipline.zeroCalls:T")).toBeTruthy();
    expect(screen.getByText("fleet.discipline.zeroCalls:V")).toBeTruthy();
    expect(screen.queryByText("fleet.discipline.zeroCalls:S")).toBeNull();
  });

  it("shows the honest empty state when nothing is recorded and nobody is live", async () => {
    invoke.mockResolvedValue({ windowHours: 24, rows: [], legacyUnattributedMemtrace: 0 });
    render(<DisciplinePanel liveAgents={[]} />);
    expect(await screen.findByText("fleet.discipline.empty")).toBeTruthy();
  });
});

describe("zeroCallAgents — the red-flag decision", () => {
  const row = (agent: string, mt: number, sr: number) => ({
    agent, repoId: "x", memtraceCalls: mt, serenaCalls: sr, deniedCalls: 0, gate: true, lastTs: "t",
  });

  it("flags live agents without usage; denial-only rows do not clear the flag", () => {
    expect(zeroCallAgents(["A", "B"], [row("A", 1, 0)])).toEqual(["B"]);
    expect(zeroCallAgents(["A"], [row("A", 0, 0)])).toEqual(["A"]);
    expect(zeroCallAgents(["A"], [row("A", 0, 2)])).toEqual([]);
    expect(zeroCallAgents([], [])).toEqual([]);
  });
});
