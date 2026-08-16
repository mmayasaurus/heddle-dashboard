//! Shell + integration tests for the fleet chatroom pane (HED-74b spec items 5 (badge), 8
//! (unread clears), 9 (schema gate), plus collapsed/expanded persistence and the loaded-flag
//! no-flash guarantee). isTauri is mocked true here; the dedicated false-path lives in
//! ChatroomPane.isTauriGate.test.tsx, mirroring this repo's existing
//! ConnectRemotePanel.sshGate.test.tsx naming convention.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../ipc/transport";
import { ChatroomPane } from "./ChatroomPane";
import type { CommsMessage, CommsNeedsHumanRow, CommsRoom } from "./useCommsPoll";

vi.mock("../../../ipc/transport", () => ({ invoke: vi.fn(), isTauri: true }));

const mockInvoke = vi.mocked(invoke);
const OPEN_KEY = "heddle.comms.open";

function mkRoom(overrides: Partial<CommsRoom> & { target: string }): CommsRoom {
  return { open: true, topic: null, memberCount: null, latestId: 0, ...overrides };
}
function mkMsg(id: number, target: string): CommsMessage {
  return {
    id,
    ts: "2026-08-16T17:00:00Z",
    sender: "R",
    target,
    kind: "chat",
    tier: "agent",
    verified: false,
    body: `msg ${id}`,
    replyTo: null,
    dispatchId: null,
    fromNameClaim: null,
    senderKind: "agent",
    deliveries: null,
  };
}
function mkNeedsHumanRow(id: number): CommsNeedsHumanRow {
  return { id, ts: "2026-08-16T17:00:00Z", sender: "U", target: "#fleet", kind: "needs-human", body: `row ${id}` };
}

let roomsResponse: {
  schemaOk: boolean;
  schemaVersion: number;
  rooms: CommsRoom[];
  needsHuman: CommsNeedsHumanRow[];
  recentRefusals: number;
};
let transcriptStore: Map<string, CommsMessage[]>;

function installDefaultMock() {
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "heddle_comms_rooms") return Promise.resolve(roomsResponse);
    if (cmd === "heddle_comms_transcript") {
      const target = args?.target as string;
      const sinceId = (args?.sinceId as number | null) ?? 0;
      const all = transcriptStore.get(target) ?? [];
      return Promise.resolve({ schemaOk: true, schemaVersion: 1, messages: all.filter((m) => m.id > sinceId), floor: null });
    }
    if (cmd === "heddle_fleet_roster") return Promise.resolve([]);
    return Promise.reject(new Error("unexpected invoke cmd: " + cmd));
  });
}

beforeEach(() => {
  localStorage.clear();
  roomsResponse = { schemaOk: true, schemaVersion: 1, rooms: [mkRoom({ target: "#fleet", latestId: 0 })], needsHuman: [], recentRefusals: 0 };
  transcriptStore = new Map();
  mockInvoke.mockReset();
  installDefaultMock();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ChatroomPane shell", () => {
  it("renders collapsed by default with the title and no badges when there is nothing to flag", async () => {
    render(<ChatroomPane />);
    expect(screen.getByTestId("comms-strip")).toBeTruthy();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_rooms"));
    expect(screen.queryByTestId("comms-strip-needs-badge")).toBeNull();
    expect(screen.queryByTestId("comms-strip-refusals-chip")).toBeNull();
    expect(screen.queryByTestId("comms-overlay")).toBeNull();
  });

  it("shows the needsHuman total as a badge and recentRefusals as an amber chip on the collapsed strip", async () => {
    roomsResponse.needsHuman = [mkNeedsHumanRow(1), mkNeedsHumanRow(2), mkNeedsHumanRow(3)];
    roomsResponse.recentRefusals = 4;
    render(<ChatroomPane />);

    expect((await screen.findByTestId("comms-strip-needs-badge")).textContent).toBe("3");
    expect(screen.getByTestId("comms-strip-refusals-chip").textContent).toBe("4");
  });

  it("clicking the strip expands the overlay and persists the open state; the close button collapses it again", async () => {
    render(<ChatroomPane />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_rooms"));

    fireEvent.click(screen.getByTestId("comms-strip"));
    expect(await screen.findByTestId("comms-overlay")).toBeTruthy();
    expect(localStorage.getItem(OPEN_KEY)).toBe("1");
    expect(screen.queryByTestId("comms-strip")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(await screen.findByTestId("comms-strip")).toBeTruthy();
    expect(localStorage.getItem(OPEN_KEY)).toBe("0");
  });

  it("starts expanded on mount when localStorage already has the pane open", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    render(<ChatroomPane />);
    expect(screen.getByTestId("comms-overlay")).toBeTruthy();
    expect(screen.queryByTestId("comms-strip")).toBeNull();
  });

  it("no-flash: the expanded view shows a loading placeholder, never the empty state or schema banner, before the first rooms response resolves", () => {
    localStorage.setItem(OPEN_KEY, "1");
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "heddle_comms_rooms") return new Promise(() => {}); // never resolves in this test
      return Promise.resolve([]);
    });

    render(<ChatroomPane />);

    expect(screen.getByTestId("comms-loading")).toBeTruthy();
    expect(screen.queryByTestId("comms-empty-state")).toBeNull();
    expect(screen.queryByTestId("comms-schema-banner")).toBeNull();
    expect(screen.queryByTestId("comms-rail")).toBeNull();
  });

  it("test 9: schemaOk=false renders only the unsupported-schema banner — rail/transcript/needs-human/floor never render, even if the payload carries data", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    roomsResponse = {
      schemaOk: false,
      schemaVersion: 2,
      rooms: [mkRoom({ target: "#fleet", latestId: 9 })],
      needsHuman: [mkNeedsHumanRow(1)],
      recentRefusals: 3,
    };
    render(<ChatroomPane />);

    const banner = await screen.findByTestId("comms-schema-banner");
    expect(banner.textContent).toBe("comms schema v2 isn't supported by this build");
    expect(screen.queryByTestId("comms-rail")).toBeNull();
    expect(screen.queryByTestId("comms-transcript")).toBeNull();
    expect(screen.queryByTestId("comms-needs-human")).toBeNull();
    expect(screen.queryByTestId("comms-floor-banner")).toBeNull();
    expect(screen.queryByTestId("comms-empty-state")).toBeNull();
  });

  it("schemaVersion=0 (fresh install) renders the friendly empty state, not an error", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    roomsResponse = { schemaOk: true, schemaVersion: 0, rooms: [], needsHuman: [], recentRefusals: 0 };
    render(<ChatroomPane />);

    const empty = await screen.findByTestId("comms-empty-state");
    expect(empty.textContent).toBeTruthy();
    expect(screen.queryByTestId("comms-schema-banner")).toBeNull();
    expect(screen.queryByTestId("comms-rail")).toBeNull();
  });

  it("test 8 (integration): a room not yet viewed shows an unread badge; opening it clears the badge while an untouched room stays unread", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    roomsResponse.rooms = [mkRoom({ target: "#fleet", latestId: 5 }), mkRoom({ target: "T", latestId: 9 })];
    transcriptStore.set("#fleet", [mkMsg(5, "#fleet")]);
    transcriptStore.set("T", [mkMsg(9, "T")]);

    render(<ChatroomPane />);
    await screen.findByTestId("comms-rail");

    // #fleet auto-activates as the first room and is immediately "viewed"; T was never opened.
    await waitFor(() => expect(screen.queryByTestId("comms-unread-#fleet")).toBeNull());
    expect(screen.getByTestId("comms-unread-T")).toBeTruthy();

    fireEvent.click(screen.getByTestId("comms-room-T"));
    await waitFor(() => expect(screen.queryByTestId("comms-unread-T")).toBeNull());
  });

  it("keeps the collapsed strip's poll running (and its badge current) while the pane stays collapsed", async () => {
    vi.useFakeTimers();
    try {
      render(<ChatroomPane />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByTestId("comms-strip-needs-badge")).toBeNull();

      roomsResponse = { ...roomsResponse, needsHuman: [mkNeedsHumanRow(1)] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByTestId("comms-strip-needs-badge").textContent).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });
});
