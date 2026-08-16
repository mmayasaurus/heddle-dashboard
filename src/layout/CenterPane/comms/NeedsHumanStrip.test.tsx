//! Needs-human pinned strip: shows up to 3 rows with a "+N more" overflow, and a row click hands
//! that row back to the caller (ChatroomPane owns the room-switch + highlight behavior). Pure
//! presentational component — no invoke/isTauri mocking needed.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NeedsHumanStrip } from "./NeedsHumanStrip";
import type { CommsNeedsHumanRow } from "./useCommsPoll";

afterEach(cleanup);

function mkRow(id: number, overrides: Partial<CommsNeedsHumanRow> = {}): CommsNeedsHumanRow {
  return {
    id,
    ts: "2026-08-16T17:00:00Z",
    sender: "U.2",
    target: "#fleet",
    kind: "permission-request",
    body: `body ${id}`,
    ...overrides,
  };
}

describe("NeedsHumanStrip", () => {
  it("renders nothing when there are no rows", () => {
    const { container } = render(<NeedsHumanStrip rows={[]} onRowClick={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows at most 3 rows and a '+N more' overflow indicator beyond that", () => {
    const rows = [mkRow(1), mkRow(2), mkRow(3), mkRow(4), mkRow(5)];
    render(<NeedsHumanStrip rows={rows} onRowClick={vi.fn()} />);

    expect(screen.getByTestId("comms-needs-row-1")).toBeTruthy();
    expect(screen.getByTestId("comms-needs-row-2")).toBeTruthy();
    expect(screen.getByTestId("comms-needs-row-3")).toBeTruthy();
    expect(screen.queryByTestId("comms-needs-row-4")).toBeNull();
    expect(screen.queryByTestId("comms-needs-row-5")).toBeNull();
    expect(screen.getByTestId("comms-needs-more").textContent).toBe("+2 more");
  });

  it("shows no overflow indicator when there are exactly 3 rows", () => {
    render(<NeedsHumanStrip rows={[mkRow(1), mkRow(2), mkRow(3)]} onRowClick={vi.fn()} />);
    expect(screen.queryByTestId("comms-needs-more")).toBeNull();
  });

  it("clicking a row hands that exact row back to the caller", () => {
    const onRowClick = vi.fn();
    const rows = [mkRow(1, { target: "#fleet" }), mkRow(2, { target: "T" })];
    render(<NeedsHumanStrip rows={rows} onRowClick={onRowClick} />);

    fireEvent.click(screen.getByTestId("comms-needs-row-2"));

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
    // The non-clicked row must not also fire.
    expect(onRowClick).not.toHaveBeenCalledWith(rows[0]);
  });

  it("renders kind, sender/target, and body content for each visible row", () => {
    const row = mkRow(9, { kind: "NEEDS-HUMAN", sender: "W", target: "operator", body: "Cursor account 2 re-auth required" });
    render(<NeedsHumanStrip rows={[row]} onRowClick={vi.fn()} />);
    const el = screen.getByTestId("comms-needs-row-9");
    expect(el.textContent).toContain("NEEDS-HUMAN");
    expect(el.textContent).toContain("W");
    expect(el.textContent).toContain("operator");
    expect(el.textContent).toContain("Cursor account 2 re-auth required");
  });
});
