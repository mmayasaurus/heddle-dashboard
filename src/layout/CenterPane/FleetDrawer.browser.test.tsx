import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("../../ipc/transport", () => ({ invoke, isTauri: true }));
vi.mock("../../i18n", () => ({
  useT: () => (key: string, pct?: number) => ({
    "fleet.loggedOut": "logged out — /login needed",
    "fleet.keeperEstimate": "window live (keeper est.) — % appears after the first render on this account",
    "fleet.loginUnknown": "login state unknown",
    "fleet.rotateAccounts": "Rotate Claude accounts",
    "fleet.fableWeekly": `Fable ≈${pct}% of weekly (est.)`,
    "fleet.fableWeeklyExact": `Fable ≈${pct}% of weekly`,
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
    const accountDetail = document.querySelector(".fleet-provcap-account-detail");
    expect(accountDetail).toBeTruthy();
    const rowCount = accountDetail!.querySelectorAll(":scope > .fleet-provcap-account-row").length;
    expect(rowCount).toBe(6);
    expect(screen.queryByText("acct1")).toBeNull();
    expect(screen.queryByText("acct2")).toBeNull();
    expect(screen.getByText("3/3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rotate Claude accounts" }));
    expect(screen.getByText("acct1")).toBeTruthy();
    expect(screen.getByText("logged out — /login needed")).toBeTruthy();
    expect(screen.queryByText("acct3")).toBeNull();
    expect(accountDetail!.querySelectorAll(":scope > .fleet-provcap-account-row")).toHaveLength(rowCount);

    fireEvent.click(screen.getByRole("button", { name: "Rotate Claude accounts" }));
    expect(screen.getByText("acct2")).toBeTruthy();
    expect(screen.getByText("window live (keeper est.) — % appears after the first render on this account")).toBeTruthy();
    expect(accountDetail!.querySelectorAll(":scope > .fleet-provcap-account-row")).toHaveLength(rowCount);

    fireEvent.click(screen.getByRole("button", { name: "Rotate Claude accounts" }));
    expect(screen.getByText("acct3")).toBeTruthy();
    expect(accountDetail!.querySelectorAll(":scope > .fleet-provcap-account-row")).toHaveLength(rowCount);
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

    await waitFor(() => expect(screen.getByText("Fable ≈37% of weekly (est.)")).toBeTruthy());
    const row = document.querySelector(".fleet-provcap-fable-weekly");
    expect(row?.getAttribute("title")).toBe("Fable 37% · other 8% · unknown 2% · 4 samples");
    expect(row?.querySelector(".fleet-seg-soft-cap")).toBeTruthy();
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

    await waitFor(() => expect(screen.getByText("Fable ≈50% of weekly")).toBeTruthy());
    expect(screen.queryByText("Fable ≈50% of weekly (est.)")).toBeNull();
  });
});
