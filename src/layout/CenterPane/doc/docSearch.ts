//! Unified document-search contract. Both editors—WYSIWYG Milkdown and source CodeMirror—implement the same
//! DocSearchControl, which DocSearchBar drives for identical interactions and match counting.

/** Search state: total is the match count; current is the one-based active match index, or zero with no matches. */
export interface SearchStatus {
  total: number;
  current: number;
}

/** Empty state returned while the editor is unavailable or no matches exist, avoiding scattered null checks. */
export const EMPTY_STATUS: SearchStatus = { total: 0, current: 0 };

/** Search-control interface shared by both editors. Replacement text is passed to replace at call time; each
 *  editor receives and retains the query and case-sensitivity setting when apply is called. */
export interface DocSearchControl {
  /** Set the query, recompute matches, and move to the first match after the cursor. */
  apply(opts: { query: string; caseSensitive: boolean }): SearchStatus;
  /** Move to the next match, wrapping from the end to the first. */
  next(): SearchStatus;
  /** Move to the previous match, wrapping from the beginning to the last. */
  prev(): SearchStatus;
  /** Replace the current match, then move to the next one. */
  replace(replaceText: string): SearchStatus;
  /** Replace all matches. */
  replaceAll(replaceText: string): SearchStatus;
  /** Clear search state and highlights when the search bar closes. */
  clear(): void;
}
