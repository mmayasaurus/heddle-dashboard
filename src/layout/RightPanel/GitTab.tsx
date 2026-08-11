//! Right-panel Git tab: real branch/ahead-behind data plus design-placeholder per-file changes, extracted from RightPanel.
//! The shared KV key-value row lives in parts.

import { useEffect, useState } from "react";
import { getGitStatus } from "../../ipc/info";
import { type GitStatus as GitStatusType } from "../../types";
import { KV } from "./parts";
/* ===================== Git (real branch data + design-placeholder changes) ===================== */

const PLACEHOLDER_CHANGES = [
  { f: "src/lib/auth.ts", p: 18, m: 9, s: "M" },
  { f: "src/lib/auth.test.ts", p: 44, m: 0, s: "A" },
  { f: "src/components/Sidebar.tsx", p: 6, m: 2, s: "M" },
  { f: "README.md", p: 7, m: 1, s: "M" },
];

export function GitTab({ path }: { path: string | null }) {
  const [status, setStatus] = useState<GitStatusType | null>(null);

  useEffect(() => {
    if (!path) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    getGitStatus(path)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div className="insp-section">
        <h4>Branch</h4>
        <KV k="current" v={status?.isRepo ? (status.branch ?? "(detached)") : "—"} accent />
        <KV
          k="upstream"
          v={status?.isRepo ? `↑${status.ahead} ↓${status.behind}` : "—"}
        />
      </div>
      {/* Placeholder from the design: the per-file change detail still needs the backend git diff. */}
      <div className="insp-section">
        <h4>Changes · {PLACEHOLDER_CHANGES.length}</h4>
        {PLACEHOLDER_CHANGES.map((c) => (
          <div className="diffstat" key={c.f}>
            <span className={"gb gb-" + c.s}>{c.s}</span>
            <span className="fn">{c.f}</span>
            <span className="n">
              <span style={{ color: "var(--green)" }}>+{c.p}</span>{" "}
              <span style={{ color: "var(--red)" }}>−{c.m}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
