//! Floor-hold banner (HED-74b spec item 10). Null floor renders nothing; a non-null floor
//! renders the holder + a countdown derived from Date.now() at render time (not a per-second
//! ticking timer — re-rendering with a fresh `floor` prop, as ChatroomPane does on every
//! transcript poll, is what re-derives it). Pure presentational component.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloorBanner } from "./FloorBanner";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FloorBanner", () => {
  it("floor=null renders nothing", () => {
    const { container } = render(<FloorBanner floor={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("a non-null floor renders '<holder> holds the floor' with a m:ss countdown to untilTs", () => {
    beforeFixedNow("2026-08-16T17:00:00.000Z");
    render(<FloorBanner floor={{ holder: "V", untilTs: "2026-08-16T17:01:12.000Z" }} />);

    expect(screen.getByTestId("comms-floor-banner").textContent).toContain("V holds the floor");
    expect(screen.getByTestId("comms-floor-lease").textContent).toBe("1:12");
  });

  it("clamps the countdown at 0:00 once untilTs has passed", () => {
    beforeFixedNow("2026-08-16T17:05:00.000Z");
    render(<FloorBanner floor={{ holder: "V", untilTs: "2026-08-16T17:00:00.000Z" }} />);
    expect(screen.getByTestId("comms-floor-lease").textContent).toBe("0:00");
  });

  it("a floor with untilTs=null shows the holder line without a countdown", () => {
    render(<FloorBanner floor={{ holder: "R", untilTs: null }} />);
    expect(screen.getByTestId("comms-floor-banner").textContent).toContain("R holds the floor");
    expect(screen.queryByTestId("comms-floor-lease")).toBeNull();
  });

  it("test 10: re-rendering with floor:null (the next poll tick) removes the banner", () => {
    const { rerender, container } = render(<FloorBanner floor={{ holder: "V", untilTs: null }} />);
    expect(screen.getByTestId("comms-floor-banner")).toBeTruthy();

    rerender(<FloorBanner floor={null} />);
    expect(container.firstChild).toBeNull();
  });
});

function beforeFixedNow(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}
