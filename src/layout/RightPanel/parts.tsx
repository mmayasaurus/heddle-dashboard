//! Shared right-panel components, including the KV key-value row used by the Info tab, Git tab, and project-group ScopeInfo.

export function KV({ k, v, accent }: { k: string; v: React.ReactNode; accent?: boolean }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={"v" + (accent ? " accent" : "")}>{v}</span>
    </div>
  );
}
