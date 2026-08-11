//! Browser directory picker used when importing a project, because browsers have no native directory dialog.
//! Browse server directories through the shared ServerFileBrowser (expandable tree, shortcuts, and navigation),
//! then import the current target directory as a project. Files in the tree are read-only context; the directory
//! itself is what gets imported.

import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { listDir } from "../ipc/info";
import { useTermStore } from "../store/termStore";
import { Backdrop } from "../components/Backdrop";
import { cardStyle, ghostBtn, primaryBtn, ServerBrowserView, useServerBrowser } from "./ServerFileBrowser";

export function DirectoryPickerModal() {
  const t = useT();
  const open = useTermStore((s) => s.dirPickerOpen);
  const setOpen = useTermStore((s) => s.setDirPickerOpen);
  const importProjectPath = useTermStore((s) => s.importProjectPath);
  const browser = useServerBrowser(open);

  const [importing, setImporting] = useState(false);

  // The modal stays mounted at the App root and returns null when closed, so its component instance survives and
  // can retain importing. A successful import closes without resetting it, as does Cancel; on the next open, the
  // Choose button would remain disabled at "Importing…" until a page refresh. Reset importing whenever it closes.
  useEffect(() => {
    if (!open) setImporting(false);
  }, [open]);

  if (!open) return null;

  const confirm = async () => {
    const target = browser.selectedDir;
    if (!target) return;
    setImporting(true);
    browser.setError("");
    try {
      // Verify that the directory exists and is readable before importing it.
      await listDir(target);
      browser.pushRecent(target);
      await importProjectPath(target);
    } catch (e) {
      browser.setError(String(e));
      setImporting(false);
    }
  };

  const canChoose = !importing && !!browser.selectedDir;

  return (
    <Backdrop onClose={() => setOpen(false)} zIndex={300}>
      <div onClick={(e) => e.stopPropagation()} style={cardStyle}>
        <div style={{ padding: "14px 16px 8px" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{t("dir.title")}</div>
        </div>

        <ServerBrowserView browser={browser} />

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <button onClick={() => setOpen(false)} style={ghostBtn}>
            {t("common.cancel")}
          </button>
          <button onClick={() => void confirm()} disabled={!canChoose} style={primaryBtn(!canChoose)}>
            {importing ? t("dir.importing") : t("dir.choose")}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
