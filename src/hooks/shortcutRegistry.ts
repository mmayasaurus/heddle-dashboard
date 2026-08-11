//! Customizable global shortcut registry + combo key encode/decode utilities.
//!
//! Design:
//! - "mod" is a cross-platform modifier abstraction: Cmd (metaKey) on macOS, Ctrl on other platforms.
//!   Both `e.metaKey || e.ctrlKey` count as mod, consistent with useKeyboardShortcuts.
//! - Combos are encoded as strings in canonical order: `mod[+shift][+alt]+<letter>` (lowercase).
//!   e.g. "mod+t", "mod+w", "mod+shift+f", "mod+shift+b". mod is always included; main key is
//!   limited to a single letter (A-Z). Numeric keys and +/-/0 are reserved for structural shortcuts
//!   (Cmd/Ctrl+1~9 tab switching, Cmd/Ctrl++/- font size) and are not customizable, to avoid conflicts.
//! - Only "primary function" shortcuts can be registered and customized here.

/** Customizable shortcut action ids. */
export type ShortcutAction =
  | "openProject"
  | "newTab"
  | "newBrowserTab"
  | "closePane"
  | "splitRight"
  | "splitDown"
  | "search"
  | "globalSearch"
  | "saveDoc";

/** Action order for the settings UI (newBrowserTab only shown on desktop, gated by isTauri). */
export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  "openProject",
  "newTab",
  "newBrowserTab",
  "splitRight",
  "splitDown",
  "closePane",
  "search",
  "globalSearch",
  "saveDoc",
];

/** Whether the current platform is macOS (for default keymaps and display symbol selection). */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

/**
 * Default keybindings per platform:
 * - macOS: Cmd+key (split up/down: Cmd+Shift+D, global search: Cmd+Shift+F).
 * - Windows/Linux: Ctrl+Alt+key. Bare Ctrl+letter is a shell reserved key (Ctrl+D=EOF,
 *   Ctrl+W=delete-word...), Ctrl+Shift is swallowed by IMEs, Alt is terminal Meta.
 *   Only Ctrl+Alt reliably reaches the web without conflicts.
 *   Split: D=right / E=up-down. Global search: G (global) vs inline search F.
 *   Save remains bare Ctrl+S (intercepted only on doc tabs; reserved as XOFF in terminals).
 *   When the terminal is focused, these Ctrl+Alt combos are intercepted by usePtySession's
 *   customKeyEventHandler to prevent xterm from treating them as Meta (see APP_ALT_KEYS).
 *   Users can override individual bindings via shortcutOverrides in settings.
 *   Recorded combos are platform-independent "mod[+shift][+alt]+key" strings.
 */
export const DEFAULT_BINDINGS: Record<ShortcutAction, string> = IS_MAC
  ? {
      openProject: "mod+o",
      newTab: "mod+t",
      newBrowserTab: "mod+shift+b",
      closePane: "mod+w",
      splitRight: "mod+d",
      splitDown: "mod+shift+d",
      search: "mod+f",
      globalSearch: "mod+shift+f",
      saveDoc: "mod+s",
    }
  : {
      openProject: "mod+alt+o",
      newTab: "mod+alt+t",
      newBrowserTab: "mod+alt+b",
      closePane: "mod+alt+w",
      splitRight: "mod+alt+d",
      splitDown: "mod+alt+e",
      search: "mod+alt+f",
      globalSearch: "mod+alt+g",
      saveDoc: "mod+s",
    };

interface ParsedCombo {
  shift: boolean;
  alt: boolean;
  /** Main key: a single lowercase letter. */
  key: string;
}

/** Parse a combo string into structured parts. Returns empty key on empty/invalid input. */
function parseCombo(combo: string): ParsedCombo {
  if (!combo) return { shift: false, alt: false, key: "" };
  const tokens = combo.split("+");
  return {
    shift: tokens.includes("shift"),
    alt: tokens.includes("alt"),
    key: tokens[tokens.length - 1] ?? "",
  };
}

/** Match a letter key, handling both e.key and e.code to avoid IME "Process" issues. */
function isLetter(e: KeyboardEvent, letter: string): boolean {
  return e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`;
}

/**
 * Check whether a keyboard event matches a combo.
 * Requirements: mod (meta or ctrl) pressed, shift/alt state matches exactly, main key matches.
 */
export function matchCombo(e: KeyboardEvent, combo: string): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  const c = parseCombo(combo);
  if (!c.key) return false;
  if (e.shiftKey !== c.shift) return false;
  if (e.altKey !== c.alt) return false;
  return isLetter(e, c.key);
}

/**
 * Record a combo string from a keyboard event.
 * Must have mod held and main key is a single letter A-Z, otherwise returns null.
 * Prefers physical key code (e.code "KeyX") over e.key for layout-independence.
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  let letter: string | null = null;
  const m = /^Key([A-Z])$/.exec(e.code);
  if (m) letter = m[1].toLowerCase();
  else if (/^[a-zA-Z]$/.test(e.key)) letter = e.key.toLowerCase();
  if (!letter) return null;
  const parts = ["mod"];
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(letter);
  return parts.join("+");
}

/** Format a combo string for display: macOS uses symbols (⌘⇧F), others use + (Ctrl+Shift+F). */
export function formatCombo(combo: string): string {
  const c = parseCombo(combo);
  const parts: string[] = [];
  parts.push(IS_MAC ? "\u2318" : "Ctrl");
  if (c.shift) parts.push(IS_MAC ? "\u21E7" : "Shift");
  if (c.alt) parts.push(IS_MAC ? "\u2325" : "Alt");
  parts.push(c.key.toUpperCase());
  return parts.join(IS_MAC ? "" : "+");
}
