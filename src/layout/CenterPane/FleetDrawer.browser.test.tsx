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

// HED-145: Cursor has no 5h/7d concept at all (both always empty LimitWindow::default() from the
// Rust source) but reports three REAL meters via `windows[]`. The drawer used to render two
// fabricated empty "5h"/"7d" caplines for every non-claude provider and show `windows[]` as
// plain text with no bar. Codex, by contrast, has real 5h/7d and must keep rendering them.
const cursorWindows = [
  {
    id: "included-total",
    label: "included total (Auto / Cursor models)",
    usedPercentage: 17.3376,
    resetsAt: now + 864_000,
    usedAmount: null,
    limitAmount: null,
    unit: null,
  },
  {
    id: "included-api",
    label: "included API (named 3rd-party models)",
    usedPercentage: 86.688,
    resetsAt: now + 864_000,
    usedAmount: 400,
    limitAmount: 400,
    unit: "usd",
  },
  {
    id: "usage-based",
    label: "on-demand (usage-based)",
    usedPercentage: 0,
    resetsAt: now + 864_000,
    usedAmount: 0,
    limitAmount: 100,
    unit: "usd",
  },
];
const cursorAccount = {
  id: "cursor-ide",
  label: "v…@example.com",
  plan: "ultra",
  capturedAt: now,
  stale: false,
  loggedIn: null,
  fiveHour: { usedPercentage: null, resetsAt: null },
  sevenDay: { usedPercentage: null, resetsAt: null },
  windows: cursorWindows,
  limitReached: false,
  note: null,
};
const cursor = {
  provider: "cursor",
  model: "cursor.com · 1 acct",
  capturedAt: now,
  fiveHour: { usedPercentage: null, resetsAt: null },
  sevenDay: { usedPercentage: null, resetsAt: null },
  stale: false,
  windows: cursorWindows,
  accounts: [cursorAccount],
};
const codex = {
  provider: "codex",
  model: "chatgpt · 1 acct",
  capturedAt: now,
  fiveHour: { usedPercentage: 42, resetsAt: now + 3_600 },
  sevenDay: { usedPercentage: 12, resetsAt: now + 86_400 },
  stale: false,
};

describe("FleetDrawer provider cap windows (HED-145)", () => {
  beforeEach(() => {
    localStorage.setItem("heddle-fleet-open", "1");
  });

  it("renders cursor's real meters as bars with no fabricated 5h/7d caplines, while codex keeps its real 5h/7d", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([cursor, codex]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);
    await waitFor(() => expect(screen.getByTitle("cursor")).toBeTruthy());

    const cursorBlock = screen.getByTitle("cursor").closest(".fleet-provcap") as HTMLElement;
    expect(cursorBlock).toBeTruthy();
    const cursorLabels = Array.from(cursorBlock.querySelectorAll(".fleet-capline-lbl")).map((el) => el.textContent);
    expect(cursorLabels).toEqual([
      "included total (Auto / Cursor models)",
      "included API (named 3rd-party models)",
      "on-demand (usage-based)",
    ]);
    // No fabricated "5h"/"7d" caplines — exactly the three real windows, each a real SegBar.
    expect(cursorBlock.querySelectorAll(".fleet-capline").length).toBe(3);
    expect(cursorBlock.querySelectorAll(".fleet-capline .fleet-seg").length).toBe(3);
    const cursorPcts = Array.from(cursorBlock.querySelectorAll(".fleet-capline-pct")).map((el) => el.textContent);
    expect(cursorPcts).toEqual(["17%", "87%", "0%"]);
    const cursorResets = Array.from(cursorBlock.querySelectorAll(".fleet-capline-reset")).map((el) => el.textContent);
    expect(cursorResets[0]).not.toContain("$");
    expect(cursorResets[1]).toContain("$400.00 / $400.00");
    expect(cursorResets[2]).toContain("$0.00 / $100.00");

    // Codex has real 5h/7d — must still render exactly as before (no collateral regression).
    const codexBlock = screen.getByTitle("codex").closest(".fleet-provcap") as HTMLElement;
    expect(codexBlock).toBeTruthy();
    const codexLabels = Array.from(codexBlock.querySelectorAll(".fleet-capline-lbl")).map((el) => el.textContent);
    expect(codexLabels).toEqual(["5h", "7d"]);
    const codexPcts = Array.from(codexBlock.querySelectorAll(".fleet-capline-pct")).map((el) => el.textContent);
    expect(codexPcts).toEqual(["42%", "12%"]);
  });

  it("hides the empty per-account caps bar in the accounts list for a multi-account provider with no 5h/7d windows", async () => {
    const cursorTwoAccounts = {
      ...cursor,
      model: "cursor.com · 2 acct",
      accounts: [cursorAccount, { ...cursorAccount, id: "cursor-agent-keychain", label: "m…@example.org" }],
    };
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([cursorTwoAccounts]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);
    await waitFor(() => expect(screen.getByTitle("cursor")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "2 accounts" }));
    expect(screen.getByText("v…@example.com")).toBeTruthy();
    expect(screen.getByText("m…@example.org")).toBeTruthy();
    expect(document.querySelectorAll(".fleet-provcap-account-caps").length).toBe(0);
  });
});
