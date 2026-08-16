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

  it("never claims 'nothing recorded' beside a positive vendor total", async () => {
    invoke.mockResolvedValue({ windowHours: 24, rows: [], legacyUnattributedMemtrace: 41 });
    render(<DisciplinePanel liveAgents={[]} />);
    expect(await screen.findByText("fleet.discipline.legacy:41")).toBeTruthy();
    expect(screen.queryByText("fleet.discipline.empty")).toBeNull();
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

describe("DisciplinePanel — malformed payloads must not take the drawer down", () => {
  beforeEach(() => {
    invoke.mockReset();
  });
  afterEach(cleanup);

  // This panel renders inside FleetDrawer: a throw here unmounts the WHOLE drawer, losing the
  // roster, caps and dispatch list. Caught for real — FleetDrawer's browser test resolves
  // unknown invoke commands to [], and `[].rows.map` crashed the drawer.
  it.each([
    ["an array (a catch-all mock or an older backend)", [] as unknown],
    ["null", null as unknown],
    ["an object with no rows key", { windowHours: 24 } as unknown],
  ])("renders the honest empty state instead of throwing for %s", async (_label, payload) => {
    invoke.mockResolvedValue(payload);
    render(<DisciplinePanel liveAgents={[]} />);
    expect(await screen.findByText("fleet.discipline.empty")).toBeTruthy();
  });

  it("drops rows missing their counters instead of rendering invented numbers", async () => {
    invoke.mockResolvedValue({
      windowHours: 24,
      rows: [
        null,
        { agent: "S" }, // no counters — coercing these to 0 would render a row of invented data
        { agent: "W", repoId: "heddle", memtraceCalls: 4, serenaCalls: 0, deniedCalls: 0, gate: true, lastTs: "2026-08-16T00:54:30Z" },
      ],
      legacyUnattributedMemtrace: 0,
    });
    render(<DisciplinePanel liveAgents={["W"]} />);
    // The well-formed row survives with its real counters...
    await waitFor(() => expect(screen.getByText("memtrace ×4")).toBeTruthy());
    expect(screen.getByText("W")).toBeTruthy();
    // ...and the malformed one produces NO usage row at all, rather than one reading "S ×0 ×0"
    // built from numbers the backend never sent.
    expect(screen.queryByText("S")).toBeNull();
    expect(screen.queryByText("memtrace ×0")).toBeNull();
    // Note: S having no row still feeds the live-agent red flag, which is HED-85's whole point
    // and is the same path as an agent that genuinely made no calls — see zeroCallAgents.
  });
});
