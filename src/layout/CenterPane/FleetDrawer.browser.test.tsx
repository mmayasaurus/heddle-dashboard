import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("../../ipc/transport", () => ({ invoke, isTauri: true }));
vi.mock("../../i18n", () => ({
  useT: () => (key: string, ...args: number[]) => ({
    "fleet.loggedOut": "logged out — /login needed",
    "fleet.keeperEstimate": "window live (keeper est.) — % appears after the first render on this account",
    "fleet.loginUnknown": "login state unknown",
    "fleet.rotateAccounts": "Rotate Claude accounts",
    "fleet.capturedMinutesAgo": `captured ${args[0]} min ago`,
    "fleet.fableWeekly": `Fable ≈${args[0]}% of weekly (est.)`,
    "fleet.fableWeeklyExact": `Fable ${args[0]}% of weekly`,
    "fleet.fableWeeklyEstMark": "estimate",
    "fleet.fableWeeklyBreakdown": `breakdown: ${args[0]}/${args[1]}/${args[2]} (${args[3]})`,
  }[key] ?? key),
}));
vi.mock("../../store/termStore", () => ({
  useTermStore: (selector: (state: object) => unknown) => selector({
    activeSessionId: null,
    sessions: [],
    ephemeralSessions: {},
    projects: [],
  }),
}));

import { FleetDrawer } from "./FleetDrawer";

const now = Math.floor(Date.now() / 1000);
const testFileUrl = new URL(import.meta.url);
const testFilePath = fileURLToPath(testFileUrl.protocol === "file:" ? testFileUrl : new URL(`file://${testFileUrl.pathname}`));
const vlinxCss = readFileSync(path.resolve(path.dirname(testFilePath), "../../styles/vlinx.css"), "utf8");
const claude = {
  provider: "claude",
  model: "claude · 3 acct",
  capturedAt: now,
  fiveHour: { usedPercentage: 20, resetsAt: now + 3600 },
  sevenDay: { usedPercentage: 10, resetsAt: now + 86_400 },
  activeAccount: "acct3",
  accounts: [
    { id: "acct1", label: "one@example.com", loggedIn: false, fiveHour: {}, sevenDay: {} },
    { id: "acct2", label: "two@example.com", loggedIn: true, fiveHour: { usedPercentage: null, resetsAt: now + 3600 }, sevenDay: {} },
    { id: "acct3", label: "three@example.com", loggedIn: true, fiveHour: { usedPercentage: 20, resetsAt: now + 3600 }, sevenDay: { usedPercentage: 10, resetsAt: now + 86_400 } },
  ],
};

function accountRowCount(accountId: string) {
  const accountDetail = screen.getByText(accountId).closest(".fleet-provcap-account-detail");
  expect(accountDetail).toBeTruthy();
  return Array.from(accountDetail!.children).filter((child) =>
    child.classList.contains("fleet-provcap-account-row"),
  ).length;
}

describe("FleetDrawer Claude account cycler", () => {
  beforeEach(() => {
    localStorage.setItem("heddle-fleet-open", "1");
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([claude]);
      if (command === "heddle_fleet_roster" || command === "heddle_recent" || command === "heddle_provider_usage") return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it("shows one account at a time and rotates through logged-out and keeper-estimate states", async () => {
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("acct3")).toBeTruthy());
    const rowCount = accountRowCount("acct3");
    expect(rowCount).toBe(6);
    expect(screen.queryByText("acct1")).toBeNull();
    expect(screen.queryByText("acct2")).toBeNull();
    expect(screen.getByText("3/3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rotate Claude accounts" }));
    expect(screen.getByText("acct1")).toBeTruthy();
    expect(screen.getByText("logged out — /login needed")).toBeTruthy();
    expect(screen.queryByText("acct3")).toBeNull();
    expect(accountRowCount("acct1")).toBe(rowCount);

    fireEvent.click(screen.getByRole("button", { name: "Rotate Claude accounts" }));
    expect(screen.getByText("acct2")).toBeTruthy();
    expect(screen.getByText("window live (keeper est.) — % appears after the first render on this account")).toBeTruthy();
    expect(accountRowCount("acct2")).toBe(rowCount);

    fireEvent.click(screen.getByRole("button", { name: "Rotate Claude accounts" }));
    expect(screen.getByText("acct3")).toBeTruthy();
    expect(accountRowCount("acct3")).toBe(rowCount);
  });

  it("renders a single Claude account detail without a rotate control or duplicate cap lines", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...claude,
        model: "claude · 1 acct",
        accounts: [claude.accounts[2]],
        activeAccount: "acct3",
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("acct3")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Rotate Claude accounts" })).toBeNull();
    expect(screen.queryByText("1/1")).toBeNull();
    expect(screen.getAllByText("5h")).toHaveLength(1);
  });

  it("shows unknown login state without a keeper estimate", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...claude,
        accounts: [{ ...claude.accounts[1], loggedIn: null }],
        activeAccount: "acct2",
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("login state unknown")).toBeTruthy());
    expect(screen.queryByText("window live (keeper est.) — % appears after the first render on this account")).toBeNull();
  });

  it("reserves an empty Fable weekly row when its estimate is unavailable", async () => {
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("acct3")).toBeTruthy());
    const row = document.querySelector(".fleet-provcap-fable-weekly");
    expect(row).toBeTruthy();
    expect(row!.classList.contains("fleet-provcap-spacer")).toBe(true);
    expect(screen.queryByText(/Fable/)).toBeNull();
  });

  it("renders an estimated Fable weekly bar with its breakdown tooltip", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...claude,
        accounts: [{
          ...claude.accounts[2],
          fableWeeklyEstimatePct: 37,
          detail: { fableWeekly: { fablePct: 37, otherPct: 8, unknownPct: 2, samples: 4, exact: false } },
        }],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(document.querySelector(".fleet-provcap-fable-label")?.getAttribute("title")).toBe("Fable ≈37% of weekly (est.)"));
    const row = document.querySelector(".fleet-provcap-fable-weekly");
    expect(row?.getAttribute("title")).toBe("breakdown: 37/8/2 (4)");
    expect(row?.querySelector(".fleet-seg-soft-cap")).toBeTruthy();
    expect(row?.querySelector(".fleet-capline-reset")?.textContent).toBe("estimate");
  });

  it("keeps provider cap bars free of inline widths under one fixed CSS rule", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...claude,
        accounts: [{
          ...claude.accounts[2],
          fableWeeklyEstimatePct: 37,
        }],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(document.querySelectorAll(".fleet-capline .fleet-seg").length).toBe(3));
    document.querySelectorAll(".fleet-capline .fleet-seg").forEach((bar) => {
      expect(bar.getAttribute("style")).not.toMatch(/(?:^|;)\s*width\s*:/);
    });
    expect(vlinxCss.match(/\.fleet-capline > \.fleet-seg\s*\{[^}]*\bwidth:\s*140px;/g)).toHaveLength(1);
  });

  it("drops the estimate suffix for an exact Fable weekly value", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...claude,
        accounts: [{
          ...claude.accounts[2],
          fableWeeklyEstimatePct: 50,
          detail: { fableWeekly: { fablePct: 50, otherPct: 0, unknownPct: 0, samples: 1, exact: true } },
        }],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(document.querySelector(".fleet-provcap-fable-label")?.getAttribute("title")).toBe("Fable 50% of weekly"));
    expect(document.querySelector(".fleet-provcap-fable-label")?.getAttribute("title")).not.toBe("Fable ≈50% of weekly (est.)");
    expect(document.querySelector(".fleet-provcap-fable-weekly .fleet-capline-reset")?.textContent).toBe("");
  });

  it("uses the legacy fallback timestamp for the matching Claude account", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...claude,
        accounts: [{ ...claude.accounts[2], capturedAt: null }],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("acct3")).toBeTruthy());
    expect(screen.getByText(/captured \d+ min ago/)).toBeTruthy();
  });
});

describe("FleetDrawer roster model chips", () => {
  const baseAgent = {
    pid: 111,
    sessionId: "sess-1",
    cwd: "/Users/x/project",
    status: "idle",
    kind: "claude",
    updatedAtMs: Date.now(),
    alive: true,
    workers: [],
  };

  beforeEach(() => {
    localStorage.setItem("heddle-fleet-open", "1");
  });

  it("renders a model chip between the agent name and status word", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_fleet_roster") {
        return Promise.resolve([{ ...baseAgent, name: "r", model: "claude-opus-4-8" }]);
      }
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("r")).toBeTruthy());
    const row = document.querySelector(".fleet-agent-row");
    expect(row).toBeTruthy();
    const classAt = (selector: string) =>
      Array.from(row!.children).findIndex((el) => el.classList.contains(selector));
    expect(classAt("fleet-agent-model")).toBeGreaterThan(classAt("fleet-agent-name"));
    expect(classAt("fleet-agent-status")).toBeGreaterThan(classAt("fleet-agent-model"));
    expect(document.querySelector(".fleet-agent-model")?.textContent).toBe("opus 4.8");
  });

  it("renders no chip node when the agent has no model", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_fleet_roster") {
        return Promise.resolve([{ ...baseAgent, name: "s", model: null }]);
      }
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("s")).toBeTruthy());
    expect(document.querySelector(".fleet-agent-model")).toBeNull();
  });

  it("carries the full model id in the row tooltip", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_fleet_roster") {
        return Promise.resolve([{ ...baseAgent, name: "t", model: "claude-opus-4-8" }]);
      }
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("t")).toBeTruthy());
    expect(document.querySelector(".fleet-agent-row")?.getAttribute("title")).toContain("claude-opus-4-8");
  });
});
