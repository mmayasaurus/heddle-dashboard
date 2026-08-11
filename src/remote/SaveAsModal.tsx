//! Browser-side Save As dialog for new documents. Plain browser and remote windows have no native
//! Save As dialog, so this combines the shared ServerFileBrowser (tree expansion, shortcuts, and
//! navigation) with a filename field. DocView writes the selected path to the server. The promise-
//! based flow is triggered through `store.promptSaveAs`, resolving to a path or null on cancel.
//! Desktop builds use the native dialog and do not mount this component.
//!
//! Selecting an existing file fills the filename. If the destination already contains that name,
//! an inline confirmation requires a second click on "Overwrite" to prevent silent replacement.

import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { listDir } from "../ipc/info";
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

export function SaveAsModal() {
  const t = useT();
  const req = useTermStore((s) => s.saveAsRequest);
  const browser = useServerBrowser(!!req);

  const [name, setName] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // Non-null when a name collision has been found and overwrite confirmation is pending.
  const [overwrite, setOverwrite] = useState<string | null>(null);

  // Populate the default filename and clear stale state whenever the dialog opens.
  useEffect(() => {
    if (!req) return;
    setName(req.defaultName);
    setSaving(false);
    setOverwrite(null);
  }, [req]);

  // A collision from the previous directory no longer applies after navigation.
  useEffect(() => {
    setOverwrite(null);
  }, [browser.selectedDir]);

  if (!req) return null;

  /** Close the dialog and return its result to the caller awaiting promptSaveAs. */
  const finish = (result: string | null) => {
    req.resolve(result);
    useTermStore.setState({ saveAsRequest: null });
  };

  const confirm = async () => {
    const fname = name.trim();
    const dir = browser.selectedDir;
    if (!fname || !dir) return;
    setSaving(true);
    browser.setError("");
    try {
      // List the destination before saving to verify access and detect filename collisions.
      const list = await listDir(dir);
      const collides = list.some((e) => !e.isDir && e.name === fname);
      if (collides && overwrite !== fname) {
        // On the first collision, request confirmation instead of returning immediately.
        setOverwrite(fname);
        setSaving(false);
        return;
      }
      browser.pushRecent(dir);
      finish(joinPath(dir, fname));
    } catch (e) {
      browser.setError(String(e));
      setSaving(false);
    }
  };

  const canSave = !saving && !!name.trim() && !!browser.selectedDir;

  return (
    <Backdrop onClose={() => finish(null)} zIndex={300}>
      <div onClick={(e) => e.stopPropagation()} style={cardStyle}>
        <div style={{ padding: "14px 16px 8px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{t("doc.saveAsTitle")}</div>
        </div>

        <ServerBrowserView
          browser={browser}
          selectedName={name.trim() || undefined}
          onFileClick={(fileName) => {
            setName(fileName);
            setOverwrite(null);
          }}
        />

        {overwrite && (
          <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--danger, #ff6b6b)" }}>
            {t("doc.overwriteConfirm")}
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setOverwrite(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) void confirm();
            }}
            placeholder={t("doc.saveAsName")}
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "7px 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-0)",
              fontSize: 12.5,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button onClick={() => finish(null)} style={ghostBtn}>
            {t("common.cancel")}
          </button>
          <button onClick={() => void confirm()} disabled={!canSave} style={primaryBtn(!canSave)}>
            {saving ? t("doc.saving") : overwrite ? t("doc.overwrite") : t("common.save")}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
