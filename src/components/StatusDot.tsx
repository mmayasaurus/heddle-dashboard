//! Session status dot supporting both process lifecycle and agent activity states.

import type { DisplayStatus } from "../types";

const COLOR: Record<DisplayStatus, string> = {
  idle: "var(--status-exited)",
  running: "var(--status-running)",
  exited: "var(--status-exited)",
  error: "var(--status-error)",
  working: "var(--status-working)",
  asking: "var(--status-asking)",
  waiting: "var(--status-waiting)",
  unavailable: "var(--text-faint)",
};

export function StatusDot({
  status,
  size = 8,
}: {
  status: DisplayStatus;
  size?: number;
}) {
  return (
    <span
      // Use a breathing animation for working/awaiting-action states so active work and user waits are recognizable at a glance.
      className={
        status === "working" || status === "asking" ? "vlx-status-pulse" : undefined
      }
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: COLOR[status],
        display: "inline-block",
        flex: "0 0 auto",
      }}
    />
  );
}
