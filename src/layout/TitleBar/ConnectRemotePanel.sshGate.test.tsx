//! HED-42: SSH remote development is disabled in heddle builds. The Connect panel must follow the
//! backend's `ssh_remote_available` answer — never offer an SSH mode the backend will refuse — and
//! must still expose URL (pairing-link) mode, which does not depend on the disabled provisioning path.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("../../ipc/transport", () => ({ invoke, listen, isTauri: true }));
vi.mock("../../i18n", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("../../components/Backdrop", () => ({
  Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ConnectRemotePanel } from "./ConnectRemotePanel";

/** Answer every backend call the panel makes on mount; only `ssh_remote_available` varies per test. */
function backend(sshAvailable: boolean) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "ssh_remote_available":
        return Promise.resolve(sshAvailable);
      case "ssh_hosts_list":
      case "url_hosts_list":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
}

describe("ConnectRemotePanel — SSH remote gate (HED-42)", () => {
  beforeEach(() => {
    invoke.mockReset();
  });
  afterEach(cleanup);

  it("offers only URL mode when the backend reports SSH remote as unavailable", async () => {
    backend(false);
    render(<ConnectRemotePanel onClose={vi.fn()} />);
    // The panel asked the backend, and the pairing-link input (URL mode) is the initial view.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ssh_remote_available"));
    expect(screen.getByPlaceholderText("connect.pairingPlaceholder")).toBeTruthy();
    // No SSH mode switch: nothing in the panel lets the user reach the refused ssh_* commands.
    expect(screen.queryByRole("button", { name: "SSH" })).toBeNull();
    // Nothing on mount touched the SSH provisioning commands.
    const called = invoke.mock.calls.map((c) => c[0]);
    expect(called).not.toContain("ssh_probe_host");
    expect(called).not.toContain("ssh_connect");
  });

  it("offers both SSH and URL modes only when the backend says SSH remote exists", async () => {
    backend(true);
    render(<ConnectRemotePanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "SSH" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "URL" })).toBeTruthy();
    // URL stays the default view even when SSH is available.
    expect(screen.getByPlaceholderText("connect.pairingPlaceholder")).toBeTruthy();
  });

  it("treats a failing availability query as unavailable (fail closed)", async () => {
    // The availability query rejects. Assert only AFTER the rejection has been delivered and handled
    // (drain the microtask queue inside act): a removed `.catch` would then surface as an unhandled
    // rejection (vitest fails the run), and a default-true gate would render the SSH button.
    invoke.mockImplementation((cmd: string) =>
      cmd === "ssh_remote_available" ? Promise.reject(new Error("no backend")) : Promise.resolve([]),
    );
    render(<ConnectRemotePanel onClose={vi.fn()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ssh_remote_available"));
    await act(async () => {
      // rejection → `.then` skipped → `.catch` handler → state update: three microtask hops, drained.
      for (let hop = 0; hop < 3; hop += 1) await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "SSH" })).toBeNull();
    expect(screen.getByPlaceholderText("connect.pairingPlaceholder")).toBeTruthy();
  });
});
