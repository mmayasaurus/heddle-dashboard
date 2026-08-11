//! Headless regression tests for document-tab refresh and save coordination. Refresh File increments reloadNonce,
//! causing DocView to reread disk; with unsaved changes it only compares stat data and never discards user edits.
//! Save shortcut coverage ensures overlapping global/local key delivery cannot issue duplicate disk writes.
//!
//! Stub the CodeMirror/Milkdown editors and sidebar components because these tests care only whether content is
//! reread, measured by readTextFile calls rather than editor rendering. Stub the Tauri-facing ipc/notify modules
//! as well so the store loads in jsdom, following docTabs.test.

import * as React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { readTextFile, statFile, writeTextFile } = vi.hoisted(() => ({
  readTextFile: vi.fn().mockResolvedValue({ content: "hello", mtimeMs: 1 }),
  statFile: vi.fn().mockResolvedValue({ size: 5, mtimeMs: 1 }),
  writeTextFile: vi.fn().mockResolvedValue({ conflict: false, mtimeMs: 2 }),
}));

vi.mock("../../../ipc/info", () => ({
  readTextFile,
  statFile,
  writeTextFile,
  FILE_BEING_WRITTEN: "FILE_BEING_WRITTEN",
  loadFileBlob: vi.fn(),
}));
vi.mock("./SourceEditor", () => ({
  SourceEditor: React.forwardRef(() =>
    React.createElement("div", { "data-testid": "source-editor" }),
  ),
}));
vi.mock("./WysiwygEditor", () => ({
  WysiwygEditor: React.forwardRef(() =>
    React.createElement("div", { "data-testid": "wysiwyg-editor" }),
  ),
}));
vi.mock("./ImageDocView", () => ({ ImageDocView: () => null }));
vi.mock("./DocFileTree", () => ({ DocFileTree: () => null }));
vi.mock("./DocOutline", () => ({ DocOutline: () => null, parseOutline: () => [] }));
vi.mock("../../../hooks/useKeyboardShortcuts", () => ({
  DOC_SAVE_EVENT: "vlx:doc-save",
  DOC_EXPORT_PDF_EVENT: "vlx:doc-export-pdf",
}));
vi.mock("../../../ipc/commands", () => ({
  createWorktree: vi.fn(),
  getSessionCwd: vi.fn().mockResolvedValue(null),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  listShells: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../ipc/tree", () => ({
  listTree: vi.fn().mockResolvedValue({ projects: [], groups: [], sessions: [] }),
}));
// Through the platform adapters (tauri.ts/electron.ts), DocView reaches every notify export. Stub the
// permission-related functions too, or platform loading reports missing mock exports.
vi.mock("../../../notify", () => ({
  notify: vi.fn(),
  getNotifyPermission: vi.fn().mockResolvedValue("granted"),
  requestNotifyPermission: vi.fn().mockResolvedValue("granted"),
  getEffectiveNotifyPermission: vi.fn().mockResolvedValue("granted"),
  requestEffectiveNotifyPermission: vi.fn().mockResolvedValue("granted"),
}));

import { useTermStore } from "../../../store/termStore";
import { DocView } from "./DocView";

/** Open a document tab, render its DocView, await initial loading, and return the tab ID plus rerender. */
async function mountDoc(path: string) {
  useTermStore.setState({ openTabs: [], activeTabId: null, docTabs: {} });
  act(() => useTermStore.getState().openDocTab(path));
  const id = Object.keys(useTermStore.getState().docTabs)[0];
  const view = render(
    <DocView tab={useTermStore.getState().docTabs[id]} hidden={false} />,
  );
  await waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(1));
  // Simulate CenterPane's subscription by passing the latest tab object after store changes.
  const sync = () =>
    view.rerender(<DocView tab={useTermStore.getState().docTabs[id]} hidden={false} />);
  return { id, sync };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("the document tab refresh path (reloadNonce makes DocView re-read from disk)", () => {
  it("refreshDocTab, the Refresh file action in the tab context menu, re-reads the file", async () => {
    const { id, sync } = await mountDoc("/tmp/refresh-a.txt");

    act(() => useTermStore.getState().refreshDocTab(id));
    sync();
    await waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(2));
  });

  it("calling openDocTab again on the same path, as a second view, re-reads the file", async () => {
    const { id, sync } = await mountDoc("/tmp/refresh-b.txt");

    act(() => useTermStore.getState().openDocTab("/tmp/refresh-b.txt"));
    expect(useTermStore.getState().docTabs[id].reloadNonce).toBe(1);
    sync();
    await waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(2));
  });

  it("refreshing with unsaved changes does not re-read: it only compares stat, never silently discarding the user's edits", async () => {
    const { id, sync } = await mountDoc("/tmp/refresh-c.txt");
    act(() => useTermStore.getState().setDocTabDirty(id, true));
    sync();
    statFile.mockClear();

    act(() => useTermStore.getState().refreshDocTab(id));
    sync();
    await waitFor(() => expect(statFile).toHaveBeenCalled());
    expect(readTextFile).toHaveBeenCalledTimes(1); // Still only the initial load.
  });
});

describe("the document save shortcut", () => {
  it("writes only once when a single keypress arrives through both the global save event and the editor keydown", async () => {
    const { id, sync } = await mountDoc("/tmp/save-once.md");
    act(() => useTermStore.getState().setDocTabDirty(id, true));
    sync();

    const forwardGlobalSave = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyS") {
        window.dispatchEvent(new CustomEvent("vlx:doc-save", { detail: id }));
      }
    };
    document.addEventListener("keydown", forwardGlobalSave, true);
    const root = document.querySelector(".docview");
    expect(root).not.toBeNull();

    try {
      root!.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          metaKey: true,
          key: "s",
          code: "KeyS",
        }),
      );
      await waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
    } finally {
      document.removeEventListener("keydown", forwardGlobalSave, true);
    }
  });
});
