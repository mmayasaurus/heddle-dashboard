//! Session-context export flow shared by the sidebar context menu and Archive panel:
//! - Desktop: choose a path in the system Save As dialog, then let the backend generate and write the file.
//! - Browser: obtain generated content from the backend and trigger a local download through a Blob.
//! Filenames follow the global `title_YYYYMMDD_HHmm.md` convention. Failures produce a non-disruptive system notification.

import { t } from "./i18n";
import { exportSessionContext } from "./ipc/commands";
import { platform } from "./platform";
import { notify } from "./notify";
import type { Session } from "./types";

/** Whether context can be exported: a local agent session with a parseable transcript (Claude/Codex with a captured ID). */
export function canExportContext(s: Pick<Session, "kind" | "agentSessionId">): boolean {
  return (s.kind === "claude" || s.kind === "codex") && !!s.agentSessionId;
}

/** Current local time formatted as `YYYYMMDD_HHmm` for filenames and `YYYY-MM-DD HH:mm` for document headers. */
function nowParts(): { stamp: string; human: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const hm = `${p(d.getHours())}${p(d.getMinutes())}`;
  return {
    stamp: `${ymd}_${hm}`,
    human: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/** Convert a session name to a safe filename by removing path separators and platform-reserved characters. */
function safeName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\r\n]/g, "_").trim();
  return s || t("common.session");
}

/**
 * Export a session's complete context as a Markdown file. Return silently if the user cancels the Save dialog;
 * report failures such as a deleted transcript through a system notification.
 */
export async function exportSessionToFile(
  session: Pick<Session, "id" | "name">,
): Promise<void> {
  const { stamp, human } = nowParts();
  const fileName = `${safeName(session.name)}_${t("export.contextSuffix")}_${stamp}.md`;
  try {
    if (platform.env.isTauri || platform.env.isElectron) {
      const dest = await platform.dialog.saveFile({
        defaultPath: fileName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!dest) return; // User canceled.
      await exportSessionContext(session.id, dest, human);
      return;
    }
    // Browser: download generated content to the user's machine, not the server.
    const content = await exportSessionContext(session.id, undefined, human);
    const blob = new Blob([content ?? ""], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    void notify(null, t("export.failedTitle"), String(e));
  }
}
