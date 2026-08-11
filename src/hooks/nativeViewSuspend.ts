//! Global overlay-suspension signal for native child views (Electron WebContentsView / Tauri WKWebView browser).
//!
//! Built-in browser tabs are **native child views** attached to the main window by the host process. In both
//! Electron and Tauri, they always render above the Web DOM. DOM overlays such as context menus and modals are
//! therefore covered wherever they intersect the native view, appearing sharply cut off (architecture document
//! §17). DOM cannot render over native views; this is a platform constraint.
//!
//! When an overlay appears, temporarily hide the currently visible native browser view with setVisible(false),
//! restoring it afterward. This module maintains only a reference-counted global switch; BrowserView remains the
//! sole authority for its own native view visibility (visible when its tab is active and no overlay suspends it).
//! This avoids races across both shells and touches only the truly visible view, so hidden browser tabs do not flash.

import { useEffect, useSyncExternalStore } from "react";

/** Number of active suspending overlays; restore only after every nested overlay closes. */
let depth = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Enter a DOM overlay covering the center pane: increment and notify BrowserView when the first appears. */
function push(): void {
  depth += 1;
  if (depth === 1) emit();
}

/** Leave an overlay: decrement and notify BrowserView when the final one closes. */
function pop(): void {
  if (depth === 0) return;
  depth -= 1;
  if (depth === 0) emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): boolean {
  return depth > 0;
}

/** Reactively read whether any overlay suspends views; BrowserView combines it with hidden to decide visibility. */
export function useNativeViewSuspended(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Hook for overlay components: suspend native views while `active`, restoring when false or unmounted.
 * - Conditionally mounted overlays such as ContextMenu/Backdrop call `useSuspendNativeViews()` directly.
 * - Persistently mounted overlays that return null while hidden, such as MergeModal, pass their visibility boolean.
 */
export function useSuspendNativeViews(active = true): void {
  useEffect(() => {
    if (!active) return;
    push();
    return () => pop();
  }, [active]);
}
