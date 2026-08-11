//! Unified document search bar opened with ⌘F. The upper-right overlay provides find, replace, case sensitivity,
//! match count, previous/next, and close controls. It has no editor-specific knowledge and drives the active
//! editor only through the DocSearchControl returned by getControl(), giving WYSIWYG and source modes one interaction model.

import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n";
import type { DocSearchControl, SearchStatus } from "./docSearch";

const EMPTY: SearchStatus = { total: 0, current: 0 };

export function DocSearchBar({
  getControl,
  onClose,
  onEdited,
  epoch,
}: {
  /** Return the active editor's search control, or null while the editor is not ready. */
  getControl: () => DocSearchControl | null;
  onClose: () => void;
  /** Notify DocView that replacement changed the document; the WYSIWYG focus guard blocks the normal path, so this must be explicit. */
  onEdited: () => void;
  /** Editor reconstruction generation; when it changes, reapply the query so highlights follow the new instance. */
  epoch: number;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [status, setStatus] = useState<SearchStatus>(EMPTY);
  const inputRef = useRef<HTMLInputElement>(null);

  // Apply the query live whenever the text or case-sensitivity setting changes.
  useEffect(() => {
    const c = getControl();
    if (!c) return;
    setStatus(query ? c.apply({ query, caseSensitive }) : (c.clear(), EMPTY));
    // getControl is stable within a mode; query and caseSensitive are the actual triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive]);

  // Reapply the current query after reload or a mode switch replaces the editor instance.
  useEffect(() => {
    const c = getControl();
    if (c && query) setStatus(c.apply({ query, caseSensitive }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  // Focus and select all on mount so users can immediately replace the query.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const next = () => setStatus(getControl()?.next() ?? EMPTY);
  const prev = () => setStatus(getControl()?.prev() ?? EMPTY);
  const doReplace = () => {
    if (status.total === 0) return;
    setStatus(getControl()?.replace(replaceText) ?? EMPTY);
    onEdited();
  };
  const doReplaceAll = () => {
    if (status.total === 0) return;
    setStatus(getControl()?.replaceAll(replaceText) ?? EMPTY);
    onEdited();
  };
  const close = () => {
    getControl()?.clear();
    onClose();
  };

  const count =
    query.length === 0
      ? ""
      : status.total === 0
        ? t("doc.searchNoMatch")
        : `${status.current}/${status.total}`;

  return (
    <div className="docsearch">
      <div className="docsearch-row">
        <button
          className={"docsearch-toggle" + (showReplace ? " on" : "")}
          title={t("doc.searchToggleReplace")}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? "▾" : "▸"}
        </button>
        <input
          ref={inputRef}
          className="vlx-input docsearch-input"
          placeholder={t("doc.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.shiftKey ? prev() : next();
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <span className="docsearch-count">{count}</span>
        <button
          className={"docsearch-btn docsearch-case" + (caseSensitive ? " on" : "")}
          title={t("doc.searchCaseSensitive")}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          className="docsearch-btn"
          onClick={prev}
          disabled={status.total === 0}
          title={t("common.prev")}
        >
          ↑
        </button>
        <button
          className="docsearch-btn"
          onClick={next}
          disabled={status.total === 0}
          title={t("common.next")}
        >
          ↓
        </button>
        <button className="docsearch-btn" onClick={close} title={t("common.close")}>
          ✕
        </button>
      </div>

      {showReplace && (
        <div className="docsearch-row">
          <span className="docsearch-toggle" aria-hidden />
          <input
            className="vlx-input docsearch-input"
            placeholder={t("doc.searchReplacePlaceholder")}
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doReplace();
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
          <button
            className="docsearch-btn docsearch-text"
            onClick={doReplace}
            disabled={status.total === 0}
            title={t("doc.searchReplace")}
          >
            {t("doc.searchReplace")}
          </button>
          <button
            className="docsearch-btn docsearch-text"
            onClick={doReplaceAll}
            disabled={status.total === 0}
            title={t("doc.searchReplaceAll")}
          >
            {t("doc.searchReplaceAll")}
          </button>
        </div>
      )}
    </div>
  );
}
