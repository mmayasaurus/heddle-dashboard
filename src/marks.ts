//! Node markers: the fixed emoji palette offered in context menus plus the helpers shared by the sidebar tree,
//! its filter control, and the session/group/project menus.
//!
//! The persisted value is the emoji itself rather than an enumerated code, so a marker written by a newer build
//! still displays and round-trips here. Only this palette is offered in the UI; anything else is treated as a
//! valid but unlabeled marker.

import type { I18nKey } from "./i18n";

/** Marker palette shown in menus and the filter, in display order. */
export const NODE_MARKS = ["🔥", "⭐", "🐛", "✅", "🚧", "📌", "💡", "⚠️"] as const;

export type NodeMark = (typeof NODE_MARKS)[number];

/** Menu/filter label for each marker; also used as the tooltip on a marked row. */
export const MARK_LABEL_KEYS: Record<NodeMark, I18nKey> = {
  "🔥": "mark.urgent",
  "⭐": "mark.important",
  "🐛": "mark.bug",
  "✅": "mark.done",
  "🚧": "mark.wip",
  "📌": "mark.pinned",
  "💡": "mark.idea",
  "⚠️": "mark.caution",
};

/** Normalize a stored marker to a comparable string; unmarked nodes collapse to an empty string. */
export function normalizeMark(mark?: string | null): string {
  return (mark ?? "").trim();
}

/** Whether a node carries the given marker. An empty filter matches everything. */
export function hasMark(nodeMark: string | null | undefined, filter: string | null): boolean {
  if (!filter) return true;
  return normalizeMark(nodeMark) === filter;
}
