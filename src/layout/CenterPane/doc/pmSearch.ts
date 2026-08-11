//! Lightweight find-and-replace plugin and control functions for Milkdown (ProseMirror).
//!
//! ProseMirror has no built-in search, so decorations highlight all matches and emphasize the active
//! one. Matching stays within individual text nodes; formatting boundaries may split a match, which
//! is acceptable for basic search and keeps coordinates reliable. Import all ProseMirror pieces from
//! `@milkdown/kit/prose/*` to share Milkdown's instances, otherwise decorations do not work.

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { EMPTY_STATUS, type SearchStatus } from "./docSearch";

export const pmSearchKey = new PluginKey("vlxDocSearch");

interface Match {
  from: number;
  to: number;
}
interface PMSearchState {
  query: string;
  caseSensitive: boolean;
  matches: Match[];
  current: number; // Zero-based index, or -1 when there are no matches.
}

const EMPTY_STATE: PMSearchState = { query: "", caseSensitive: false, matches: [], current: -1 };

/** Find every query occurrence within each text node; position is node start plus string offset. */
function findMatches(doc: PMNode, query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const len = query.length;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const raw = node.text ?? "";
    const hay = caseSensitive ? raw : raw.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      matches.push({ from: pos + idx, to: pos + idx + len });
      idx = hay.indexOf(needle, idx + len);
    }
  });
  return matches;
}

/** Recompute matches and select the first after preferPos, wrapping to the first match. */
function compute(
  doc: PMNode,
  query: string,
  caseSensitive: boolean,
  preferPos: number,
): PMSearchState {
  const matches = findMatches(doc, query, caseSensitive);
  let current = -1;
  if (matches.length) {
    current = matches.findIndex((m) => m.from >= preferPos);
    if (current === -1) current = 0;
  }
  return { query, caseSensitive, matches, current };
}

/** Search plugin that tracks matches and the active item, renders decorations, and recomputes after edits. */
export function pmSearchPlugin(): Plugin {
  return new Plugin<PMSearchState>({
    key: pmSearchKey,
    state: {
      init: () => EMPTY_STATE,
      apply(tr, prev, _old, newState) {
        const meta = tr.getMeta(pmSearchKey) as
          | { type: "set"; query: string; caseSensitive: boolean; preferPos: number }
          | { type: "nav"; current: number }
          | { type: "clear" }
          | undefined;
        if (meta) {
          if (meta.type === "set")
            return compute(newState.doc, meta.query, meta.caseSensitive, meta.preferPos);
          if (meta.type === "clear") return EMPTY_STATE;
          if (meta.type === "nav") {
            if (!prev.matches.length) return prev;
            return { ...prev, current: meta.current };
          }
        }
        // After edits, including replacement, recompute with the stored query and follow the selection.
        if (tr.docChanged && prev.query)
          return compute(newState.doc, prev.query, prev.caseSensitive, newState.selection.head);
        return prev;
      },
    },
    props: {
      decorations(state) {
        const s = pmSearchKey.getState(state) as PMSearchState | undefined;
        if (!s || !s.matches.length) return DecorationSet.empty;
        const decos = s.matches.map((m, i) =>
          Decoration.inline(m.from, m.to, {
            class: i === s.current ? "vlx-pm-match vlx-pm-match-current" : "vlx-pm-match",
          }),
        );
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

function status(s: PMSearchState | undefined): SearchStatus {
  if (!s || !s.matches.length) return EMPTY_STATUS;
  return { total: s.matches.length, current: s.current + 1 };
}

/** Center the active match by scrolling its decoration DOM directly. ProseMirror's scrollIntoView
 * gives up when the DOM selection is outside the editor, as it is while the search field has focus.
 * Decorations reach the DOM synchronously after dispatch, so the active element is immediately available. */
function scrollCurrentMatchIntoView(view: EditorView) {
  const el = view.dom.querySelector(".vlx-pm-match-current");
  if (el) (el as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
}

export function pmApply(view: EditorView, query: string, caseSensitive: boolean): SearchStatus {
  view.dispatch(
    view.state.tr.setMeta(pmSearchKey, {
      type: "set",
      query,
      caseSensitive,
      preferPos: view.state.selection.head,
    }),
  );
  const s = pmSearchKey.getState(view.state) as PMSearchState | undefined;
  if (s && s.current >= 0) scrollCurrentMatchIntoView(view);
  return status(s);
}

function navigate(view: EditorView, dir: 1 | -1): SearchStatus {
  const s = pmSearchKey.getState(view.state) as PMSearchState | undefined;
  if (!s || !s.matches.length) return EMPTY_STATUS;
  const n = s.matches.length;
  const current = (s.current + dir + n) % n;
  // Update only the active item; changing an unfocused editor selection would not scroll and could disturb focus.
  view.dispatch(view.state.tr.setMeta(pmSearchKey, { type: "nav", current }));
  scrollCurrentMatchIntoView(view);
  return { total: n, current: current + 1 };
}

export const pmNext = (view: EditorView) => navigate(view, 1);
export const pmPrev = (view: EditorView) => navigate(view, -1);

export function pmReplace(view: EditorView, replaceText: string): SearchStatus {
  const s = pmSearchKey.getState(view.state) as PMSearchState | undefined;
  if (!s || !s.matches.length || s.current < 0) return status(s);
  const m = s.matches[s.current];
  const tr = view.state.tr.insertText(replaceText, m.from, m.to);
  // Recompute against the new document and select the next match after the replacement.
  tr.setMeta(pmSearchKey, {
    type: "set",
    query: s.query,
    caseSensitive: s.caseSensitive,
    preferPos: m.from + replaceText.length,
  });
  view.dispatch(tr);
  const s2 = pmSearchKey.getState(view.state) as PMSearchState | undefined;
  if (s2 && s2.current >= 0) scrollCurrentMatchIntoView(view);
  return status(s2);
}

export function pmReplaceAll(view: EditorView, replaceText: string): SearchStatus {
  const s = pmSearchKey.getState(view.state) as PMSearchState | undefined;
  if (!s || !s.matches.length) return status(s);
  let tr = view.state.tr;
  // Replace backward so later edits do not shift earlier match positions.
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i];
    tr = tr.insertText(replaceText, m.from, m.to);
  }
  view.dispatch(tr);
  return status(pmSearchKey.getState(view.state) as PMSearchState | undefined);
}

export function pmClear(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(pmSearchKey, { type: "clear" }));
}
