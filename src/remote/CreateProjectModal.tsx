//! Create-project dialog: choose a parent directory and enter one folder name, then create that empty directory
//! and import it as a project. Desktop shells use the native directory picker; browser and remote clients browse
//! the server with the shared ServerFileBrowser.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Backdrop } from "../components/Backdrop";
import { useT } from "../i18n";
import { createDir } from "../ipc/info";
import { isTauri } from "../ipc/transport";
import { env, platform } from "../platform";
import { useTermStore } from "../store/termStore";
import {
  cardStyle,
  ghostBtn,
  joinPath,
  primaryBtn,
  ServerBrowserView,
  useServerBrowser,
} from "./ServerFileBrowser";

const fieldLabel: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  marginBottom: 4,
};

/** Project names must be one directory component; the backend reports platform-specific filename restrictions. */
function isValidProjectName(name: string): boolean {
  const trimmed = name.trim();
  return !!trimmed && trimmed !== "." && trimmed !== ".." && !/[\\/]/.test(trimmed);
}

export function CreateProjectModal() {
  const t = useT();
  const open = useTermStore((s) => s.createProjectModalOpen);
  const setOpen = useTermStore((s) => s.setCreateProjectModalOpen);
  const openProjectPath = useTermStore((s) => s.openProjectPath);

  const useNativePicker = isTauri || env.isElectron;
  const browser = useServerBrowser(open && !useNativePicker);
  const [name, setName] = useState("");
  const [nativeParent, setNativeParent] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  // If directory creation succeeded but import failed, retry only the idempotent import step.
  const [createdPath, setCreatedPath] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setNativeParent("");
    setCreating(false);
    setError("");
    setCreatedPath("");
  }, [open]);

  if (!open) return null;

  const projectName = name.trim();
  const validName = isValidProjectName(projectName);
  const parentDir = useNativePicker ? nativeParent : browser.selectedDir;
  const targetPath = createdPath || (parentDir && validName ? joinPath(parentDir, projectName) : "");
  const canCreate = !creating && !!parentDir && validName;

  const chooseNative = async () => {
    const picked = await platform.dialog.pickDirectory();
    if (picked) setNativeParent(picked);
  };

  const confirm = async () => {
    if (!canCreate || !targetPath) return;
    setCreating(true);
    setError("");
    try {
      if (!createdPath) {
        await createDir(targetPath);
        setCreatedPath(targetPath);
      }
      await openProjectPath(targetPath);
      if (!useNativePicker) browser.pushRecent(parentDir);
      setOpen(false);
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  };

  return (
    <Backdrop onClose={() => !creating && setOpen(false)} zIndex={300}>
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !creating) setOpen(false);
        }}
        style={cardStyle}
      >
        <div style={{ padding: "14px 16px 8px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>
            {t("createProject.title")}
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
            <div style={fieldLabel}>{t("createProject.name")}</div>
            <input
              className="vlx-input"
              autoFocus
              disabled={creating || !!createdPath}
              placeholder={t("createProject.namePlaceholder")}
              value={name}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) void confirm();
              }}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
            />
            {projectName && !validName && (
              <div style={{ marginTop: 5, fontSize: 11.5, color: "var(--status-error)" }}>
                {t("createProject.invalidName")}
              </div>
            )}
          </label>

          <div>
            <div style={fieldLabel}>{t("createProject.into")}</div>
            {useNativePicker ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div
                  title={parentDir}
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
                  {parentDir || t("createProject.noParent")}
                </div>
                <button
                  onClick={() => void chooseNative()}
                  disabled={creating || !!createdPath}
                  style={ghostBtn}
                >
                  {t("createProject.choose")}
                </button>
              </div>
            ) : (
              <div
                aria-disabled={creating || !!createdPath}
                style={{
                  pointerEvents: creating || createdPath ? "none" : undefined,
                  opacity: creating || createdPath ? 0.72 : 1,
                }}
              >
                <ServerBrowserView browser={browser} />
              </div>
            )}
          </div>

          {targetPath && (
            <div style={{ fontSize: 11.5, color: "var(--text-faint)", wordBreak: "break-all" }}>
              → {targetPath}
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
          <button onClick={() => setOpen(false)} disabled={creating} style={ghostBtn}>
            {t("common.cancel")}
          </button>
          <button onClick={() => void confirm()} disabled={!canCreate} style={primaryBtn(!canCreate)}>
            {creating ? t("createProject.creating") : t("createProject.submit")}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
