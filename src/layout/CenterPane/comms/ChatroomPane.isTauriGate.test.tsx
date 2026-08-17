//! Fail-closed gate: outside a Tauri desktop build, ChatroomPane must render nothing at all (no
//! strip, no overlay, no stray invoke calls) — mirroring the reference panels'
//! `if (!isTauri) return null;` and this repo's ConnectRemotePanel.sshGate.test.tsx pattern.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNativeViewSuspended } from "../../../hooks/nativeViewSuspend";
import { invoke } from "../../../ipc/transport";
import { ChatroomPane } from "./ChatroomPane";

vi.mock("../../../ipc/transport", () => ({ invoke: vi.fn(), isTauri: false }));

const mockInvoke = vi.mocked(invoke);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Reads the shared native-view-suspension signal so a test can observe it without reaching into
 *  nativeViewSuspend.ts's module-private counter. */
function SuspensionProbe() {
  return <div data-testid="suspension-probe">{String(useNativeViewSuspended())}</div>;
}

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

  it("does not suspend native views on a non-Tauri mount even when open='1' persisted in localStorage", () => {
    // Regression guard (4 reviewers, #40): the suspend hook must stay gated on `isTauri && open`,
    // not just `open` — a web/non-Tauri mount has no native view to hide, so it must never
    // increment the process-wide suspension counter, however `open` was left in localStorage.
    localStorage.setItem("heddle.comms.open", "1");
    const { getByTestId } = render(
      <>
        <ChatroomPane />
        <SuspensionProbe />
      </>,
    );
    expect(getByTestId("suspension-probe").textContent).toBe("false");
  });
});
