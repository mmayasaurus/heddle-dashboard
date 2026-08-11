//! Unified mobile terminal touch layer for scrolling, opening the keyboard, and long-press word
//! selection/copying. One hook exclusively owns capture listeners on the wrapper and suppresses all
//! synthetic mouse reporting to prevent competing gesture layers.
//!
//! See touchSelect.ts and the architecture notes for mouse suppression. Gestures:
//! - Vertical swipes synthesize WheelEvents into xterm's existing path: SGR reporting for Claude,
//!   arrow keys on alternate screens without scrollback, or viewport scrolling. Mirror scaling adjusts delta.
//! - Taps focus the terminal to open the soft keyboard after xterm's mousedown behavior is suppressed.
//! - Long presses select a word, expose draggable endpoints and copy/cancel controls, and use public
//!   buffer APIs plus custom highlighting. Selection mode takes precedence over scrolling/focus.

import { useEffect, useRef, useState } from "react";
import { focusTerminal, getTerminal } from "../terminal/registry";
import { copyText } from "../ipc/info";
import {
  handleAnchors,
  order,
  pointToCell,
  screenOf,
  selectionRects,
  selectionText,
  wordAt,
  type HandleAnchor,
  type Pt,
  type Rect,
} from "./touchSelect";

/** Pixel movement threshold before a gesture becomes scrolling, preserving tap-to-focus. */
const PAN_SLOP = 8;
/** Long-press duration before entering selection mode, in milliseconds. */
const LONG_PRESS_MS = 450;
/** Wrapper-relative hit radius in pixels for grabbing a selection handle. */
const HANDLE_HIT = 30;

/** Overlay data returned for rendering selection mode. */
export interface SelectionOverlay {
  rects: Rect[];
  start: HandleAnchor | null;
  end: HandleAnchor | null;
}

export interface TouchTerminalApi {
  /** Selection overlay, or null outside selection mode. */
  overlay: SelectionOverlay | null;
  /** Copy the current selection and exit selection mode. */
  copy: () => void;
  /** Exit selection mode without copying. */
  cancel: () => void;
}

export function useTouchTerminal(
  wrapRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string,
): TouchTerminalApi {
  const [overlay, setOverlay] = useState<SelectionOverlay | null>(null);

  // Refs provide synchronous gesture and inclusive endpoint state inside listener closures; rendered data uses state.
  const startRef = useRef<Pt | null>(null);
  const endRef = useRef<Pt | null>(null);
  const overlayRef = useRef<SelectionOverlay | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const term = () => getTerminal(sessionRef.current);
    const screen = () => screenOf(wrap);

    let lastY = 0;
    let acc = 0;
    let panning = false;
    let longPressAt: number | null = null;
    let lpTimer: ReturnType<typeof setTimeout> | undefined;
    let dragging: "start" | "end" | null = null;

    const wrapRel = (clientX: number, clientY: number) => {
      const r = wrap.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    };

    /** Recompute the overlay from current endpoints and synchronize state. */
    const refresh = () => {
      const t = term();
      const sc = screen();
      const s = startRef.current;
      const e = endRef.current;
      if (!t || !sc || !s || !e) {
        overlayRef.current = null;
        setOverlay(null);
        return;
      }
      const { start, end } = order(s, e);
      const ov: SelectionOverlay = {
        rects: selectionRects(t, sc, wrap, start, end),
        ...handleAnchors(t, sc, wrap, start, end),
      };
      overlayRef.current = ov;
      setOverlay(ov);
    };

    const exitSelect = () => {
      startRef.current = null;
      endRef.current = null;
      dragging = null;
      overlayRef.current = null;
      setOverlay(null);
    };

    const enterSelectAt = (clientX: number, clientY: number) => {
      const t = term();
      const sc = screen();
      if (!t || !sc) return;
      const pt = pointToCell(t, sc, clientX, clientY);
      if (!pt) return;
      const w = wordAt(t, pt);
      startRef.current = w.start;
      endRef.current = w.end;
      dragging = null;
      refresh();
    };

    /** Whether a touch lies within a handle's hit radius. */
    const nearHandle = (clientX: number, clientY: number): "start" | "end" | null => {
      const ov = overlayRef.current;
      if (!ov) return null;
      const p = wrapRel(clientX, clientY);
      const hit = (a: HandleAnchor | null) =>
        !!a && Math.hypot(p.x - a.x, p.y - a.y) <= HANDLE_HIT;
      // Prefer the more commonly used end handle, then the start handle.
      if (hit(ov.end)) return "end";
      if (hit(ov.start)) return "start";
      return null;
    };

    const clearLongPress = () => {
      if (lpTimer) clearTimeout(lpTimer);
      lpTimer = undefined;
      longPressAt = null;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        clearLongPress();
        return;
      }
      const target = e.target as HTMLElement | null;
      // Yield completely to toolbar controls; their onClick handlers perform copy/cancel.
      if (target?.closest("[data-ctl]")) return;

      const { clientX, clientY } = e.touches[0];
      lastY = clientY;
      acc = 0;
      panning = false;

      if (overlayRef.current) {
        // In selection mode, grab a handle to drag it; touching elsewhere exits and continues normally.
        const h = nearHandle(clientX, clientY);
        if (h) {
          dragging = h;
          return;
        }
        exitSelect();
      }
      // If movement stays below threshold, long press selects a word and turns the still-down finger
      // into an end-handle drag. The user can extend immediately, then fine-tune handles after release.
      longPressAt = clientY;
      lpTimer = setTimeout(() => {
        if (longPressAt !== null) {
          enterSelectAt(clientX, clientY);
          if (overlayRef.current) dragging = "end";
        }
        lpTimer = undefined;
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const { clientX, clientY } = e.touches[0];

      // Update the corresponding endpoint while dragging a handle.
      if (dragging) {
        e.preventDefault();
        e.stopPropagation();
        const t = term();
        const sc = screen();
        if (!t || !sc) return;
        const pt = pointToCell(t, sc, clientX, clientY);
        if (!pt) return;
        if (dragging === "start") startRef.current = pt;
        else endRef.current = pt;
        // When endpoints cross, refresh orders them and swaps the dragged identity for continuity.
        const s = startRef.current!;
        const en = endRef.current!;
        if (s[0] > en[0] || (s[0] === en[0] && s[1] > en[1])) {
          startRef.current = en;
          endRef.current = s;
          dragging = dragging === "start" ? "end" : "start";
        }
        refresh();
        return;
      }

      // Do not scroll in selection mode unless a handle is being dragged.
      if (overlayRef.current) return;

      let dy = lastY - clientY;
      lastY = clientY;
      if (!panning) {
        acc += dy;
        if (Math.abs(acc) < PAN_SLOP) return;
        // Crossing the threshold starts scrolling, cancels long press, and applies accumulated movement.
        panning = true;
        clearLongPress();
        dy = acc;
      }
      // Prevent native pan/bounce and xterm touch handling, also suppressing synthetic mouse events.
      e.preventDefault();
      e.stopPropagation();
      const xtermEl = wrap.querySelector<HTMLElement>(".xterm");
      if (!xtermEl || dy === 0) return;
      // In mirror mode divide visual-pixel movement by CSS scale to recover content-pixel delta.
      let k = 1;
      const tf = xtermEl.parentElement
        ? getComputedStyle(xtermEl.parentElement).transform
        : "none";
      if (tf && tf !== "none") {
        const m = tf.match(/matrix\(([^,]+),/);
        const parsed = m ? parseFloat(m[1]) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) k = parsed;
      }
      xtermEl.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: dy / k,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      );
    };

    const onTouchEnd = (e: TouchEvent) => {
      clearLongPress();
      if (dragging) {
        dragging = null;
        return;
      }
      if (panning) {
        panning = false;
        return;
      }
      if (overlayRef.current) return; // Stray touches during selection do not claim focus.
      // A tap opens the keyboard; control touches returned early from touchstart.
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-ctl]")) return;
      focusTerminal(sessionRef.current);
    };

    // Consume synthetic mouse events so coordinate-encoded ghost clicks cannot trigger agent menus.
    const swallowMouse = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-ctl]")) return; // Allow toolbar button clicks.
      e.preventDefault();
      e.stopPropagation();
    };

    wrap.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    wrap.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    wrap.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    wrap.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
    for (const type of ["mousedown", "mousemove", "mouseup", "contextmenu"] as const) {
      wrap.addEventListener(type, swallowMouse, { capture: true });
    }
    return () => {
      clearLongPress();
      wrap.removeEventListener("touchstart", onTouchStart, { capture: true });
      wrap.removeEventListener("touchmove", onTouchMove, { capture: true });
      wrap.removeEventListener("touchend", onTouchEnd, { capture: true });
      wrap.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      for (const type of ["mousedown", "mousemove", "mouseup", "contextmenu"] as const) {
        wrap.removeEventListener(type, swallowMouse, { capture: true });
      }
    };
    // wrapRef is stable and sessionRef carries sessionId without reinstalling listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapRef]);

  // Clear stale selection on session changes as a fallback beyond normal key-based remounting.
  useEffect(() => {
    startRef.current = null;
    endRef.current = null;
    overlayRef.current = null;
    setOverlay(null);
  }, [sessionId]);

  const cancel = () => {
    startRef.current = null;
    endRef.current = null;
    overlayRef.current = null;
    setOverlay(null);
  };

  const copy = () => {
    const t = getTerminal(sessionId);
    const s = startRef.current;
    const e = endRef.current;
    if (t && s && e) {
      const { start, end } = order(s, e);
      const text = selectionText(t, start, end);
      if (text) void copyText(text);
    }
    cancel();
  };

  return { overlay, copy, cancel };
}
