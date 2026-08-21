import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("../../ipc/transport", () => ({ invoke, isTauri: true }));
vi.mock("../../i18n", () => ({
  // Key + interpolated args, so assertions pin BOTH the key and the numbers users would see —
  // a static English dictionary here would mask a real i18n key mismatch in the component.
  useT: () => (key: string, ...args: unknown[]) =>
    args.length ? `${key}:${args.join(",")}` : key,
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

function accountDetailElement(accountId: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(".fleet-provcap-account-label"))
    .find((element) => element.textContent === accountId) ?? null;
}

function accountRowCount(accountId: string) {
  const accountDetail = accountDetailElement(accountId)?.closest(".fleet-provcap-account-detail");
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

    await waitFor(() => expect(accountDetailElement("acct3")).toBeTruthy());
    const rowCount = accountRowCount("acct3");
    expect(rowCount).toBe(6);
    expect(screen.queryByText("acct1")).toBeNull();
    expect(screen.queryByText("acct2")).toBeNull();
    expect(screen.getByText("3/3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "fleet.rotateAccounts" }));
    await waitFor(() => expect(screen.getByText("acct1")).toBeTruthy());
    expect(screen.getByText("fleet.loggedOut")).toBeTruthy();
    expect(accountDetailElement("acct3")).toBeNull();
    expect(accountRowCount("acct1")).toBe(rowCount);

    fireEvent.click(screen.getByRole("button", { name: "fleet.rotateAccounts" }));
    await waitFor(() => expect(screen.getByText("acct2")).toBeTruthy());
    expect(screen.getByText("fleet.keeperEstimate")).toBeTruthy();
    expect(accountRowCount("acct2")).toBe(rowCount);

    fireEvent.click(screen.getByRole("button", { name: "fleet.rotateAccounts" }));
    await waitFor(() => expect(accountDetailElement("acct3")).toBeTruthy());
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

    await waitFor(() => expect(accountDetailElement("acct3")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "fleet.rotateAccounts" })).toBeNull();
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

    await waitFor(() => expect(screen.getByText("fleet.loginUnknown")).toBeTruthy());
    expect(screen.queryByText("fleet.keeperEstimate")).toBeNull();
  });

  it("reserves an empty Fable weekly row when its estimate is unavailable", async () => {
    render(<FleetDrawer />);

    await waitFor(() => expect(accountDetailElement("acct3")).toBeTruthy());
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

    await waitFor(() => expect(document.querySelector(".fleet-provcap-fable-label")?.getAttribute("title")).toBe("fleet.fableWeekly:37"));
    const row = document.querySelector(".fleet-provcap-fable-weekly");
    expect(row?.getAttribute("title")).toBe("fleet.fableWeeklyBreakdown:37,8,2,4");
    expect(row?.querySelector(".fleet-seg-soft-cap")).toBeTruthy();
    expect(row?.querySelector(".fleet-capline-reset")?.textContent).toBe("fleet.fableWeeklyEstMark");
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

    await waitFor(() => expect(document.querySelector(".fleet-provcap-fable-label")?.getAttribute("title")).toBe("fleet.fableWeeklyExact:50"));
    expect(document.querySelector(".fleet-provcap-fable-label")?.getAttribute("title")).not.toBe("fleet.fableWeekly:50");
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

    await waitFor(() => expect(accountDetailElement("acct3")).toBeTruthy());
    expect(screen.getByText(/fleet\.capturedMinutesAgo:\d+/)).toBeTruthy();
  });
});

// Real cursor payload shape (src-tauri/src/heddle_stats/cursor.rs + tests/fixtures/heddle_stats/
// limits.golden.json): both rolling windows are always null for cursor — it has no 5h/7d notion —
// while the three named pools (included-total / included-api / usage-based) carry the real numbers.
const cursorWindows = [
  { id: "included-total", label: "included total (Auto / Cursor models)", usedPercentage: 17.34, resetsAt: now + 86_400 * 5, usedAmount: null, limitAmount: null, unit: null },
  { id: "included-api", label: "included API (named 3rd-party models)", usedPercentage: 86.69, resetsAt: now + 86_400 * 5, usedAmount: 400, limitAmount: 400, unit: "usd" },
  { id: "usage-based", label: "on-demand (usage-based)", usedPercentage: 0, resetsAt: now + 86_400 * 5, usedAmount: 0, limitAmount: 100, unit: "usd" },
];
const cursor = {
  provider: "cursor",
  model: "cursor.com",
  capturedAt: now,
  fiveHour: { usedPercentage: null, resetsAt: null },
  sevenDay: { usedPercentage: null, resetsAt: null },
  windows: cursorWindows,
};

describe("FleetDrawer real-windows promotion (cursor)", () => {
  it("renders a null-pct named window as an indeterminate dash with its amount and reset kept (grafted #51 regression)", async () => {
    const offWindows = [
      { id: "included-total", label: "included total (Auto / Cursor models)", usedPercentage: 17.3, resetsAt: now + 864_000, usedAmount: null, limitAmount: null, unit: null },
      { id: "usage-based", label: "on-demand (usage-based)", usedPercentage: null, resetsAt: now + 864_000, usedAmount: 0, limitAmount: 100, unit: "usd" },
    ];
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        provider: "cursor", model: "cursor.com", capturedAt: now, stale: false,
        fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
        windows: offWindows,
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);
    await waitFor(() => expect(screen.getByText("O-D")).toBeTruthy());
    const line = screen.getByText("O-D").closest(".fleet-capline");
    expect(line?.querySelector(".fleet-capline-indeterminate")?.textContent).toBe("—");
    expect(line?.querySelector(".fleet-seg")).toBeNull();
    expect(line?.querySelector(".fleet-capline-reset")?.textContent).toContain("$0.00 / $100.00");
    expect(line?.querySelector(".fleet-capline-reset")?.textContent).toContain("↻");
  });

  beforeEach(() => {
    localStorage.setItem("heddle-fleet-open", "1");
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([cursor]);
      return Promise.resolve([]);
    });
  });

  it("promotes real windows to primary CapLines instead of empty 5h/7d bars, with no duplicate text list", async () => {
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("INCL")).toBeTruthy());
    expect(screen.getByText("API")).toBeTruthy();
    expect(screen.getByText("O-D")).toBeTruthy();
    expect(screen.queryByText("5h")).toBeNull();
    expect(screen.queryByText("7d")).toBeNull();

    // three promoted CapLines, each with its own SegBar — same anatomy as 5h/7d
    expect(document.querySelectorAll(".fleet-capline").length).toBe(3);
    expect(document.querySelectorAll(".fleet-capline .fleet-seg").length).toBe(3);

    // the old text-only extras list must not also render these windows
    expect(document.querySelectorAll(".fleet-provcap-window").length).toBe(0);
    expect(screen.queryByText("included total (Auto / Cursor models)")).toBeNull();
    expect(screen.queryByText("included API (named 3rd-party models)")).toBeNull();

    // full label + amounts move to the title tooltip
    expect(screen.getByText("INCL").getAttribute("title")).toBe("included total (Auto / Cursor models)");
    expect(screen.getByText("API").getAttribute("title")).toBe("included API (named 3rd-party models) — $400.00 of $400.00");
    expect(screen.getByText("O-D").getAttribute("title")).toBe("on-demand (usage-based) — $0.00 of $100.00");
  });

  it("falls through to standard 5h/7d rendering when named windows exist but none carry usable data (failed/disabled fetch)", async () => {
    const allNullWindows = cursorWindows.map((win) => ({ ...win, usedPercentage: null, resetsAt: null }));
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{ ...cursor, windows: allNullWindows }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("5h")).toBeTruthy());
    expect(screen.getByText("7d")).toBeTruthy();
    expect(screen.queryByText("INCL")).toBeNull();
    expect(screen.queryByText("API")).toBeNull();
    expect(screen.queryByText("O-D")).toBeNull();
    // only the standard pair renders — no empty promoted bars, no leftover extras wrapper
    expect(document.querySelectorAll(".fleet-capline").length).toBe(2);
    expect(document.querySelector(".fleet-provcap-extras")).toBeNull();

    // HED-209: a null-pct rolling window renders the indeterminate dash, never a 0%-filled SegBar
    // (which is visually indistinguishable from a real 0%). Both 5h/7d here are null.
    document.querySelectorAll(".fleet-capline").forEach((line) => {
      expect(line.querySelector(".fleet-capline-indeterminate")?.textContent).toBe("—");
      expect(line.querySelector(".fleet-seg")).toBeNull();
    });
  });

  it("shows the reset clock (not 'no active window') for a null-pct window that still has a live resetsAt — HED-209 keeper-estimate coherence", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...cursor,
        fiveHour: { usedPercentage: null, resetsAt: now + 3600 },
        sevenDay: { usedPercentage: null, resetsAt: now + 86_400 },
        windows: [],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("5h")).toBeTruthy());
    const fiveHourLine = screen.getByText("5h").closest(".fleet-capline");
    // null pct → dash, never a SegBar
    expect(fiveHourLine?.querySelector(".fleet-capline-indeterminate")?.textContent).toBe("—");
    expect(fiveHourLine?.querySelector(".fleet-seg")).toBeNull();
    // ...but the window is live (resetsAt in the future) → show its reset clock, not "no active window"
    const reset = fiveHourLine?.querySelector(".fleet-capline-reset");
    expect(reset?.textContent).toContain("↻");
    expect(reset?.textContent).not.toContain("fleet.noActiveWindow");
  });

  it("shows 'no active window' (not ↻ resetting) for a null-pct window whose resetsAt has EXPIRED — HED-209/qodo", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...cursor,
        fiveHour: { usedPercentage: null, resetsAt: now - 3600 },
        sevenDay: { usedPercentage: null, resetsAt: now - 86_400 },
        windows: [],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("5h")).toBeTruthy());
    const fiveHourLine = screen.getByText("5h").closest(".fleet-capline");
    // null pct still renders the dash, never a SegBar
    expect(fiveHourLine?.querySelector(".fleet-capline-indeterminate")?.textContent).toBe("—");
    // an EXPIRED resetsAt on a no-measurement window is stale, not active → "no active window", no ↻
    const reset = fiveHourLine?.querySelector(".fleet-capline-reset");
    expect(reset?.textContent).toBe("fleet.noActiveWindow");
    expect(reset?.textContent).not.toContain("↻");
  });

  it("renders a real 0% as a SegBar and '0%' text, never the dash — 0% is a measurement (HED-209 guard)", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...cursor,
        fiveHour: { usedPercentage: 0, resetsAt: now + 3600 },
        sevenDay: { usedPercentage: null, resetsAt: null },
        windows: [],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("5h")).toBeTruthy());
    const fiveHourLine = screen.getByText("5h").closest(".fleet-capline");
    // genuine 0% → a real (empty) SegBar + "0%" text, NOT the indeterminate dash
    expect(fiveHourLine?.querySelector(".fleet-seg")).toBeTruthy();
    expect(fiveHourLine?.querySelector(".fleet-capline-indeterminate")).toBeNull();
    expect(fiveHourLine?.querySelector(".fleet-capline-pct")?.textContent).toBe("0%");
  });

  it("dedupes a short-label collision within the same block by appending a numeric suffix", async () => {
    const colliding = [
      { id: "included-total", label: "included total (Auto / Cursor models)", usedPercentage: 10, resetsAt: now + 3600, usedAmount: null, limitAmount: null, unit: null },
      { id: "included-bonus", label: "Included bonus pool", usedPercentage: 20, resetsAt: now + 3600, usedAmount: null, limitAmount: null, unit: null },
    ];
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{ ...cursor, windows: colliding }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("INCL")).toBeTruthy());
    expect(screen.getByText("INCL2")).toBeTruthy();
  });
});

const codexAccounts = [
  {
    id: "codex-acct-a",
    label: "a@example.com",
    plan: null,
    capturedAt: now,
    stale: false,
    loggedIn: true,
    fiveHour: { usedPercentage: null, resetsAt: null },
    sevenDay: { usedPercentage: null, resetsAt: null },
    windows: [{ id: "extra-1", label: "Bonus pool", usedPercentage: 12, resetsAt: now + 3600 }],
    limitReached: false,
    note: null,
  },
  {
    id: "codex-acct-b",
    label: "b@example.com",
    plan: null,
    capturedAt: now,
    stale: false,
    loggedIn: true,
    fiveHour: { usedPercentage: null, resetsAt: null },
    sevenDay: { usedPercentage: null, resetsAt: null },
    windows: [{ id: "extra-2", label: "Surge credits", usedPercentage: 40, resetsAt: now + 3600 }],
    limitReached: false,
    note: null,
  },
];
const codex = {
  provider: "codex",
  model: "chatgpt · 2 acct",
  capturedAt: now,
  fiveHour: { usedPercentage: null, resetsAt: null },
  sevenDay: { usedPercentage: 5, resetsAt: now + 86_400 },
  activeAccount: "codex-acct-a",
  accounts: codexAccounts,
};

describe("FleetDrawer generalized account cycler (codex)", () => {
  beforeEach(() => {
    localStorage.setItem("heddle-fleet-open", "1");
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([codex]);
      return Promise.resolve([]);
    });
  });

  it("shows the cycler head for a non-Claude provider, rotates accounts, and updates promoted caplines", async () => {
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("codex-acct-a")).toBeTruthy());
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("BONU")).toBeTruthy();
    expect(screen.queryByText("SURG")).toBeNull();

    // the rotate button's aria-label key ("fleet.rotateAccounts") is shared by every provider —
    // AccountCycler calls t() with no provider-specific argument.
    fireEvent.click(screen.getByRole("button", { name: "fleet.rotateAccounts" }));

    expect(screen.getByText("codex-acct-b")).toBeTruthy();
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(screen.getByText("SURG")).toBeTruthy();
    expect(screen.queryByText("BONU")).toBeNull();
    expect(screen.queryByText("codex-acct-a")).toBeNull();
  });

  it("hides the state row and FableWeeklyLine for a non-Claude account with no loggedIn/limitReached signal", async () => {
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("codex-acct-a")).toBeTruthy());
    expect(document.querySelector(".fleet-provcap-account-state")).toBeNull();
    expect(document.querySelector(".fleet-provcap-fable-weekly")).toBeNull();
  });

  it("shows the state row for a non-Claude account that reports loggedIn: false", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...codex,
        accounts: [{ ...codexAccounts[0], loggedIn: false }, codexAccounts[1]],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("codex-acct-a")).toBeTruthy());
    expect(document.querySelector(".fleet-provcap-account-state")).toBeTruthy();
    expect(screen.getByText("fleet.loggedOut")).toBeTruthy();
  });

  it("keeps an account's 5h/7d CapLines and adds its usable named window beneath them instead of dropping it", async () => {
    const acctWithBoth = {
      id: "codex-acct-c",
      label: "c@example.com",
      plan: null,
      capturedAt: now,
      stale: false,
      loggedIn: true,
      fiveHour: { usedPercentage: 33, resetsAt: now + 3600 },
      sevenDay: { usedPercentage: 12, resetsAt: now + 86_400 },
      windows: [{ id: "gpt-5.3-spark", label: "GPT-5.3-Spark", usedPercentage: 61, resetsAt: now + 3600 }],
      limitReached: false,
      note: null,
    };
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...codex,
        accounts: [acctWithBoth, codexAccounts[1]],
        activeAccount: "codex-acct-c",
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("codex-acct-c")).toBeTruthy());
    expect(screen.getByText("5h")).toBeTruthy();
    expect(screen.getByText("7d")).toBeTruthy();
    expect(screen.getByTitle("GPT-5.3-Spark")).toBeTruthy();
    expect(document.querySelectorAll(".fleet-provcap-account-detail .fleet-capline").length).toBe(3);
  });

  it("suppresses an empty 0%-used codex per-model bucket while keeping the account's 5h/7d rows", async () => {
    const emptyBucketAccount = {
      ...codexAccounts[0],
      id: "codex-empty",
      fiveHour: { usedPercentage: 33, resetsAt: now + 3600 },
      sevenDay: { usedPercentage: 12, resetsAt: now + 86_400 },
      windows: [{ id: "gpt-empty", label: "GPT-Empty", usedPercentage: 0, resetsAt: now + 3600 }],
    };
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...codex,
        accounts: [emptyBucketAccount, codexAccounts[1]],
        activeAccount: "codex-empty",
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("codex-empty")).toBeTruthy());
    expect(screen.getByText("5h")).toBeTruthy();
    expect(screen.getByText("7d")).toBeTruthy();
    expect(screen.queryByTitle("GPT-Empty")).toBeNull();
  });

  it("keeps a used codex per-model bucket", async () => {
    const usedBucketAccount = {
      ...codexAccounts[0],
      id: "codex-used",
      fiveHour: { usedPercentage: 33, resetsAt: now + 3600 },
      sevenDay: { usedPercentage: 12, resetsAt: now + 86_400 },
      windows: [{ id: "gpt-used", label: "GPT-Used", usedPercentage: 61, resetsAt: now + 3600 }],
    };
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...codex,
        accounts: [usedBucketAccount, codexAccounts[1]],
        activeAccount: "codex-used",
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("codex-used")).toBeTruthy());
    expect(screen.getByTitle("GPT-Used")).toBeTruthy();
  });

  it("defaults to the first account with usable data, skipping a no-data account, when activeAccount doesn't match", async () => {
    const noData = { ...codexAccounts[0], id: "codex-acct-x", windows: [] };
    const withData = { ...codexAccounts[1], id: "codex-acct-y" };
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        ...codex,
        accounts: [noData, withData],
        activeAccount: null,
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("codex-acct-y")).toBeTruthy());
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(screen.queryByText("codex-acct-x")).toBeNull();
  });
});

describe("FleetDrawer codex empty-bucket suppression is provider-scoped (HED-215)", () => {
  beforeEach(() => {
    localStorage.setItem("heddle-fleet-open", "1");
  });

  it("keeps a non-codex provider's 0% percent-only pools (Gemini 3p windows must still render)", async () => {
    const gemini = {
      provider: "gemini",
      model: null,
      capturedAt: now,
      fiveHour: { usedPercentage: 5, resetsAt: now + 3600 },
      sevenDay: { usedPercentage: 10, resetsAt: now + 86_400 },
      windows: [
        { id: "3p-weekly", label: "Claude and GPT models 7d", usedPercentage: 0, resetsAt: now + 86_400, usedAmount: null, limitAmount: null, unit: null },
        { id: "3p-5h", label: "Claude and GPT models 5h", usedPercentage: 0, resetsAt: now + 3600, usedAmount: null, limitAmount: null, unit: null },
      ],
    };
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([gemini]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("3P 7d")).toBeTruthy());
    expect(screen.getByText("3P 5h")).toBeTruthy();
  });
});

describe("FleetDrawer generalized account cycler (claude regression)", () => {
  beforeEach(() => {
    localStorage.setItem("heddle-fleet-open", "1");
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([claude]);
      return Promise.resolve([]);
    });
  });

  it("still renders the Claude cycler chrome, FableWeeklyLine, and state row through the shared AccountCycler", async () => {
    render(<FleetDrawer />);

    await waitFor(() => expect(accountDetailElement("acct3")).toBeTruthy());
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "fleet.rotateAccounts" })).toBeTruthy();
    expect(document.querySelector(".fleet-provcap-fable-weekly")).toBeTruthy();
    expect(document.querySelector(".fleet-provcap-account-state")).toBeTruthy();
    expect(screen.getAllByText("5h")).toHaveLength(1);
    expect(screen.getAllByText("7d")).toHaveLength(1);
  });
});

describe("regression PR#213 — collapsed Claude chip uses the max fresh account window", () => {
  const staleCapturedAt = now - 26 * 60 * 60;

  const renderClosedChip = async (limit: object) => {
    localStorage.setItem("heddle-fleet-open", "0");
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([limit]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);
    await waitFor(() => expect(document.querySelector(".fleet-chip-sum")).toBeTruthy());
    return document.querySelector(".fleet-chip-sum")!;
  };

  it("selects the highest representative fresh-account window and clears stale styling", async () => {
    const chip = await renderClosedChip({
      ...claude,
      capturedAt: staleCapturedAt,
      stale: true,
      fiveHour: { usedPercentage: 96, resetsAt: now + 3600 },
      accounts: [
        { ...claude.accounts[0], stale: true },
        { ...claude.accounts[2], fiveHour: { usedPercentage: 19, resetsAt: now + 3600 }, stale: false },
        { ...claude.accounts[2], id: "acct4", fiveHour: { usedPercentage: 13, resetsAt: now + 3600 }, stale: false },
      ],
    });

    expect(chip.textContent).toContain("acct3");
    expect(chip.textContent).toContain("19%");
    expect(chip.classList.contains("stale")).toBe(false);
  });

  it("falls back to the stale top-level value when no Claude account has fresh data", async () => {
    const chip = await renderClosedChip({
      ...claude,
      capturedAt: staleCapturedAt,
      stale: true,
      fiveHour: { usedPercentage: 96, resetsAt: now + 3600 },
      accounts: claude.accounts.map((account) => ({ ...account, stale: true })),
    });

    expect(chip.textContent).toContain("96%");
    expect(chip.textContent).not.toContain("acct3");
    expect(chip.classList.contains("stale")).toBe(true);
  });

  it("leaves non-Claude account providers on their top-level value without an account label", async () => {
    const chip = await renderClosedChip({
      ...codex,
      fiveHour: { usedPercentage: 42, resetsAt: now + 3600 },
    });

    expect(chip.textContent).toContain("42%");
    expect(chip.textContent).not.toContain("codex-acct-a");
    expect(chip.textContent).not.toContain("codex-acct-b");
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

  it("falls back to the last two dash-segments for an unmapped, non-family id", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_fleet_roster") {
        return Promise.resolve([{ ...baseAgent, name: "u", model: "totally-unknown-future-model-x9" }]);
      }
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    expect(document.querySelector(".fleet-agent-model")?.textContent).toBe("model-x9");
  });

  it("never resolves an Object.prototype member for a lookalike model id", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_fleet_roster") {
        return Promise.resolve([{ ...baseAgent, name: "v", model: "constructor" }]);
      }
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("v")).toBeTruthy());
    expect(document.querySelector(".fleet-agent-model")?.textContent).toBe("constructor");
  });

  it("hides the model chip on a dead (struck) agent row", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_fleet_roster") {
        return Promise.resolve([{ ...baseAgent, name: "w", model: "claude-opus-4-8", alive: false }]);
      }
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("w")).toBeTruthy());
    expect(document.querySelector(".fleet-agent-model")).toBeNull();
  });
});

describe("FleetDrawer provider-window regressions", () => {
  beforeEach(() => {
    localStorage.setItem("heddle-fleet-open", "1");
  });

  it("renders Gemini third-party windows with distinct 3P labels instead of Claude labels", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([{
        provider: "gemini",
        model: "gemini",
        capturedAt: now,
        fiveHour: { usedPercentage: 11, resetsAt: now + 3600 },
        sevenDay: { usedPercentage: 22, resetsAt: now + 86_400 },
        windows: [
          { id: "3p-weekly", label: "Claude and GPT models 7d", usedPercentage: 3, resetsAt: now + 86_400 },
          { id: "3p-5h", label: "Claude and GPT models 5h", usedPercentage: 4, resetsAt: now + 3600 },
        ],
      }]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(screen.getByText("3P 7d")).toBeTruthy());
    expect(screen.getByText("3P 5h")).toBeTruthy();
    expect(screen.queryByText("CLAU")).toBeNull();
  });

  it("applies each provider's live staleAfterSecs threshold", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "heddle_provider_limits") return Promise.resolve([
        {
          provider: "aged-provider",
          model: "aged",
          capturedAt: now - 360,
          stale: false,
          staleAfterSecs: 300,
          fiveHour: { usedPercentage: 11, resetsAt: now + 3600 },
          sevenDay: { usedPercentage: 22, resetsAt: now + 86_400 },
        },
        {
          provider: "fresh-provider",
          model: "fresh",
          capturedAt: now - 60,
          stale: true,
          staleAfterSecs: 300,
          fiveHour: { usedPercentage: 11, resetsAt: now + 3600 },
          sevenDay: { usedPercentage: 22, resetsAt: now + 86_400 },
        },
      ]);
      return Promise.resolve([]);
    });
    render(<FleetDrawer />);

    await waitFor(() => expect(document.querySelector('.fleet-provcap-provider[title="aged-provider"]')).toBeTruthy());
    const aged = document.querySelector('.fleet-provcap-provider[title="aged-provider"]')?.closest(".fleet-provcap");
    const fresh = document.querySelector('.fleet-provcap-provider[title="fresh-provider"]')?.closest(".fleet-provcap");
    expect(aged?.classList.contains("stale")).toBe(true);
    expect(fresh?.classList.contains("stale")).toBe(false);
  });
});
