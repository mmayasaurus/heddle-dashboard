//! Pure calculations for mobile touch selection: pixel/buffer conversion, word selection, highlight
//! rectangles, handle anchors, and text extraction.
//!
//! Everything uses public xterm APIs and DOM measurements, never internal fields. Built-in selection
//! may be disabled for Claude sessions, but buffer access and `.xterm-screen` measurement remain valid:
//! - `.xterm-screen.getBoundingClientRect()` includes mirror-mode CSS scaling; dividing by terminal
//!   columns and rows yields scale-independent cell dimensions.
//! - The top visible absolute buffer row is `term.buffer.active.viewportY`.
//! - Text comes from `buffer.active.getLine(absRow)?.translateToString(trimRight, startCol, endCol)`.

import type { Terminal } from "@xterm/xterm";

/** Buffer coordinate `[absolute row, column]`, with inclusive columns from 0 to cols - 1. */
export type Pt = [number, number];

/** Highlight rectangle in pixels relative to the wrapper. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Selection-handle anchor at a cell's bottom edge, in wrapper-relative pixels. */
export interface HandleAnchor {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Return the terminal grid DOM element (`.xterm-screen`). */
export function screenOf(wrap: HTMLElement): HTMLElement | null {
  return wrap.querySelector<HTMLElement>(".xterm-screen");
}

/** Return on-screen cell dimensions including mirror scaling, or null when unmeasurable. */
function cellSize(term: Terminal, screen: HTMLElement) {
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { rect, cw: rect.width / term.cols, ch: rect.height / term.rows };
}

/** Convert a viewport pixel to a buffer coordinate with clamped columns and absolute rows. */
export function pointToCell(
  term: Terminal,
  screen: HTMLElement,
  clientX: number,
  clientY: number,
): Pt | null {
  const cs = cellSize(term, screen);
  if (!cs) return null;
  const col = clamp(Math.floor((clientX - cs.rect.left) / cs.cw), 0, term.cols - 1);
  const vrow = clamp(Math.floor((clientY - cs.rect.top) / cs.ch), 0, term.rows - 1);
  return [term.buffer.active.viewportY + vrow, col];
}

/** Order two inclusive points by row then column. */
export function order(a: Pt, b: Pt): { start: Pt; end: Pt } {
  if (a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])) return { start: a, end: b };
  return { start: b, end: a };
}

/** Select the contiguous non-whitespace word at a cell, or only that cell when it is whitespace. */
export function wordAt(term: Terminal, pt: Pt): { start: Pt; end: Pt } {
  const [row, col] = pt;
  const line = term.buffer.active.getLine(row);
  const str = line ? line.translateToString(false) : "";
  const isSpace = (i: number) => {
    const ch = str[i];
    return ch === undefined || ch === " " || ch === "\t" || ch === " ";
  };
  if (isSpace(col)) return { start: [row, col], end: [row, col] };
  let s = col;
  let e = col;
  while (s > 0 && !isSpace(s - 1)) s--;
  while (e < term.cols - 1 && !isSpace(e + 1)) e++;
  return { start: [row, s], end: [row, e] };
}

/** Build highlight rectangles for visible rows; inclusive endpoints extend through the final cell. */
export function selectionRects(
  term: Terminal,
  screen: HTMLElement,
  wrap: HTMLElement,
  start: Pt,
  end: Pt,
): Rect[] {
  const cs = cellSize(term, screen);
  if (!cs) return [];
  const wrapRect = wrap.getBoundingClientRect();
  const offX = cs.rect.left - wrapRect.left;
  const offY = cs.rect.top - wrapRect.top;
  const top = term.buffer.active.viewportY;
  const bottom = top + term.rows - 1;
  const rects: Rect[] = [];
  for (let row = start[0]; row <= end[0]; row++) {
    if (row < top || row > bottom) continue;
    const c0 = row === start[0] ? start[1] : 0;
    const c1 = (row === end[0] ? end[1] : term.cols - 1) + 1; // Exclusive right edge.
    const vi = row - top;
    rects.push({
      x: offX + c0 * cs.cw,
      y: offY + vi * cs.ch,
      w: (c1 - c0) * cs.cw,
      h: cs.ch,
    });
  }
  return rects;
}

/** Return endpoint handle anchors at cell bottoms, or null for endpoints outside the viewport. */
export function handleAnchors(
  term: Terminal,
  screen: HTMLElement,
  wrap: HTMLElement,
  start: Pt,
  end: Pt,
): { start: HandleAnchor | null; end: HandleAnchor | null } {
  const cs = cellSize(term, screen);
  if (!cs) return { start: null, end: null };
  const wrapRect = wrap.getBoundingClientRect();
  const offX = cs.rect.left - wrapRect.left;
  const offY = cs.rect.top - wrapRect.top;
  const top = term.buffer.active.viewportY;
  const bottom = top + term.rows - 1;
  const anchor = (pt: Pt, rightEdge: boolean): HandleAnchor | null => {
    if (pt[0] < top || pt[0] > bottom) return null;
    const col = rightEdge ? pt[1] + 1 : pt[1];
    return { x: offX + col * cs.cw, y: offY + (pt[0] - top + 1) * cs.ch };
  };
  return { start: anchor(start, false), end: anchor(end, true) };
}

/** Extract inclusive selection text, joining wrapped rows and adding newlines only for hard breaks. */
export function selectionText(term: Terminal, start: Pt, end: Pt): string {
  const buf = term.buffer.active;
  const parts: string[] = [];
  for (let row = start[0]; row <= end[0]; row++) {
    const line = buf.getLine(row);
    if (!line) continue;
    const c0 = row === start[0] ? start[1] : 0;
    const c1 = (row === end[0] ? end[1] : term.cols - 1) + 1;
    const seg = line.translateToString(true, c0, c1);
    parts.push(seg);
    if (row < end[0]) {
      // Do not add a newline before a wrapped continuation; hard line breaks retain one.
      const next = buf.getLine(row + 1);
      parts.push(next?.isWrapped ? "" : "\n");
    }
  }
  return parts.join("");
}
