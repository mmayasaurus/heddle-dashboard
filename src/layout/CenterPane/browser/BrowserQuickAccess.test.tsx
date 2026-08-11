import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserQuickAccess, QUICK_ACCESS_SITES } from "./BrowserQuickAccess";

describe("BrowserQuickAccess", () => {
  it("renders every configured shortcut with its official destination", () => {
    render(<BrowserQuickAccess label="Quick access" onNavigate={() => {}} />);

    expect(screen.getByRole("navigation", { name: "Quick access" })).toBeTruthy();
    for (const site of QUICK_ACCESS_SITES) {
      expect(screen.getByRole("button", { name: site.label })).toBeTruthy();
      expect(site.url).toMatch(/^https:\/\//);
    }
  });

  it("navigates the current browser tab when a shortcut is clicked", () => {
    const onNavigate = vi.fn();
    render(<BrowserQuickAccess label="Quick access" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Gemini" }));

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("https://gemini.google.com/");
  });
});
