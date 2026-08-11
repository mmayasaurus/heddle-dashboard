//! Full Git Bash download-progress banner, used only on Windows. It listens for backend `gitbash://download*`
//! events, shows download/extraction progress in the lower-right, and sends a system notification on success or
//! failure. App mounts exactly one global instance.

import { useEffect, useState } from "react";
import { useT } from "../i18n";
import {
  onGitbashDownload,
  onGitbashDownloadDone,
  onGitbashDownloadError,
} from "../ipc/events";
import { notify } from "../notify";

type State =
  | { kind: "idle" }
  | { kind: "downloading"; received: number; total: number }
  | { kind: "extracting" }
  | { kind: "error"; msg: string };

/** Convert bytes to a human-readable MB value. */
function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function GitbashDownloadBanner() {
  const tt = useT();
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    const subs = [
      onGitbashDownload((p) => {
        if (p.phase === "extract") {
          setState({ kind: "extracting" });
        } else {
          setState({
            kind: "downloading",
            received: p.received ?? 0,
            total: p.total ?? 0,
          });
        }
      }),
      onGitbashDownloadDone(() => {
        setState({ kind: "idle" });
        void notify(null, tt("gitbash.title"), tt("gitbash.done"));
      }),
      onGitbashDownloadError((msg) => {
        setState({ kind: "error", msg });
        void notify(null, tt("gitbash.title"), tt("gitbash.failed"));
      }),
    ];
    return () => {
      subs.forEach((s) => void s.then((fn) => fn()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === "idle") return null;

  const pct =
    state.kind === "downloading" && state.total > 0
      ? Math.floor((state.received / state.total) * 100)
      : null;

  let text: string;
  if (state.kind === "downloading") {
    text =
      pct != null
        ? `${tt("gitbash.downloading")} ${pct}% (${mb(state.received)}/${mb(state.total)})`
        : `${tt("gitbash.downloading")} ${mb(state.received)}`;
  } else if (state.kind === "extracting") {
    text = tt("gitbash.extracting");
  } else {
    text = `${tt("gitbash.failed")}: ${state.msg}`;
  }

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 36,
        zIndex: 1000,
        maxWidth: 360,
        padding: "8px 12px",
        borderRadius: 8,
        fontSize: 12,
        background: "var(--panel-bg, #2a2a2a)",
        color: "var(--text, #eee)",
        border: "1px solid var(--border, #444)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {text}
        </span>
        {state.kind === "error" && (
          <button
            onClick={() => setState({ kind: "idle" })}
            style={{
              border: "none",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
            }}
            aria-label="dismiss"
          >
            ×
          </button>
        )}
      </div>
      {state.kind !== "error" && (
        <div
          style={{
            height: 4,
            borderRadius: 2,
            background: "var(--border, #444)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: pct != null ? `${pct}%` : "100%",
              background: "var(--accent, #4a9eff)",
              transition: "width 0.2s",
              // Extraction has no fine-grained progress; a full pulsing bar indicates ongoing work.
              animation: state.kind === "extracting" ? "pulse 1.2s ease-in-out infinite" : undefined,
            }}
          />
        </div>
      )}
    </div>
  );
}
