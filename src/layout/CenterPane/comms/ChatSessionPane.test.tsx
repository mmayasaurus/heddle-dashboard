import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { chatColumnProps, poll } = vi.hoisted(() => ({
  chatColumnProps: [] as {
    activeTarget: string | null;
    highlightId: number | null;
    replyTo: { id: number } | null;
    onNeedsHumanRowClick: (row: { id: number; target: string }) => void;
  }[],
  poll: {
    loaded: true,
    schemaOk: true,
    schemaVersion: 1,
  },
}));

vi.mock("../../../ipc/transport", () => ({ isTauri: true }));
vi.mock("./ChatroomPane", () => ({
  ChatColumn: (props: (typeof chatColumnProps)[number]) => {
    chatColumnProps.push(props);
    return <div data-testid="chat-column" />;
  },
}));
vi.mock("./useCommsPoll", () => ({ useCommsPoll: vi.fn(() => poll) }));
vi.mock("./useOperatorStatus", () => ({ useOperatorStatus: vi.fn(() => ({})) }));

import { ChatSessionPane } from "./ChatSessionPane";

afterEach(() => {
  chatColumnProps.length = 0;
  Object.assign(poll, { loaded: true, schemaOk: true, schemaVersion: 1 });
});

describe("regression PR#71 — chat session pane renders its target's ChatColumn", () => {
  it("passes the fixed chat target into ChatColumn", () => {
    render(<ChatSessionPane chatTarget="#fleet" />);

    expect(screen.getByTestId("chat-column")).toBeTruthy();
    expect(chatColumnProps).toHaveLength(1);
    expect(chatColumnProps[0].activeTarget).toBe("#fleet");
  });

  it("renders an explicit target-missing state instead of a Composer-capable ChatColumn", () => {
    render(<ChatSessionPane chatTarget="" />);

    expect(screen.getByTestId("chat-session-empty-target")).toBeTruthy();
    expect(screen.queryByTestId("chat-column")).toBeNull();
  });

  it("uses the overlay's loading and schema gates before rendering ChatColumn", () => {
    poll.loaded = false;
    const { rerender } = render(<ChatSessionPane chatTarget="#fleet" />);
    expect(screen.getByTestId("comms-loading")).toBeTruthy();

    poll.loaded = true;
    poll.schemaOk = false;
    rerender(<ChatSessionPane chatTarget="#fleet" />);
    expect(screen.getByTestId("comms-schema-banner")).toBeTruthy();

    poll.schemaOk = true;
    poll.schemaVersion = 0;
    rerender(<ChatSessionPane chatTarget="#fleet" />);
    expect(screen.getByTestId("comms-empty-state")).toBeTruthy();
  });

  it("sets the chat target and highlight from a needs-human row", () => {
    render(<ChatSessionPane chatTarget="#fleet" />);

    act(() => {
      chatColumnProps[0].onNeedsHumanRowClick({ id: 19, target: "@operator" });
    });
    expect(chatColumnProps[1].activeTarget).toBe("@operator");
    expect(chatColumnProps[1].highlightId).toBe(19);
    expect(chatColumnProps[1].replyTo?.id).toBe(19);
  });

  it("resynchronizes the active target when the chat target prop changes", () => {
    const { rerender } = render(<ChatSessionPane chatTarget="#fleet" />);

    act(() => {
      chatColumnProps[0].onNeedsHumanRowClick({ id: 19, target: "@operator" });
    });
    rerender(<ChatSessionPane chatTarget="#other-room" />);

    expect(chatColumnProps.at(-1)?.activeTarget).toBe("#other-room");
    expect(chatColumnProps.at(-1)?.highlightId).toBeNull();
    expect(chatColumnProps.at(-1)?.replyTo).toBeNull();
  });
});
