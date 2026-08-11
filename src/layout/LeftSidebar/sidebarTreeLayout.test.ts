import { describe, expect, it } from "vitest";
import {
  collectSidebarViewIds,
  computeSidebarViewLayout,
  makeSidebarViewLeaf,
  migrateLegacySidebarTabs,
  removeSidebarView,
  setSidebarSplitSizes,
  splitSidebarView,
} from "./sidebarTreeLayout";

describe("sidebar tree split layout", () => {
  it("combines horizontal and vertical splits independently", () => {
    const first = makeSidebarViewLeaf("main");
    const horizontal = splitSidebarView(first, "main", "horizontal", "right");
    const mixed = splitSidebarView(horizontal, "right", "vertical", "right-bottom");
    const layout = computeSidebarViewLayout(mixed);

    expect(layout.map(({ leaf }) => leaf.viewId)).toEqual(["main", "right", "right-bottom"]);
    expect(layout[0].rect).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(layout[1].rect).toEqual({ left: 50, top: 0, width: 50, height: 50 });
    expect(layout[2].rect).toEqual({ left: 50, top: 50, width: 50, height: 50 });
  });

  it("promotes a split leaf's sibling when that view is removed", () => {
    const first = makeSidebarViewLeaf("main");
    const horizontal = splitSidebarView(first, "main", "horizontal", "right");
    const mixed = splitSidebarView(horizontal, "right", "vertical", "right-bottom");
    const removed = removeSidebarView(mixed, "right");

    expect(removed).not.toBeNull();
    expect(collectSidebarViewIds(removed!)).toEqual(["main", "right-bottom"]);
    expect(computeSidebarViewLayout(removed!)[1].rect).toEqual({
      left: 50,
      top: 0,
      width: 50,
      height: 100,
    });
  });

  it("updates only the requested divider sizes", () => {
    const split = splitSidebarView(
      makeSidebarViewLeaf("main"),
      "main",
      "horizontal",
      "right",
    );
    if (split.kind !== "split") throw new Error("expected a split");

    const resized = setSidebarSplitSizes(split, split.paneId, [65, 35]);
    expect(resized.kind).toBe("split");
    if (resized.kind === "split") expect(resized.sizes).toEqual([65, 35]);
  });

  it("migrates legacy tabs separately and legacy stacks into equal vertical panes", () => {
    const tabLayout = migrateLegacySidebarTabs(["main", "second"], "tabs");
    expect(tabLayout).toHaveLength(2);
    expect(tabLayout.map((tab) => collectSidebarViewIds(tab.root))).toEqual([
      ["main"],
      ["second"],
    ]);

    const stackLayout = migrateLegacySidebarTabs(["main", "second", "third"], "stack");
    expect(stackLayout).toHaveLength(1);
    const panes = computeSidebarViewLayout(stackLayout[0].root);
    expect(panes.map(({ leaf }) => leaf.viewId)).toEqual(["main", "second", "third"]);
    for (const { rect } of panes) expect(rect.height).toBeCloseTo(100 / 3);
  });
});
