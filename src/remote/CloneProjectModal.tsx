//! Clone from Git dialog: enter a repository URL and choose a parent directory, then clone into
//! parent/repository-name and import it as a project. Desktop/Electron use a native directory picker; browser and
//! remote clients reuse ServerFileBrowser to browse the server, matching DirectoryPickerModal's interaction model.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { genId } from "../genId";
import { useT } from "../i18n";
import { onCloneProgress, type CloneProgress } from "../ipc/events";
import { cancelCloneProject } from "../ipc/tree";
import { isTauri } from "../ipc/transport";
import { env, platform } from "../platform";
import { useTermStore } from "../store/termStore";
import { Backdrop } from "../components/Backdrop";
import {
  cardStyle,
  ghostBtn,
  joinPath,
  primaryBtn,
  ServerBrowserView,
  useServerBrowser,
} from "./ServerFileBrowser";

/** Derive the default directory name from the repository URL using the backend git::derive_clone_dir_name rules; used only for placeholders/prefill. */
function deriveFolder(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const last = trimmed.split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "").trim();
}

const fieldLabel: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  marginBottom: 4,
};

export function CloneProjectModal() {
  const t = useT();
  const open = useTermStore((s) => s.cloneModalOpen);
  const setOpen = useTermStore((s) => s.setCloneModalOpen);
  const cloneProjectInto = useTermStore((s) => s.cloneProjectInto);

  // Desktop/Electron have a native directory dialog; browser/remote windows do not, so embed the server directory
  // browser. This matches store.importProject behavior.
  const useNativePicker = isTauri || env.isElectron;
  const browser = useServerBrowser(open && !useNativePicker);

  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [nativeParent, setNativeParent] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<CloneProgress | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState("");
  const operationId = useRef<string | null>(null);
  const cancelRequested = useRef(false);
  const startedAt = useRef(0);
  const lastProgressAt = useRef(0);

  // Reset input state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setUrl("");
      setBranch("");
      setFolder("");
      setFolderTouched(false);
      setNativeParent("");
      setCloning(false);
      setCancelling(false);
      setProgress(null);
      setElapsedSeconds(0);
      setError("");
      operationId.current = null;
      cancelRequested.current = false;
    }
  }, [open]);

  // The single global event carries an operationId; during concurrent clones, accept only the operation started by this dialog.
  useEffect(() => {
    const unlisten = onCloneProgress((next) => {
      if (next.operationId !== operationId.current) return;
      lastProgressAt.current = Date.now();
      setProgress(next);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!cloning) return;
    const tick = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cloning]);

  if (!open) return null;

  const autoFolder = deriveFolder(url);
  const effectiveFolder = folderTouched ? folder : autoFolder;
  const parentDir = useNativePicker ? nativeParent : browser.selectedDir;
  const canClone =
    !cloning && url.trim().length > 0 && !!parentDir && effectiveFolder.trim().length > 0;

  const chooseNative = async () => {
    const picked = await platform.dialog.pickDirectory();
    if (picked) setNativeParent(picked);
  };

  const confirm = async () => {
    if (!canClone) return;
    const currentOperationId = genId();
    operationId.current = currentOperationId;
    cancelRequested.current = false;
    startedAt.current = Date.now();
    lastProgressAt.current = startedAt.current;
    setCloning(true);
    setCancelling(false);
    setProgress(null);
    setElapsedSeconds(0);
    setError("");
    try {
      await cloneProjectInto(
        url.trim(),
        parentDir,
        effectiveFolder.trim(),
        branch.trim(),
        currentOperationId,
      );
      if (!useNativePicker) browser.pushRecent(parentDir);
    } catch (e) {
      const message = String(e);
      const wasCancelled = message === "CLONE_CANCELLED" || message === "Error: CLONE_CANCELLED";
      if (cancelRequested.current && wasCancelled) {
        setOpen(false);
      } else {
        setError(message);
      }
      setCloning(false);
      setCancelling(false);
    } finally {
      if (operationId.current === currentOperationId) operationId.current = null;
    }
  };

  const cancel = async () => {
    if (!cloning) {
      setOpen(false);
      return;
    }
    if (cancelling || !operationId.current) return;
    cancelRequested.current = true;
    setCancelling(true);
    setError("");
    try {
      await cancelCloneProject(operationId.current);
    } catch (e) {
      cancelRequested.current = false;
      setCancelling(false);
      setError(String(e));
    }
  };

  const stageText = (): string => {
    const label = (() => {
      switch (progress?.stage) {
        case "connecting":
          return t("clone.stageConnecting");
        case "preparing":
          return t("clone.stagePreparing");
        case "receiving":
          return t("clone.stageReceiving");
        case "resolving":
          return t("clone.stageResolving");
        case "checkout":
          return t("clone.stageCheckout");
        case "finalizing":
          return t("clone.stageFinalizing");
        case "importing":
          return t("clone.stageImporting");
        default:
          return t("clone.stageStarting");
      }
    })();
    return progress?.percent != null ? `${label} ${progress.percent}%` : label;
  };

  const progressStalled =
    cloning && elapsedSeconds >= 30 && Date.now() - lastProgressAt.current >= 30_000;

  return (
    <Backdrop onClose={() => !cloning && setOpen(false)} zIndex={300}>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !cloning) setOpen(false);
        }}
        style={cardStyle}
      >
        <div style={{ padding: "14px 16px 8px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>
            {t("clone.title")}
          </div>
        </div>

        <div
          style={{
            padding: "0 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            overflow: "auto",
          }}
        >
          <label style={{ display: "block" }}>
            <div style={fieldLabel}>{t("clone.url")}</div>
            <input
              className="vlx-input"
              autoFocus
              disabled={cloning}
              placeholder={t("clone.urlPlaceholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>

          <label style={{ display: "block" }}>
            <div style={fieldLabel}>{t("clone.branch")}</div>
            <input
              className="vlx-input"
              disabled={cloning}
              placeholder={t("clone.branchPlaceholder")}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>

          <label style={{ display: "block" }}>
            <div style={fieldLabel}>{t("clone.folder")}</div>
            <input
              className="vlx-input"
              disabled={cloning}
              placeholder={autoFolder || t("clone.folderPlaceholder")}
              value={effectiveFolder}
              onChange={(e) => {
                setFolderTouched(true);
                setFolder(e.target.value);
              }}
            />
          </label>

          <div>
            <div style={fieldLabel}>{t("clone.into")}</div>
            {useNativePicker ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div
                  title={parentDir || ""}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    color: parentDir ? "var(--text)" : "var(--text-faint)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {parentDir || t("clone.noParent")}
                </div>
                <button onClick={() => void chooseNative()} disabled={cloning} style={ghostBtn}>
                  {t("clone.choose")}
                </button>
              </div>
            ) : (
              <div
                aria-disabled={cloning}
                style={{ pointerEvents: cloning ? "none" : undefined, opacity: cloning ? 0.72 : 1 }}
              >
                <ServerBrowserView browser={browser} />
              </div>
            )}
          </div>

          {parentDir && effectiveFolder.trim() && (
            <div style={{ fontSize: 11.5, color: "var(--text-faint)", wordBreak: "break-all" }}>
              → {joinPath(parentDir.replace(/\/+$/, ""), effectiveFolder.trim())}
            </div>
          )}

          {cloning && (
            <div
              style={{
                padding: "9px 10px",
                border: "1px solid var(--border)",
                borderRadius: 7,
                background: "var(--bg-0)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <span style={{ fontSize: 12, color: "var(--text-mid)" }}>
                  {cancelling ? t("clone.cancelling") : stageText()}
                </span>
                <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-faint)" }}>
                  {t("clone.elapsed", elapsedSeconds)}
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  marginTop: 7,
                  borderRadius: 2,
                  background: "var(--bg-active)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: progress?.percent != null ? `${progress.percent}%` : "35%",
                    height: "100%",
                    background: "var(--accent)",
                    transition: "width 0.25s ease",
                    animation: progress?.percent == null ? "pulse 1.2s ease-in-out infinite" : undefined,
                  }}
                />
              </div>
              {progressStalled && (
                <div style={{ marginTop: 7, fontSize: 11, color: "var(--text-faint)" }}>
                  {t("clone.slowHint")}
                </div>
              )}
            </div>
          )}

          {error && (
            <div style={{ fontSize: 12, color: "var(--status-error)", wordBreak: "break-all" }}>
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <button onClick={() => void cancel()} disabled={cancelling} style={ghostBtn}>
            {cancelling ? t("clone.cancelling") : t("common.cancel")}
          </button>
          <button onClick={() => void confirm()} disabled={!canClone} style={primaryBtn(!canClone)}>
            {cloning ? t("clone.cloning") : t("clone.submit")}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
