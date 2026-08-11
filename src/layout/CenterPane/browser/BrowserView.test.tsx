import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({
  navigate: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  setVisible: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../i18n", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("../../../ipc/browser", () => ({
  browserBack: vi.fn(),
  browserClose: browser.close,
  browserForward: vi.fn(),
  browserNavigate: browser.navigate,
  browserOpen: vi.fn(() => Promise.resolve()),
  browserReload: vi.fn(),
  browserSetBounds: vi.fn(),
  browserSetVisible: browser.setVisible,
  browserStop: vi.fn(),
  onBrowserState: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../../../ipc/transport", () => ({ openPath: vi.fn() }));
vi.mock("../../../store/termStore", () => ({
  useTermStore: {
    getState: () => ({ applyBrowserState: vi.fn() }),
  },
}));
vi.mock("../../../hooks/nativeViewSuspend", () => ({
  useNativeViewSuspended: () => false,
}));

import { BrowserView } from "./BrowserView";

describe("BrowserView quick access integration", () => {
  afterEach(() => {
    browser.navigate.mockClear();
    browser.close.mockClear();
    browser.setVisible.mockClear();
  });

  it("routes a shortcut through browserNavigate for the current tab", async () => {
    render(
      <BrowserView
        hidden
        tab={{ id: "browser-test", url: "about:blank", title: "New Tab", loading: false }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "ChatGPT", hidden: true }));

    await waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledWith("browser-test", "https://chatgpt.com/");
    });
  });
});
