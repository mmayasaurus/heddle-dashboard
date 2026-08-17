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
function mkNeedsHumanRow(id: number, overrides: Partial<CommsNeedsHumanRow> = {}): CommsNeedsHumanRow {
  return { id, ts: "2026-08-16T17:00:00Z", sender: "U", target: "#fleet", kind: "needs-human", body: `row ${id}`, ...overrides };
}

let roomsResponse: {
  schemaOk: boolean;
  schemaVersion: number;
  rooms: CommsRoom[];
  needsHuman: CommsNeedsHumanRow[];
  recentRefusals: number;
};
let transcriptStore: Map<string, CommsMessage[]>;
let operatorStatusResponse: { available: boolean; revoked: boolean; reason: string | null };

const OK_RESULT = { outcome: "ok", code: null, reason: null };

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
    if (cmd === "heddle_comms_operator_status") return Promise.resolve(operatorStatusResponse);
    if (cmd === "heddle_comms_send") return Promise.resolve(OK_RESULT);
    if (cmd === "heddle_comms_create_room") return Promise.resolve(OK_RESULT);
    if (cmd === "heddle_comms_add_member") return Promise.resolve(OK_RESULT);
    if (cmd === "heddle_comms_remove_member") return Promise.resolve(OK_RESULT);
    return Promise.reject(new Error("unexpected invoke cmd: " + cmd));
  });
}

beforeEach(() => {
  localStorage.clear();
  roomsResponse = { schemaOk: true, schemaVersion: 1, rooms: [mkRoom({ target: "#fleet", latestId: 0 })], needsHuman: [], recentRefusals: 0 };
  transcriptStore = new Map();
  operatorStatusResponse = { available: true, revoked: false, reason: null };
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

  it("fix 6: the needs-human badge renders '50+' at the 50-row cap, and the exact count otherwise", async () => {
    roomsResponse.needsHuman = Array.from({ length: 50 }, (_, i) => mkNeedsHumanRow(i + 1));
    render(<ChatroomPane />);
    expect((await screen.findByTestId("comms-strip-needs-badge")).textContent).toBe("50+");
  });

  it("fix 6: 49 rows render the exact count, not '50+'", async () => {
    roomsResponse.needsHuman = Array.from({ length: 49 }, (_, i) => mkNeedsHumanRow(i + 1));
    render(<ChatroomPane />);
    expect((await screen.findByTestId("comms-strip-needs-badge")).textContent).toBe("49");
  });

  it("fix 4: a needs-human click to a target outside rooms[] pins activeTarget so the next rooms poll can't bounce it back to #fleet", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(OPEN_KEY, "1");
      roomsResponse.rooms = [mkRoom({ target: "#fleet" })];
      roomsResponse.needsHuman = [mkNeedsHumanRow(1, { target: "T.2" })];

      const { container } = render(<ChatroomPane />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Auto-defaults to #fleet first (the only known room).
      expect(container.querySelector(".comms-chat-name")?.textContent).toBe("#fleet");

      fireEvent.click(screen.getByTestId("comms-needs-row-1"));
      expect(container.querySelector(".comms-chat-name")?.textContent).toBe("T.2");

      // Force a genuinely new rooms snapshot (new array/object refs) so the next 5s poll actually
      // re-renders and re-evaluates the fallback effect, instead of bailing out on an unchanged
      // reference. T.2 is still absent from rooms[] — must not bounce back to #fleet.
      roomsResponse = { ...roomsResponse, rooms: [mkRoom({ target: "#fleet" })] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(container.querySelector(".comms-chat-name")?.textContent).toBe("T.2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fix 8: Escape collapses the overlay while expanded, but does nothing while collapsed", async () => {
    render(<ChatroomPane />);
    fireEvent.click(screen.getByTestId("comms-strip"));
    expect(await screen.findByTestId("comms-overlay")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByTestId("comms-strip")).toBeTruthy();
    expect(localStorage.getItem(OPEN_KEY)).toBe("0");
    expect(screen.queryByTestId("comms-overlay")).toBeNull();

    // While collapsed, Escape must not do anything (still collapsed, no error).
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("comms-strip")).toBeTruthy();
  });
});

describe("ChatroomPane — HED-74c operator composer + room management wiring", () => {
  it("the composer renders inside the expanded pane once a room is active", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    render(<ChatroomPane />);
    expect(await screen.findByTestId("comms-composer")).toBeTruthy();
  });

  it("'+ New room' is enabled once the operator status poll confirms availability, and opens the create-room modal", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    render(<ChatroomPane />);
    const btn = (await screen.findByTestId("comms-new-room-btn")) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));

    fireEvent.click(btn);
    expect(await screen.findByTestId("comms-room-modal")).toBeTruthy();
  });

  it("'+ New room' starts disabled (fail-safe) before the first operator-status poll resolves, with no premature hint", async () => {
    let resolveStatus!: (v: unknown) => void;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "heddle_comms_operator_status") return new Promise((resolve) => (resolveStatus = resolve));
      if (cmd === "heddle_comms_rooms") return Promise.resolve(roomsResponse);
      if (cmd === "heddle_comms_transcript") {
        const target = args?.target as string;
        const all = transcriptStore.get(target) ?? [];
        return Promise.resolve({ schemaOk: true, schemaVersion: 1, messages: all, floor: null });
      }
      if (cmd === "heddle_fleet_roster") return Promise.resolve([]);
      return Promise.reject(new Error("unexpected invoke cmd: " + cmd));
    });
    localStorage.setItem(OPEN_KEY, "1");
    render(<ChatroomPane />);

    const btn = (await screen.findByTestId("comms-new-room-btn")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("New room — operator and orchestrators only");

    resolveStatus({ available: true, revoked: false, reason: null });
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("'+ New room' is disabled with the operator hint when the operator is unavailable", async () => {
    operatorStatusResponse = { available: false, revoked: false, reason: "no-token" };
    localStorage.setItem(OPEN_KEY, "1");
    render(<ChatroomPane />);
    const btn = (await screen.findByTestId("comms-new-room-btn")) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.title).toContain("--init-operator-token");
  });

  it("Escape closes the room-create modal without collapsing the whole pane", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    render(<ChatroomPane />);
    fireEvent.click(await screen.findByTestId("comms-new-room-btn"));
    expect(await screen.findByTestId("comms-room-modal")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("comms-room-modal")).toBeNull());
    // The pane itself must still be expanded — Escape must not have bubbled into the collapse handler.
    expect(screen.getByTestId("comms-overlay")).toBeTruthy();
    expect(localStorage.getItem(OPEN_KEY)).toBe("1");
  });

  it("member controls appear in the header for an active CLOSED room, and are absent for an open room", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    roomsResponse.rooms = [mkRoom({ target: "#fleet", open: true }), mkRoom({ target: "#heddle-build", open: false, memberCount: 3 })];
    render(<ChatroomPane />);
    await screen.findByTestId("comms-rail");

    // #fleet auto-activates first (open room) — no member controls.
    await waitFor(() => expect(screen.queryByTestId("comms-member-controls")).toBeNull());

    fireEvent.click(screen.getByTestId("comms-room-#heddle-build"));
    expect(await screen.findByTestId("comms-member-controls")).toBeTruthy();
  });

  it("B5: RoomMemberControls resets its address input when switching between two closed rooms", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    roomsResponse.rooms = [
      mkRoom({ target: "#heddle-build", open: false, memberCount: 3 }),
      mkRoom({ target: "#heddle-ops", open: false, memberCount: 1 }),
    ];
    render(<ChatroomPane />);
    await screen.findByTestId("comms-rail");

    // Neither room is #fleet/open, so #heddle-build (first listed) auto-activates.
    await screen.findByTestId("comms-member-controls");
    fireEvent.change(screen.getByTestId("comms-member-ctl-input"), { target: { value: "half-typed-address" } });
    expect((screen.getByTestId("comms-member-ctl-input") as HTMLInputElement).value).toBe("half-typed-address");

    fireEvent.click(screen.getByTestId("comms-room-#heddle-ops"));
    await waitFor(() => expect((screen.getByTestId("comms-member-ctl-input") as HTMLInputElement).value).toBe(""));
  });

  it("clicking a needs-human row sets the composer's reply-to context", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    roomsResponse.needsHuman = [mkNeedsHumanRow(1, { sender: "U.2", body: "may I run cargo update?" })];
    render(<ChatroomPane />);
    await screen.findByTestId("comms-rail");

    fireEvent.click(screen.getByTestId("comms-needs-row-1"));
    const ctx = await screen.findByTestId("comms-reply-ctx");
    expect(ctx.textContent).toContain("U.2");
    expect(ctx.textContent).toContain("may I run cargo update?");
  });

  it("switching rooms clears a pending reply-to context", async () => {
    localStorage.setItem(OPEN_KEY, "1");
    roomsResponse.rooms = [mkRoom({ target: "#fleet" }), mkRoom({ target: "T" })];
    roomsResponse.needsHuman = [mkNeedsHumanRow(1, { target: "#fleet" })];
    render(<ChatroomPane />);
    await screen.findByTestId("comms-rail");

    fireEvent.click(screen.getByTestId("comms-needs-row-1"));
    await screen.findByTestId("comms-reply-ctx");

    fireEvent.click(screen.getByTestId("comms-room-T"));
    await waitFor(() => expect(screen.queryByTestId("comms-reply-ctx")).toBeNull());
  });
});
