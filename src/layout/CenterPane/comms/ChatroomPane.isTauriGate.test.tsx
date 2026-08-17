//! Fail-closed gate: outside a Tauri desktop build, ChatroomPane must render nothing at all (no
//! strip, no overlay, no stray invoke calls) — mirroring the reference panels'
//! `if (!isTauri) return null;` and this repo's ConnectRemotePanel.sshGate.test.tsx pattern.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../ipc/transport";
import { ChatroomPane } from "./ChatroomPane";

vi.mock("../../../ipc/transport", () => ({ invoke: vi.fn(), isTauri: false }));

const mockInvoke = vi.mocked(invoke);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ChatroomPane outside Tauri", () => {
  it("renders nothing and never calls invoke when isTauri is false", () => {
    const { container } = render(<ChatroomPane />);
    expect(container.firstChild).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("still renders nothing even when the pane was previously left open in localStorage", () => {
    localStorage.setItem("heddle.comms.open", "1");
    const { container } = render(<ChatroomPane />);
    expect(container.firstChild).toBeNull();
  });
});
