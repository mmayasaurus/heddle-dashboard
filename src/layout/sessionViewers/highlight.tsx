//! Case-insensitive keyword highlighting that wraps matching text fragments in <mark>.
//! Shared by transcript navigation and global-search snippets for a consistent appearance.
//!
//! Two backgrounds matching xterm recording search (see SEARCH_OPTS in RecordingViewer):
//! - match: amber #d29922, indicating another match that is not currently selected.
//! - active: brighter orange #f0883e, indicating the match currently being viewed.
//! Left-tree snippets and non-current matching messages use match; the current message in the right preview uses active.

import React from "react";

/** Regular-match background, matching xterm recording search's matchBackground #d29922. */
const MATCH_STYLE: React.CSSProperties = {
  backgroundColor: "rgba(210,153,34,0.40)",
  borderRadius: 2,
};

/** More prominent current-match background, matching xterm recording search's activeMatchBackground #f0883e. */
const ACTIVE_STYLE: React.CSSProperties = {
  backgroundColor: "rgba(240,136,62,0.62)",
  borderRadius: 2,
};

/**
 * Wrap every case-insensitive `query` occurrence in `text` with a highlighted <mark>, preserving all other text.
 * Return the original text for an empty query. `active=true` uses the more prominent current-match background.
 */
export function highlightMatches(
  text: string,
  query: string,
  active = false,
): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const style = active ? ACTIVE_STYLE : MATCH_STYLE;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const pos = lower.indexOf(ql, i);
    if (pos < 0) {
      out.push(text.slice(i));
      break;
    }
    if (pos > i) out.push(text.slice(i, pos));
    out.push(
      <mark key={key++} style={style}>
        {text.slice(pos, pos + q.length)}
      </mark>,
    );
    i = pos + q.length;
  }
  return out;
}
