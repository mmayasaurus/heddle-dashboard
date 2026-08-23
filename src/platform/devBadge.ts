//! Pure Dock-badge decision logic shared by the platform badge setter (HED-159).
//!
//! Debug/dev builds keep a persistent "DEV" Dock badge so a running dev instance is visually
//! distinguishable from the installed release app; the unread count folds in when non-zero. The macOS
//! Dock badge is a single shared slot also driven by the unread-notification count, so this decision
//! lives with the count setter rather than a separate native call that the count would clobber (the
//! notification hook's `setCount(0)` on mount would otherwise blank a startup-set badge).
//!
//! Kept pure (no Tauri imports) so the whole decision — macOS gating, dev gating, and count
//! preservation off macOS — is unit-testable without mocking the window API.

/// The macOS Dock badge *label* a dev build should show, or `null` when the caller should fall back to
/// the normal numeric badge (release builds, or any non-dev context). `count` is the unread total.
export function devDockBadgeLabel(count: number | undefined, isDev: boolean): string | null {
  if (!isDev) return null;
  return count && count > 0 ? `DEV · ${count}` : "DEV";
}

/** What the badge setter should invoke: a macOS text label, or the cross-platform numeric badge. */
export type DockBadgeAction =
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "count"; readonly count: number | undefined };

/**
 * Decide how to render the Dock badge for `count` unread.
 *
 * `setBadgeLabel` is macOS-only (and needs its own ACL), so the persistent "DEV" label is used ONLY on
 * macOS dev builds; every other case — non-macOS (any build) and macOS release — keeps the numeric
 * badge, so unread counts are never lost off macOS. `undefined` count clears the numeric badge.
 */
export function dockBadgeAction(
  count: number | undefined,
  isMac: boolean,
  isDev: boolean,
): DockBadgeAction {
  const label = isMac ? devDockBadgeLabel(count, isDev) : null;
  if (label !== null) return { kind: "label", label };
  // Numeric badge: a count of 0 (or undefined) means "no badge", so clear it. Explicit check rather
  // than `count || undefined` so the intentional clearing at 0 is obvious, not a falsy-coercion
  // accident (corgea/codacy). count is always >= 0 (unread total).
  return { kind: "count", count: count === undefined || count === 0 ? undefined : count };
}
