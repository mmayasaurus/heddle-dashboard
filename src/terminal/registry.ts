//! Terminal-instance registry giving shortcut actions access to xterm instances. usePtySession creates
//! and registers them by sessionId.

import type { SearchAddon } from "@xterm/addon-search";
import type { ITheme, Terminal } from "@xterm/xterm";

import { ptyRedraw } from "../ipc/commands";

const registry = new Map<string, Terminal>();
const searchAddons = new Map<string, SearchAddon>();
// Per-session hard-redraw callbacks registered by usePtySession, which alone owns the fit addon,
// sizing mode, and PTY channel. Refresh prefers this complete manual-resize path.
const redrawHandlers = new Map<string, () => void>();

export function registerTerminal(id: string, term: Terminal) {
  registry.set(id, term);
}

export function unregisterTerminal(id: string, term: Terminal) {
  // Remove only the same registered instance so restart reconstruction cannot delete its replacement.
  if (registry.get(id) === term) {
    registry.delete(id);
    osc52Copies.delete(id);
  }
}

export function clearTerminal(id: string) {
  registry.get(id)?.clear();
}

export function focusTerminal(id: string) {
  registry.get(id)?.focus();
}

/** Register/unregister a usePtySession hard-redraw callback. Identity checking prevents teardown of an
 * old instance from removing its replacement, matching unregisterTerminal. */
export function registerRedraw(id: string, fn: () => void) {
  redrawHandlers.set(id, fn);
}
export function unregisterRedraw(id: string, fn: () => void) {
  if (redrawHandlers.get(id) === fn) redrawHandlers.delete(id);
}

/** Manual full-screen redraw. Prefer usePtySession's hard-redraw callback, which performs the complete
 * manual-resize recovery for three corruption classes:
 *
 *  1. Grid drift: refit to the container and send a real PTY resize/SIGWINCH when rows or columns change.
 *     A frontend-only refresh cannot repair a mismatched terminal grid.
 *  2. Content corruption rendered under old dimensions: `ptyRedraw` pulses SIGWINCH so a full-screen
 *     TUI resends its screen even when fit is otherwise a no-op.
 *  3. Renderer defects such as missing cells, offsets, or ghosts: `term.refresh` redraws the buffer,
 *     then a one-line scroll round trip forces viewport recalculation.
 *
 * If no callback was registered because of early startup or failure, fall back to frontend redraw plus
 * backend resize pulse, covering only cases 2 and 3. */
export function redrawTerminal(id: string) {
  const handler = redrawHandlers.get(id);
  if (handler) {
    handler();
    return;
  }
  const term = registry.get(id);
  if (!term) return;
  try {
    term.refresh(0, term.rows - 1);
    // Force viewport recalculation with a one-line round trip and zero net movement.
    term.scrollLines(-1);
    term.scrollLines(1);
  } catch {
    /* Ignore rare refresh/scroll failures. */
  }
  ptyRedraw(id).catch(() => {});
}

/** Return a session's xterm instance for mobile buffer reads and `.xterm-screen` coordinate measurement. */
export function getTerminal(id: string): Terminal | undefined {
  return registry.get(id);
}

// ─── Context-menu terminal actions: copy, paste, and select all ───

/** Return selected text, or an empty string when none. */
export function getSelection(id: string): string {
  return registry.get(id)?.getSelection() ?? "";
}

/** Whether selected text exists and the Copy action should be enabled. */
export function hasSelection(id: string): boolean {
  return registry.get(id)?.hasSelection() ?? false;
}

// ─── OSC 52 drag-to-copy tracking for TUIs ───
// Mouse-reporting TUIs manage selection outside xterm.getSelection() but write it to the system clipboard
// through OSC 52. Track the latest copied character count so the context menu can explain that copying
// already occurred instead of showing a disabled action. This is behavior-based and works for any TUI.
const osc52Copies = new Map<string, { len: number; at: number }>();

/** Record an OSC 52 automatic copy length reported by usePtySession's clipboard provider. */
export function noteOsc52Copy(id: string, len: number) {
  if (len > 0) osc52Copies.set(id, { len, at: Date.now() });
}

/** Return the latest OSC 52 copy length, or null after maxAgeMs (60 seconds by default). */
export function recentOsc52Copy(id: string, maxAgeMs = 60_000): number | null {
  const rec = osc52Copies.get(id);
  if (!rec || Date.now() - rec.at > maxAgeMs) return null;
  return rec.len;
}

/** Select all terminal content. */
export function selectAll(id: string) {
  registry.get(id)?.selectAll();
}

/** Paste text through onData into PTY input, matching keyboard paste. */
export function pasteToTerminal(id: string, text: string) {
  registry.get(id)?.paste(text);
}

/** Whether DECCKM application-cursor mode is active, selecting SS3 versus CSI for mobile arrow keys. */
export function isAppCursorMode(id: string): boolean {
  return registry.get(id)?.modes.applicationCursorKeysMode ?? false;
}

/** Update colors on every live terminal after a theme change. */
export function setXtermTheme(theme: ITheme) {
  for (const term of registry.values()) {
    term.options.theme = theme;
  }
}

/** Session IDs with registered xterm instances and running PTYs, used to notify agents of theme changes. */
export function liveTerminalIds(): string[] {
  return [...registry.keys()];
}

// ─── Terminal search ───

export function registerSearch(id: string, addon: SearchAddon) {
  searchAddons.set(id, addon);
}

export function unregisterSearch(id: string, addon: SearchAddon) {
  if (searchAddons.get(id) === addon) searchAddons.delete(id);
}

const SEARCH_OPTS = {
  decorations: {
    matchBackground: "#d29922",
    activeMatchBackground: "#f0883e",
    matchOverviewRuler: "#d29922",
    activeMatchColorOverviewRuler: "#f0883e",
  },
};

/** Find the next match in the active terminal and report success for global-search fallback decisions. */
export function findNext(id: string, query: string): boolean {
  return searchAddons.get(id)?.findNext(query, SEARCH_OPTS) ?? false;
}

export function findPrevious(id: string, query: string): boolean {
  return searchAddons.get(id)?.findPrevious(query, SEARCH_OPTS) ?? false;
}

export function clearSearch(id: string) {
  searchAddons.get(id)?.clearDecorations();
}
