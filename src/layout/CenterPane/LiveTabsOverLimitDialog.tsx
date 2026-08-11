//! Confirmation dialog shown when the background keep-alive limit is exceeded and every background tab is active.
//! Since all of them are working or awaiting a response, none may be terminated silently (see the null branch of
//! pickEvictTab in termStore). List every background tab and let the user choose which to end, initially selecting
//! the one that entered the background earliest. If any background tab is inactive, skip this dialog: terminate
//! it automatically and report the action in the status bar through liveEvictNotice.

import { useState } from "react";
import { SessionStatusBadge } from "../../components/SessionStatusBadge";
import { useT } from "../../i18n";
import { useSuspendNativeViews } from "../../hooks/nativeViewSuspend";
import { useTermStore } from "../../store/termStore";
import { collectSessionIds } from "./paneTree";

export function LiveTabsOverLimitDialog() {
  const t = useT();
  const liveEvictAsk = useTermStore((s) => s.liveEvictAsk);
  const liveTabs = useTermStore((s) => s.liveTabs);
  const maxLiveTabs = useTermStore((s) => s.maxLiveTabs);
  const paneTrees = useTermStore((s) => s.paneTrees);
  const sessions = useTermStore((s) => s.sessions);
  const closeLiveTab = useTermStore((s) => s.closeLiveTab);
  const dismissLiveEvictAsk = useTermStore((s) => s.dismissLiveEvictAsk);

  // null means the user has not changed the selection, so default to the earliest background tab. After any user
  // action, even clearing the entire set, honor that explicit selection.
  const [selected, setSelected] = useState<Set<string> | null>(null);

  // Suspend native browser views while the dialog is visible so they cannot cover it (architecture document §17).
  useSuspendNativeViews(Boolean(liveEvictAsk && liveTabs.length > maxLiveTabs));

  if (!liveEvictAsk || liveTabs.length <= maxLiveTabs) return null;

  const selectedIds =
    selected === null
      ? liveTabs.slice(0, 1)
      : liveTabs.filter((tabId) => selected.has(tabId));
  const selectedSet = new Set(selectedIds);

  const toggleSelected = (tabId: string) => {
    setSelected((current) => {
      const next = new Set(current ?? liveTabs.slice(0, 1));
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  };

  const dismiss = () => {
    setSelected(null);
    dismissLiveEvictAsk();
  };

  const tabSessions = (tabId: string) => {
    const pt = paneTrees[tabId];
    if (!pt) return [];
    return collectSessionIds(pt)
      .map((sid) => sessions.find((s) => s.id === sid))
      .filter((s): s is NonNullable<typeof s> => !!s);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.4)",
      }}
    >
      <div
        style={{
          width: 440,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-2)",
          border: "1px solid var(--border-strong)",
          borderRadius: 12,
          boxShadow: "var(--shadow)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 16px 10px", flex: "none" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>
            {t("overlimit.title", maxLiveTabs)}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
            {t("overlimit.body")}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0 8px 8px",
            minHeight: 0,
          }}
        >
          {liveTabs.map((tabId, i) => {
            const isSelected = selectedSet.has(tabId);
            const named = tabSessions(tabId);
            return (
              <label
                key={tabId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  borderRadius: 7,
                  cursor: "pointer",
                  background: isSelected ? "var(--accent-dim, rgba(var(--accent-rgb, 63,207,142), 0.12))" : "transparent",
                  border: isSelected ? "1px solid var(--accent)" : "1px solid transparent",
                  marginTop: i > 0 ? 2 : 0,
                  transition: "background 0.1s, border-color 0.1s",
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelected(tabId)}
                  style={{
                    width: 16,
                    height: 16,
                    flex: "none",
                    margin: 0,
                    accentColor: "var(--accent)",
                    cursor: "pointer",
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                  }}
                >
                  {named.length > 0 ? (
                    named.map((session) => (
                      <span
                        key={session.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 12.5,
                            color: "var(--text)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {session.name}
                        </span>
                        <SessionStatusBadge sessionId={session.id} />
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: 12.5, color: "var(--text)" }}>
                      {tabId}
                    </span>
                  )}
                </span>
                {i === 0 && (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", flex: "none" }}>
                    {t("overlimit.earliest")}
                  </span>
                )}
              </label>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            flex: "none",
          }}
        >
          <button
            onClick={dismiss}
            style={{
              padding: "7px 14px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "transparent",
              color: "var(--text-dim)",
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            {t("overlimit.keep")}
          </button>
          <button
            disabled={selectedIds.length === 0}
            onClick={() => {
              for (const tabId of selectedIds) closeLiveTab(tabId);
              dismiss();
            }}
            style={{
              padding: "7px 16px",
              border: "none",
              borderRadius: 7,
              background: selectedIds.length > 0 ? "var(--accent)" : "var(--border)",
              color: "var(--bg-0)",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: selectedIds.length > 0 ? "pointer" : "not-allowed",
              opacity: selectedIds.length > 0 ? 1 : 0.65,
            }}
          >
            {t("overlimit.kill")}
          </button>
        </div>
      </div>
    </div>
  );
}
