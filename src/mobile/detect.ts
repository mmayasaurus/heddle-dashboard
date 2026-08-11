//! Select the mobile layout only outside Tauri and when explicitly requested or on a narrow touch device.
//!
//! This decision is made once at startup where main.tsx branches. Resizing does not switch layouts:
//! desktop keeps every terminal mounted, while mobile mounts a single terminal at a time, so a live
//! switch would corrupt xterm ownership. Screen rotation therefore does not change the selected view.

/** Persistent view override: "mobile" or "desktop". When unset, detect the device automatically. */
const VIEW_KEY = "vlx-view-mode";

export function isMobileView(): boolean {
  if (typeof window === "undefined") return false;
  // Desktop shells never use the mobile view. Tauri (`__TAURI_INTERNALS__`, including remote wry
  // WebViews) and Electron (`__VLX_ELECTRON__`, injected by preload) are always desktop contexts.
  if ("__TAURI_INTERNALS__" in window || "__VLX_ELECTRON__" in window) return false;
  // Manual override: the `?view=desktop|mobile` query parameter takes precedence over localStorage.
  const param = new URLSearchParams(window.location.search).get("view");
  if (param === "mobile") return true;
  if (param === "desktop") return false;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(VIEW_KEY);
  } catch {
    /* Treat unavailable localStorage as no override. */
  }
  if (stored === "mobile") return true;
  if (stored === "desktop") return false;
  // Auto-detect a coarse pointer and a viewport shorter side below 768px. Tablets can opt in manually.
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return coarse && shortSide < 768;
}

/**
 * Persist a view override and reload after removing `?view=` so the URL cannot keep overriding
 * localStorage. Used by the mobile header's desktop-view action; tablet users can also enter via
 * `?view=mobile` and then persist their preferred view.
 */
export function applyViewOverride(mode: "mobile" | "desktop"): void {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* If storage is unavailable, this reload falls back to automatic detection without a query override. */
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("view");
  window.location.replace(url.toString());
}
