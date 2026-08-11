import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

describe("ContextMenu viewport clamping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("measures the real panel and moves a right-edge menu fully into view", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 172,
      height: 280,
      x: 450,
      y: 20,
      top: 20,
      right: 622,
      bottom: 300,
      left: 450,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(520);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(500);

    render(
      <ContextMenu
        x={450}
        y={20}
        items={[{ label: "New Browser Page", onClick: () => {} }]}
        onClose={() => {}}
      />,
    );

    const item = screen.getByText("New Browser Page");
    const panel = item.closest(".menu-item")?.parentElement;
    const positioner = panel?.parentElement;
    await waitFor(() => expect(positioner?.style.left).toBe("340px"));
  });
});
