import { useRef, type MouseEvent as ReactMouseEvent } from "react";

/**
 * Safe click-outside dismissal for modal backdrops: close only when both mouse-down and mouse-up occur on the
 * backdrop itself.
 *
 * Bug addressed: after selecting text inside a dialog and releasing a drag over the backdrop, the browser sends
 * the click to the nearest common ancestor of the press and release targets—the outer backdrop. The old handler
 * closed on any click received by the backdrop, so text selection could dismiss the dialog accidentally. This
 * hook also records whether the gesture began on the backdrop and closes only for a genuine outside click that
 * both starts and ends there.
 *
 * Usage: spread the return value onto the outermost backdrop div:
 *   const backdrop = useBackdropDismiss(onClose);
 *   <div {...backdrop} style={{ position: "fixed", inset: 0, ... }}>
 *     <div onClick={(e) => e.stopPropagation()}>…card…</div>
 *   </div>
 * The inner card's stopPropagation is optional because this hook already distinguishes a real outside click from
 * a drag that merely passes over the backdrop.
 */
export function useBackdropDismiss(onDismiss: () => void) {
  const downOnSelf = useRef(false);
  return {
    onMouseDown: (e: ReactMouseEvent) => {
      downOnSelf.current = e.target === e.currentTarget;
    },
    onClick: (e: ReactMouseEvent) => {
      if (e.target === e.currentTarget && downOnSelf.current) onDismiss();
    },
  };
}
