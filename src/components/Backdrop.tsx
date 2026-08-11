//! Modal backdrop shell that standardizes the outer structure and click-outside behavior of full-screen-backdrop,
//! centered-card dialogs.
//!
//! Previously, every dialog hand-wrote its backdrop div (position:fixed, inset:0, centering, and onClick close).
//! Besides duplication, that pattern made it easy to dismiss a dialog accidentally while dragging a text
//! selection (see useBackdropDismiss). Centralizing the shell here makes new dialogs safe by default with only
//! `<Backdrop onClose={...}>…card…</Backdrop>`.
//!
//! Props cover variants: zIndex controls stacking; dim controls translucent darkening (false gives anchored
//! panels a transparent backdrop); center controls flex centering (false lets children position themselves).

import type { ReactNode } from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useSuspendNativeViews } from "../hooks/nativeViewSuspend";

export function Backdrop({
  onClose,
  zIndex = 1100,
  dim = true,
  center = true,
  children,
}: {
  /** Fire when both press and release occur on empty backdrop space; releasing a text-selection drag does not trigger it. */
  onClose: () => void;
  /** Stacking level, defaulting to 1100 for ordinary modals. */
  zIndex?: number;
  /** Whether to darken the background with rgba(0,0,0,.45); pass false for transparent overlays. */
  dim?: boolean;
  /** Whether to center children with flex; pass false when children position themselves. */
  center?: boolean;
  children: ReactNode;
}) {
  const backdrop = useBackdropDismiss(onClose);
  // Suspend native browser views while the backdrop is visible so they cannot cover the modal (architecture document §17).
  useSuspendNativeViews();
  return (
    <div
      {...backdrop}
      style={{
        position: "fixed",
        inset: 0,
        zIndex,
        ...(dim ? { background: "rgba(0,0,0,0.45)" } : null),
        ...(center
          ? { display: "flex", alignItems: "center", justifyContent: "center" }
          : null),
      }}
    >
      {children}
    </div>
  );
}
