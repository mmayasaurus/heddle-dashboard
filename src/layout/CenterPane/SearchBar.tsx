//! In-terminal search bar, opened with Cmd/Ctrl+F, that searches the active terminal.

import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useTermStore } from "../../store/termStore";
import { clearSearch, findNext, findPrevious } from "../../terminal/registry";

export function SearchBar() {
  const t = useT();
  const activeSessionId = useTermStore((s) => s.activeSessionId);
  const closeSearch = useTermStore((s) => s.closeSearch);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const doNext = () => {
    if (activeSessionId && query) findNext(activeSessionId, query);
  };
  const doPrev = () => {
    if (activeSessionId && query) findPrevious(activeSessionId, query);
  };
  const close = () => {
    if (activeSessionId) clearSearch(activeSessionId);
    closeSearch();
  };

  const btn: React.CSSProperties = { padding: "4px 8px" };

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 14,
        zIndex: 20,
        display: "flex",
        gap: 6,
        alignItems: "center",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "6px 8px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
      }}
    >
      <input
        ref={inputRef}
        className="vlx-input"
        style={{ width: 180, padding: "4px 8px" }}
        placeholder={t("search.placeholder")}
        value={query}
        onChange={(e) => {
          const v = e.target.value;
          setQuery(v);
          if (activeSessionId && v) findNext(activeSessionId, v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.shiftKey ? doPrev() : doNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <button className="vlx-btn" style={btn} onClick={doPrev} title={t("common.prev")}>
        ↑
      </button>
      <button className="vlx-btn" style={btn} onClick={doNext} title={t("common.next")}>
        ↓
      </button>
      <button className="vlx-btn" style={btn} onClick={close} title={t("common.close")}>
        ✕
      </button>
    </div>
  );
}
