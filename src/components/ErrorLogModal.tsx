//! Error-log panel behind a hidden debugging entry point. The red "request failed" banner that once interrupted
//! users now records failures without disruption. transport still captures them centrally in reqLog's 100-entry
//! ring buffer; this panel only displays them on demand for field diagnosis. WKWebView has no console, making this
//! the only on-site record.
//!
//! Neither entry point is exposed explicitly to ordinary users: Option/Alt-click the title-bar gear (a normal
//! click still opens Settings), or press Cmd+Ctrl+Opt+E. Controlled by errorLogOpen in the store and mounted at
//! the App root like other modals.

import { useEffect, useState, type CSSProperties } from "react";
import { useT } from "../i18n";
import {
  clearRequestErrors,
  getRequestErrors,
  onRequestError,
  type RequestErrorEntry,
} from "../ipc/reqLog";
import { useTermStore } from "../store/termStore";
import { Backdrop } from "./Backdrop";

/** Convert a millisecond timestamp to local HH:mm:ss. */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const btnStyle: CSSProperties = {
  padding: "5px 12px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function ErrorLogModal() {
  const t = useT();
  const open = useTermStore((s) => s.errorLogOpen);
  const setOpen = useTermStore((s) => s.setErrorLogOpen);
  const [entries, setEntries] = useState<RequestErrorEntry[]>([]);
  const [copied, setCopied] = useState(false);

  // On open, load existing entries and subscribe to new ones for live updates; unsubscribe when the panel closes.
  useEffect(() => {
    if (!open) return;
    setEntries(getRequestErrors());
    const off = onRequestError(() => setEntries(getRequestErrors()));
    return off;
  }, [open]);

  if (!open) return null;

  const copyAll = () => {
    const text = entries
      .map((e) => `${fmtTime(e.ts)}  ${e.cmd}: ${e.message}`)
      .join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  const clear = () => {
    clearRequestErrors();
    setEntries([]);
  };

  const hasEntries = entries.length > 0;

  return (
    <Backdrop onClose={() => setOpen(false)} zIndex={10000}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640,
          maxWidth: "92vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-app)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          color: "var(--text-primary)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        {/* Header: title, count and action buttons. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>{t("errlog.title")}</span>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {entries.length}
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={copyAll}
            disabled={!hasEntries}
            style={{ ...btnStyle, opacity: hasEntries ? 1 : 0.4 }}
          >
            {copied ? "✓" : t("errlog.copyAll")}
          </button>
          <button
            onClick={clear}
            disabled={!hasEntries}
            style={{ ...btnStyle, opacity: hasEntries ? 1 : 0.4 }}
          >
            {t("errlog.clear")}
          </button>
          <button onClick={() => setOpen(false)} style={btnStyle}>
            {t("errlog.close")}
          </button>
        </div>

        {/* List, newest first, with a short message when empty. */}
        <div style={{ overflow: "auto", padding: hasEntries ? "4px 0" : 0 }}>
          {!hasEntries ? (
            <div
              style={{
                padding: "44px 18px",
                textAlign: "center",
                fontSize: 12.5,
                color: "var(--text-dim)",
              }}
            >
              {t("errlog.empty")}
            </div>
          ) : (
            entries.map((e, i) => (
              <div
                key={`${e.ts}-${i}`}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "6px 16px",
                  fontSize: 12,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  borderBottom: "1px solid rgba(128,128,128,0.12)",
                  alignItems: "baseline",
                }}
              >
                <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  {fmtTime(e.ts)}
                </span>
                <span style={{ color: "var(--accent)", whiteSpace: "nowrap" }}>
                  {e.cmd}
                </span>
                <span
                  style={{ color: "var(--danger, #e5484d)", wordBreak: "break-word" }}
                >
                  {e.message}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </Backdrop>
  );
}
