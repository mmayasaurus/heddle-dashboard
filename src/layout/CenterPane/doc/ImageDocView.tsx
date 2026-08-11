//! Image document viewer with chunked loading, real progress, and fit/1:1 modes. Explicit refresh
//! through reloadNonce reloads immediately; a two-second mtime poll only reports external changes
//! and lets the user choose. Images are read-only, have no save or mode switch, and never become dirty.
//!
//! `loadFileBlob` assembles chunks into a Blob and supplies `<img>` through an object URL. Unlike a
//! data URL, this avoids a large resident string and is revoked on reload/unmount. SVG is always
//! rendered as an image, never inline HTML, so embedded scripts do not execute.

import { useCallback, useEffect, useRef, useState } from "react";
import { t as tt, useT } from "../../../i18n";
import { FILE_BEING_WRITTEN, loadFileBlob, statFile } from "../../../ipc/info";
import { useTermStore, type DocTab } from "../../../store/termStore";
import "./docTheme.css";

/** External-change polling interval, matching DocView; stat mtime only for the active tab. */
const POLL_MS = 2000;

/** Extension-to-Blob MIME mapping; SVG needs the correct type and unknown types use image/<ext>. */
const MIME_OVERRIDES: Record<string, string> = {
  svg: "image/svg+xml",
  ico: "image/x-icon",
  jpg: "image/jpeg",
};

function mimeOf(path: string): string {
  const name = path.split("/").pop() || path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return MIME_OVERRIDES[ext] ?? `image/${ext}`;
}

/** Format byte counts for progress and header metadata. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ImageDocView({ tab, hidden }: { tab: DocTab; hidden: boolean }) {
  const t = useT();
  const closeTab = useTermStore((s) => s.closeTab);

  const [url, setUrl] = useState<string | null>(null);
  const [byteSize, setByteSize] = useState<number | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [fit, setFit] = useState(true);

  /** Load generation; incrementing cancels the previous transfer on reload or unmount. */
  const epochRef = useRef(0);
  /** Baseline disk mtime; null means the last load failed, so polling leaves retry to the error UI. */
  const baselineMtimeRef = useRef<number | null>(null);
  /** Detected external change; non-null displays the banner. */
  const [externalMtime, setExternalMtime] = useState<number | null>(null);
  /** Ignored disk mtime, preventing repeated banners for the same version. */
  const ignoredMtimeRef = useRef<number | null>(null);
  /** Current object URL, revoked on reload or unmount. */
  const urlRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const epoch = ++epochRef.current;
    const cancelled = () => epochRef.current !== epoch;
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      const res = await loadFileBlob(
        tab.path,
        (received, total) => {
          if (!cancelled()) setProgress({ received, total });
        },
        cancelled,
      );
      if (!res || cancelled()) return; // Cancelled by tab closure or a newer load.
      baselineMtimeRef.current = res.mtimeMs;
      ignoredMtimeRef.current = null;
      setExternalMtime(null);
      const next = URL.createObjectURL(new Blob([res.blob], { type: mimeOf(tab.path) }));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next;
      setByteSize(res.blob.size);
      setDims(null); // onLoad remeasures intrinsic dimensions.
      setUrl(next);
    } catch (e) {
      if (cancelled()) return;
      baselineMtimeRef.current = null;
      setError(
        String(e).includes(FILE_BEING_WRITTEN)
          ? tt("doc.imgBeingWritten")
          : String(e),
      );
    } finally {
      if (!cancelled()) setLoading(false);
    }
  }, [tab.path]);

  useEffect(() => {
    void load();
    return () => {
      // Cancel in-flight chunk loading and release the object URL on unmount.
      epochRef.current++;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [load]);

  // ── Explicit refresh via repeated view or the tab refresh action ──
  // Images cannot be dirty, so reload unconditionally; the generation guard cancels prior work.
  const lastReloadNonceRef = useRef(tab.reloadNonce);
  useEffect(() => {
    if (tab.reloadNonce === lastReloadNonceRef.current) return;
    lastReloadNonceRef.current = tab.reloadNonce;
    void load();
  }, [tab.reloadNonce, load]);

  // ── External changes: poll mtime every two seconds while active, checking immediately on return ──
  // Notify without automatic reload and do not repeat a banner for an ignored version.
  useEffect(() => {
    if (hidden || loading) return;
    let stopped = false;
    const check = async () => {
      try {
        const st = await statFile(tab.path);
        if (stopped) return;
        const baseline = baselineMtimeRef.current;
        if (baseline == null || st.mtimeMs === baseline) return;
        if (st.mtimeMs === ignoredMtimeRef.current) return;
        setExternalMtime(st.mtimeMs);
      } catch {
        /* Keep polling after deletion or temporary stat failure. */
      }
    };
    void check(); // Check immediately when returning.
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [hidden, loading, tab.path]);

  const pct =
    progress && progress.total > 0
      ? Math.min(100, (progress.received / progress.total) * 100)
      : 0;

  return (
    <div className="docview" style={hidden ? { display: "none" } : undefined}>
      <div className="docview-head">
        <span className="title">{tab.title}</span>
        <span className="path" title={tab.path}>
          {tab.path}
        </span>
        {dims && byteSize != null && !error && (
          <span className="docview-imgmeta">
            {dims.w}×{dims.h} · {fmtBytes(byteSize)}
          </span>
        )}
        <div className="docview-seg">
          <button className={fit ? "on" : ""} onClick={() => setFit(true)}>
            {t("doc.imgFit")}
          </button>
          <button className={!fit ? "on" : ""} onClick={() => setFit(false)}>
            {t("doc.imgActual")}
          </button>
        </div>
      </div>

      {externalMtime != null && (
        <div className="docview-banner">
          <span style={{ flex: 1 }}>{t("doc.externalChangedClean")}</span>
          <button onClick={() => void load()}>{t("doc.reload")}</button>
          <button
            onClick={() => {
              ignoredMtimeRef.current = externalMtime;
              setExternalMtime(null);
            }}
          >
            {t("doc.ignore")}
          </button>
        </div>
      )}

      {/* During reload, retain the old image and show a thin progress line to avoid flicker. */}
      {loading && url && (
        <div className="docview-imgreload">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}

      {loading && !url && (
        <div className="docview-state">
          <div>
            {progress
              ? t("doc.imgLoading", tab.title, fmtBytes(progress.total))
              : t("doc.loadingFile", tab.title)}
          </div>
          <div className="docview-progress">
            <div style={{ width: `${pct}%` }} />
          </div>
          {progress && (
            <div>
              {fmtBytes(progress.received)} / {fmtBytes(progress.total)}
            </div>
          )}
        </div>
      )}

      {!loading && error && (
        <div className="docview-state">
          <div style={{ color: "var(--red)" }}>{error}</div>
          <div className="actions">
            <button className="vlx-btn" onClick={() => void load()}>
              {t("common.retry")}
            </button>
            <button className="vlx-btn" onClick={() => closeTab(tab.id)}>
              {t("doc.closeTab")}
            </button>
          </div>
        </div>
      )}

      {!error && url && (
        <div className="docview-imgbody">
          <img
            src={url}
            className={fit ? "fit" : "actual"}
            alt={tab.title}
            onLoad={(e) =>
              setDims({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            onError={() => setError(tt("doc.imgDecodeFailed"))}
          />
        </div>
      )}
    </div>
  );
}
