//! Needs-Maya adapter behavior: it reuses the shared visual strip but opens the corresponding
//! Linear issue externally instead of changing the active comms conversation.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NeedsMayaStrip } from "./NeedsMayaStrip";
import type { NeedsMayaRow } from "./useCommsPoll";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../../platform", () => ({ platform: { opener: { openExternal } } }));

afterEach(() => {
  cleanup();
  openExternal.mockClear();
});

function mkRow(issue: string, overrides: Partial<NeedsMayaRow> = {}): NeedsMayaRow {
  return {
    issue,
    agent: "W",
    ask: `Decision needed for ${issue}`,
    ts: "2026-08-16T16:56:00Z",
    linearUrl: `https://linear.app/spinventory/issue/${issue}`,
    ...overrides,
  };
}

describe("NeedsMayaStrip", () => {
  it("shows 3 of 5 rows and the localized +2 more overflow", () => {
    render(<NeedsMayaStrip rows={[mkRow("HED-1"), mkRow("HED-2"), mkRow("HED-3"), mkRow("HED-4"), mkRow("HED-5")]} error={null} />);

    expect(screen.getByTestId("comms-needs-row-HED-1")).toBeTruthy();
    expect(screen.getByTestId("comms-needs-row-HED-2")).toBeTruthy();
    expect(screen.getByTestId("comms-needs-row-HED-3")).toBeTruthy();
    expect(screen.queryByTestId("comms-needs-row-HED-4")).toBeNull();
    expect(screen.getByTestId("comms-needs-more").textContent).toBe("+2 more");
  });

  it("opens the selected issue in the external browser", () => {
    const row = mkRow("SPI-243");
    render(<NeedsMayaStrip rows={[row]} error={null} />);

    fireEvent.click(screen.getByTestId("comms-needs-row-SPI-243"));

    expect(openExternal).toHaveBeenCalledWith("https://linear.app/spinventory/issue/SPI-243");
  });

  it("renders nothing for an empty healthy queue", () => {
    const { container } = render(<NeedsMayaStrip rows={[]} error={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a muted unavailable line for an empty unavailable queue", () => {
    render(<NeedsMayaStrip rows={[]} error="needs-maya queue unavailable" />);
    expect(screen.getByTestId("comms-needs-maya-error").textContent).toBe("needs-maya queue unavailable");
  });
});
