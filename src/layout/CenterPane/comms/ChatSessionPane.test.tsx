import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { chatColumnProps } = vi.hoisted(() => ({ chatColumnProps: [] as { activeTarget: string | null }[] }));

vi.mock("../../../ipc/transport", () => ({ isTauri: true }));
vi.mock("./ChatroomPane", () => ({
  ChatColumn: (props: { activeTarget: string | null }) => {
    chatColumnProps.push(props);
    return <div data-testid="chat-column" />;
  },
}));
vi.mock("./useCommsPoll", () => ({ useCommsPoll: vi.fn(() => ({})) }));
vi.mock("./useOperatorStatus", () => ({ useOperatorStatus: vi.fn(() => ({})) }));

import { ChatSessionPane } from "./ChatSessionPane";

afterEach(() => {
  chatColumnProps.length = 0;
});

describe("regression PR#166 — chat session pane renders its target's ChatColumn", () => {
  it("passes the fixed chat target into ChatColumn", () => {
    render(<ChatSessionPane chatTarget="#fleet" />);

    expect(screen.getByTestId("chat-column")).toBeTruthy();
    expect(chatColumnProps).toHaveLength(1);
    expect(chatColumnProps[0].activeTarget).toBe("#fleet");
  });
});
