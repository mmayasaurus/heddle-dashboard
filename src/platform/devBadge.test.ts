import { describe, expect, it } from "vitest";

import { devDockBadgeLabel, dockBadgeAction } from "./devBadge";

// Regression for HED-159: the dev Dock "DEV" badge must survive the unread-notification hook.
// useNotifications() calls platform.badge.setCount(0) on mount, which — via setBadgeCount — clears the
// macOS Dock badge label, so an earlier native "DEV" stamp vanished once React hydrated. The decision
// below is what the setter dispatches on, so it must resolve to a "DEV" label at zero unread on macOS
// dev, and must never drop the numeric count off macOS.
describe("regression HED-159 — dev Dock badge label", () => {
  it("dev shows 'DEV' at zero unread — setCount(0) must not blank it", () => {
    expect(devDockBadgeLabel(0, true)).toBe("DEV");
    expect(devDockBadgeLabel(undefined, true)).toBe("DEV");
  });

  it("dev folds the unread count into the label when non-zero", () => {
    expect(devDockBadgeLabel(3, true)).toBe("DEV · 3");
    expect(devDockBadgeLabel(1, true)).toBe("DEV · 1");
  });

  it("release defers to the numeric badge (label is null)", () => {
    expect(devDockBadgeLabel(0, false)).toBeNull();
    expect(devDockBadgeLabel(5, false)).toBeNull();
    expect(devDockBadgeLabel(undefined, false)).toBeNull();
  });
});

describe("HED-159 — dockBadgeAction (the full setter decision)", () => {
  it("macOS dev → a 'DEV' label action", () => {
    expect(dockBadgeAction(0, true, true)).toEqual({ kind: "label", label: "DEV" });
    expect(dockBadgeAction(3, true, true)).toEqual({ kind: "label", label: "DEV · 3" });
  });

  it("NON-macOS keeps the numeric badge — the count is never lost off macOS", () => {
    expect(dockBadgeAction(0, false, true)).toEqual({ kind: "count", count: undefined });
    expect(dockBadgeAction(5, false, true)).toEqual({ kind: "count", count: 5 });
  });

  it("macOS release keeps the numeric badge", () => {
    expect(dockBadgeAction(0, true, false)).toEqual({ kind: "count", count: undefined });
    expect(dockBadgeAction(4, true, false)).toEqual({ kind: "count", count: 4 });
  });
});

// NOTE (HED-159): the "label" action calls window.setBadgeLabel, which in Tauri 2 needs its OWN
// capability — `core:window:allow-set-badge-label` — granted in src-tauri/capabilities/default.json
// alongside allow-set-badge-count. Without it the IPC call is rejected and the Dock silently clears
// (found live: "no dev icon"). That ACL is a comment-enforced invariant here (a cross-tree config read
// is brittle from a frontend test); the setter no longer swallows the rejection, so a regression
// surfaces as an error instead of a blank badge.
