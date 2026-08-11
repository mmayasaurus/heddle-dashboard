//! Vlinx-style session status indicator shared by the left project tree and center tabs for consistent icons.
//! Color semantics: ready (running) = blue; working = breathing green; awaiting action (asking) = breathing yellow;
//! replied (waiting) = magenta; idle = no indicator. Unread notifications take precedence as a rippling magenta
//! dot and clear when the session opens.

import { t } from "../i18n";
import type { DisplayStatus } from "../types";

export function StatusIndicator({
  status,
  unread,
}: {
  status: DisplayStatus;
  unread?: boolean;
}) {
  // Unread takes precedence as a prominent rippling dot that clears when opened (see termStore.openSession).
  if (unread) {
    return <span className="status-dot st-unread" title={t("indicator.unread")} />;
  }
  if (status === "asking") {
    return <span className="status-dot st-attention vlx-status-pulse" title={status} />;
  }
  if (status === "waiting") {
    return <span className="status-dot st-waiting" title={status} />;
  }
  if (status === "error") {
    return (
      <span
        className="status-dot"
        style={{ background: "var(--red)" }}
        title={t("status.error")}
      />
    );
  }
  if (status === "working") {
    return <span className="status-dot st-working vlx-status-pulse" title={status} />;
  }
  if (status === "unavailable") {
    return (
      <span
        className="status-dot"
        style={{ background: "var(--text-faint)" }}
        title={t("status.unavailable")}
      />
    );
  }
  if (status === "running") {
    return <span className="status-dot st-ready" title={status} />;
  }
  return null;
}
