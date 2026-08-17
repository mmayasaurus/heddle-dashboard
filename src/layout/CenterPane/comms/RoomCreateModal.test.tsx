//! Behavioral tests for room creation (HED-74c approved mock card 07): closed-by-default, member
//! picker wired to heddle_comms_add_member per pick, partial-failure reporting that leaves the
//! (already-created, idempotent) room and the form in place, and Escape/× dismissal.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../ipc/transport";
import { RoomCreateModal } from "./RoomCreateModal";
import type { FleetAgent } from "./useCommsPoll";

vi.mock("../../../ipc/transport", () => ({ invoke: vi.fn(), isTauri: true }));

const mockInvoke = vi.mocked(invoke);

function mkAgent(name: string): FleetAgent {
  return { name, pid: 1, sessionId: "s", cwd: "/", status: "working", kind: "agent", updatedAtMs: 0, alive: true, workers: [] };
}

const ROSTER: FleetAgent[] = [mkAgent("R"), mkAgent("T"), mkAgent("V")];

function nameInput(): HTMLInputElement {
  return screen.getByTestId("comms-modal-name") as HTMLInputElement;
}
function submitBtn(): HTMLButtonElement {
  return screen.getByTestId("comms-modal-submit") as HTMLButtonElement;
}

beforeEach(() => {
  mockInvoke.mockReset();
});

afterEach(cleanup);

describe("RoomCreateModal — validation", () => {
  it("does not submit and shows the required error when name is empty", () => {
    render(<RoomCreateModal roster={ROSTER} onClose={vi.fn()} />);
    fireEvent.click(submitBtn());
    expect(screen.getByTestId("comms-modal-name-error")).toBeTruthy();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("does not submit for a whitespace-only name", () => {
    render(<RoomCreateModal roster={ROSTER} onClose={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "   " } });
    fireEvent.click(submitBtn());
    expect(screen.getByTestId("comms-modal-name-error")).toBeTruthy();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("RoomCreateModal — create_room defaults and naming", () => {
  it("sends open:false by default, without picking the toggle", async () => {
    mockInvoke.mockResolvedValue({ outcome: "ok", code: null, reason: null });
    render(<RoomCreateModal roster={ROSTER} onClose={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "drawer-observability" } });
    fireEvent.click(submitBtn());

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_create_room", { name: "#drawer-observability", topic: null, open: false }),
    );
  });

  it("sends open:true only after the toggle is explicitly checked", async () => {
    mockInvoke.mockResolvedValue({ outcome: "ok", code: null, reason: null });
    render(<RoomCreateModal roster={ROSTER} onClose={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "town-hall" } });
    fireEvent.click(screen.getByTestId("comms-modal-open-toggle").querySelector("input")!);
    fireEvent.click(submitBtn());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_create_room", { name: "#town-hall", topic: null, open: true }));
  });

  it("prefixes the name with # and forwards a non-empty topic", async () => {
    mockInvoke.mockResolvedValue({ outcome: "ok", code: null, reason: null });
    render(<RoomCreateModal roster={ROSTER} onClose={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "heddle-build" } });
    fireEvent.change(screen.getByTestId("comms-modal-topic"), { target: { value: "build status" } });
    fireEvent.click(submitBtn());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_create_room", { name: "#heddle-build", topic: "build status", open: false }));
  });
});

describe("RoomCreateModal — member picking", () => {
  it("posts heddle_comms_add_member for each picked roster member, after create_room", async () => {
    mockInvoke.mockResolvedValue({ outcome: "ok", code: null, reason: null });
    render(<RoomCreateModal roster={ROSTER} onClose={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "heddle-build" } });
    fireEvent.click(screen.getByTestId("comms-modal-member-R"));
    fireEvent.click(screen.getByTestId("comms-modal-member-T"));
    fireEvent.click(submitBtn());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_add_member", { room: "#heddle-build", address: "R" }));
    expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_add_member", { room: "#heddle-build", address: "T" });
    expect(mockInvoke).not.toHaveBeenCalledWith("heddle_comms_add_member", { room: "#heddle-build", address: "V" });
  });

  it("toggling a chip twice deselects it — no add_member call for it", async () => {
    mockInvoke.mockResolvedValue({ outcome: "ok", code: null, reason: null });
    render(<RoomCreateModal roster={ROSTER} onClose={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "room" } });
    fireEvent.click(screen.getByTestId("comms-modal-member-R"));
    fireEvent.click(screen.getByTestId("comms-modal-member-R"));
    fireEvent.click(submitBtn());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_create_room", expect.anything()));
    expect(mockInvoke).not.toHaveBeenCalledWith("heddle_comms_add_member", expect.anything());
  });

  it("with no members picked, only create_room is called", async () => {
    mockInvoke.mockResolvedValue({ outcome: "ok", code: null, reason: null });
    render(<RoomCreateModal roster={ROSTER} onClose={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "solo" } });
    fireEvent.click(submitBtn());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
  });
});

describe("RoomCreateModal — partial failure and closing", () => {
  it("a failed member add surfaces its address, leaves the modal open, and does not call onClose", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "heddle_comms_create_room") return Promise.resolve({ outcome: "ok", code: null, reason: null });
      if (cmd === "heddle_comms_add_member") {
        const address = args?.address as string;
        return address === "T"
          ? Promise.resolve({ outcome: "refused", code: "not-found", reason: "no such address" })
          : Promise.resolve({ outcome: "ok", code: null, reason: null });
      }
      return Promise.reject(new Error("unexpected cmd " + cmd));
    });
    const onClose = vi.fn();
    render(<RoomCreateModal roster={ROSTER} onClose={onClose} />);
    fireEvent.change(nameInput(), { target: { value: "heddle-build" } });
    fireEvent.click(screen.getByTestId("comms-modal-member-R"));
    fireEvent.click(screen.getByTestId("comms-modal-member-T"));
    fireEvent.click(submitBtn());

    expect((await screen.findByTestId("comms-modal-members-failed")).textContent).toContain("T");
    expect(onClose).not.toHaveBeenCalled();
    // The room itself was created and stays created — retrying (idempotent) is the recovery path,
    // not clearing the form.
    expect(nameInput().value).toBe("heddle-build");
  });

  it("a refused create_room shows the reason and never attempts to add members", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "heddle_comms_create_room") return Promise.resolve({ outcome: "refused", code: "denied", reason: "workers cannot create rooms" });
      return Promise.reject(new Error("unexpected cmd " + cmd));
    });
    const onClose = vi.fn();
    render(<RoomCreateModal roster={ROSTER} onClose={onClose} />);
    fireEvent.change(nameInput(), { target: { value: "nope" } });
    fireEvent.click(screen.getByTestId("comms-modal-member-R"));
    fireEvent.click(submitBtn());

    expect((await screen.findByTestId("comms-modal-create-error")).textContent).toBe("workers cannot create rooms");
    expect(onClose).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("heddle_comms_add_member", expect.anything());
  });

  it("a fully clean create (room + every picked member) closes the modal", async () => {
    mockInvoke.mockResolvedValue({ outcome: "ok", code: null, reason: null });
    const onClose = vi.fn();
    render(<RoomCreateModal roster={ROSTER} onClose={onClose} />);
    fireEvent.change(nameInput(), { target: { value: "heddle-build" } });
    fireEvent.click(screen.getByTestId("comms-modal-member-R"));
    fireEvent.click(submitBtn());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("the × button closes without submitting", () => {
    const onClose = vi.fn();
    render(<RoomCreateModal roster={ROSTER} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("comms-modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("Escape closes without submitting", () => {
    const onClose = vi.fn();
    render(<RoomCreateModal roster={ROSTER} onClose={onClose} />);
    fireEvent.change(nameInput(), { target: { value: "unsaved" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
