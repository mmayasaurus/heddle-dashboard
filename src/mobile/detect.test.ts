//! Unit tests for isMobileView: Tauri exclusion, URL-parameter/localStorage override precedence, and automatic
//! narrow-touchscreen detection. jsdom has no real device characteristics, so defineProperty stages each one.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMobileView } from "./detect";

/** Stage viewport dimensions; defineProperty can override jsdom's innerWidth/innerHeight. */
function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true, writable: true });
}

/** Stage the pointer type: coarse means touchscreen. jsdom lacks matchMedia, so replace it entirely. */
function setCoarsePointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: coarse && query === "(pointer: coarse)", media: query }),
  });
}

/** Stage URL query parameters. jsdom cannot navigate a full page, so change search through history.replaceState. */
function setSearch(search: string) {
  window.history.replaceState(null, "", search ? `/?${search}` : "/");
}

const tauriWindow = window as unknown as Record<string, unknown>;

beforeEach(() => {
  // Default scene: desktop browser with a fine pointer, wide viewport, no override, and no Tauri.
  delete tauriWindow.__TAURI_INTERNALS__;
  localStorage.clear();
  setSearch("");
  setCoarsePointer(false);
  setViewport(1440, 900);
});

afterEach(() => {
  delete tauriWindow.__TAURI_INTERNALS__;
  localStorage.clear();
  setSearch("");
});

describe("isMobileView automatic detection", () => {
  it("matches phone characteristics: touch screen and a viewport short side under 768", () => {
    setCoarsePointer(true);
    setViewport(430, 932); // iPhone 14 Pro Max in portrait.
    expect(isMobileView()).toBe(true);
  });

  it("also matches a phone in landscape, where the short side is still under 768", () => {
    setCoarsePointer(true);
    setViewport(932, 430);
    expect(isMobileView()).toBe(true);
  });

  it("does not match a desktop browser with a fine pointer and a wide screen", () => {
    expect(isMobileView()).toBe(false);
  });

  it("does not match a narrow window with a fine pointer, such as a desktop browser dragged narrow", () => {
    setViewport(400, 900);
    expect(isMobileView()).toBe(false);
  });

  it("does not match a touch tablet whose short side is 768 or more, leaving it to the manual override", () => {
    setCoarsePointer(true);
    setViewport(820, 1180); // iPad Air in portrait.
    expect(isMobileView()).toBe(false);
  });

  it("treats an unavailable matchMedia as non-touch without throwing", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    setViewport(430, 932);
    expect(isMobileView()).toBe(false);
  });
});

describe("isMobileView manual override", () => {
  it("?view=mobile forces the mobile view despite desktop characteristics", () => {
    setSearch("view=mobile");
    expect(isMobileView()).toBe(true);
  });

  it("?view=desktop forces the desktop view despite phone characteristics", () => {
    setCoarsePointer(true);
    setViewport(430, 932);
    setSearch("view=desktop");
    expect(isMobileView()).toBe(false);
  });

  it("localStorage remembering mobile also enters the mobile view on a desktop", () => {
    localStorage.setItem("vlx-view-mode", "mobile");
    expect(isMobileView()).toBe(true);
  });

  it("localStorage remembering desktop also enters the desktop view on a phone", () => {
    setCoarsePointer(true);
    setViewport(430, 932);
    localStorage.setItem("vlx-view-mode", "desktop");
    expect(isMobileView()).toBe(false);
  });

  it("the URL parameter takes precedence over localStorage", () => {
    localStorage.setItem("vlx-view-mode", "desktop");
    setSearch("view=mobile");
    expect(isMobileView()).toBe(true);
  });

  it("an invalid ?view= value counts as no override and falls back to automatic detection", () => {
    setSearch("view=bogus");
    expect(isMobileView()).toBe(false);
    setCoarsePointer(true);
    setViewport(430, 932);
    expect(isMobileView()).toBe(true);
  });
});

describe("isMobileView exclusion under Tauri", () => {
  it("a Tauri environment is always the desktop view, which not even an override can change", () => {
    tauriWindow.__TAURI_INTERNALS__ = {};
    setCoarsePointer(true);
    setViewport(430, 932);
    setSearch("view=mobile");
    expect(isMobileView()).toBe(false);
  });
});
