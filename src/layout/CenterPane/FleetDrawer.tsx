//! FleetDrawer — collapsible bottom drawer under the terminal stage. Surfaces heddle's orchestration
//! state in two distinct lenses:
//!   - PROVIDER CAPS: true rolling 5-hour / 7-day rate-limit usage per provider, captured live from
//!     each provider's Claude Code statusline payload by ~/.heddle/usage-tap.mjs (the SAME numbers the
//!     statusline shows — accurate, not a spend estimate).
//!   - DISPATCH LEDGER (~/.heddle/ledger.db): what heddle itself routed + how it turned out.
//! Read-only, desktop-only, polls on a timer. Degrades to "waiting…" when a source is absent.

import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "../../ipc/transport";
import { DisciplinePanel } from "./DisciplinePanel";
import { RouteMixPanel } from "./RouteMixPanel";
import { useTermStore } from "../../store/termStore";

interface LimitWindow {
  usedPercentage: number | null;
  resetsAt: number | null; // epoch SECONDS
  id?: string;
  label?: string;
  usedAmount?: number | null;
  limitAmount?: number | null;
  unit?: string | null;
}
interface ProviderAccount {
  label?: string;
  plan?: string;
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  windows?: LimitWindow[];
  limitReached?: boolean;
  note?: string;
}
interface ProviderLimit {
  provider: string;
  model: string | null;
  capturedAt: number | null;
  fiveHour: LimitWindow;
  sevenDay: LimitWindow;
  source?: string;
  stale?: boolean;
  staleAfterSecs?: number;
  note?: string;
  accounts?: ProviderAccount[];
  windows?: LimitWindow[];
}
interface Dispatch {
  id: number;
  orchestrator: string | null;
  taskClass: string;
  provider: string;
  model: string;
  ok: number;
  issue: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  fellBackFrom: string | null;
  startedAt: string;
  finishedAt: string | null;
}
interface ProviderUsage {
  provider: string;
  dispatches: number;
  succeeded: number;
  inputTokens: number;
  outputTokens: number;
}
// Fleet roster: the NAMED agents (live Claude Code sessions with a fleet tag) and, under each, the
// workers it currently has in flight (ledger rows). Answers "which agents are running and what is
// each one doing" — not "which subprocesses exist" (Maya, 2026-08-15).
interface FleetWorker {
  id: number;
  taskClass: string;
  provider: string;
  model: string;
  startedAt: string;
  cwd: string;
  elapsedMs: number;
  stale: boolean;
}
interface FleetAgent {
  name: string;
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  kind: string;
  updatedAtMs: number;
  alive: boolean;
  workers: FleetWorker[];
}

const POLL_MS = 30_000;
const OPEN_KEY = "heddle-fleet-open";
// Roster scope: "project" = only agents whose cwd is inside the currently-open project (the active
// session's project root); "all" = every fleet-tagged session on the machine. Persisted. Default =
// project, so several projects can be worked at once without clutter (Maya, 2026-08-15).
const SCOPE_KEY = "heddle-fleet-roster-scope";
type RosterScope = "project" | "all";

// Distinct per-provider accent for the usage bars.
const PROVIDER_COLOR: Record<string, string> = {
  claude: "#b07cf0",
  codex: "#4fc08d",
  cursor: "#e3a857",
  gemini: "#5ec8d8",
};
const providerColor = (p: string) => PROVIDER_COLOR[p] ?? "var(--text-mid)";

function fmtTokens(n: number | null | undefined): string {
  if (!n || n <= 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
function fmtDur(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  return now;
}
/** Countdown to a reset time given as epoch SECONDS: "3h 30m" / "2d 22h" / "5m". */
function fmtReset(resetsAtSec: number | null | undefined, now: number): string {
  if (!resetsAtSec) return "";
  let s = resetsAtSec - Math.floor(now / 1000);
  if (s <= 0) return "resetting…";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function FleetDrawer() {
  const now = useNow();
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const [scope, setScope] = useState<RosterScope>(() =>
    localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "project",
  );
  // The "current project" = the project that owns the active session (same resolution CenterPane uses).
  const currentProjectRoot = useTermStore((s) => {
    const sid = s.activeSessionId;
    const sess = sid ? s.sessions.find((x) => x.id === sid) ?? s.ephemeralSessions[sid] : undefined;
    const proj = sess ? s.projects.find((p) => p.id === sess.projectId) : undefined;
    return proj?.rootPath ?? sess?.cwd ?? null;
  });
  const [limits, setLimits] = useState<ProviderLimit[]>([]);
  const [roster, setRoster] = useState<FleetAgent[]>([]);
  const [recent, setRecent] = useState<Dispatch[]>([]);
  const [usage, setUsage] = useState<ProviderUsage[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try {
      const [l, ro, r, u] = await Promise.all([
        invoke<ProviderLimit[]>("heddle_provider_limits"),
        invoke<FleetAgent[]>("heddle_fleet_roster"),
        invoke<Dispatch[]>("heddle_recent", { limit: 30 }),
        invoke<ProviderUsage[]>("heddle_provider_usage"),
      ]);
      setLimits(l);
      setRoster(ro);
      setRecent(r);
      setUsage(u);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!isTauri) return null;

  const toggle = () =>
    setOpen((o) => {
      localStorage.setItem(OPEN_KEY, o ? "0" : "1");
      return !o;
    });

  // Scope filter: an agent belongs to the current project when its cwd is the project root or inside it
  // (worktrees like Rebuild-Project-Root.forms count as inside their sibling root's project by prefix on
  // the root's basename, so a fleet spread across worktrees still groups under one project).
  const inCurrentProject = (a: FleetAgent): boolean => {
    if (!currentProjectRoot) return true;
    const root = currentProjectRoot.replace(/\/+$/, "");
    if (a.cwd === root || a.cwd.startsWith(root + "/")) return true;
    const base = root.split("/").filter(Boolean).slice(-1)[0] ?? "";
    return base.length > 0 && a.cwd.split("/").some((seg) => seg === base || seg.startsWith(base + "."));
  };
  const scopedRoster = scope === "project" ? roster.filter(inCurrentProject) : roster;
  const hiddenCount = roster.length - scopedRoster.length;
  const liveAgents = scopedRoster.filter((a) => a.alive);
  const busyAgents = liveAgents.filter((a) => a.status === "busy" || a.workers.some((w) => !w.stale));
  const running = busyAgents.length;
  const setScopePersist = (s: RosterScope) => {
    localStorage.setItem(SCOPE_KEY, s);
    setScope(s);
  };
  // Hide TEST-orchestrator rows (heddle-core verification dispatches, not real work).
  const shownRecent = recent.filter((d) => d.orchestrator !== "TEST");

  return (
    <div className={"fleet" + (open ? " open" : "")}>
      <div
        className="fleet-bar"
        onClick={toggle}
        role="button"
        tabIndex={0}
        title="heddle Fleet — provider caps & dispatches"
      >
        <span className="fleet-chevron">{open ? "▾" : "▸"}</span>
        <span className="fleet-title">Fleet</span>
        {limits.length > 0 ? (
          <span className="fleet-sum">
            {limits.map((p) => {
              // One chip per provider: the tightest live window (5h if present, else 7d/monthly) so
              // the bar answers "how close is each provider to a wall" at a glance.
              const win = p.fiveHour?.usedPercentage != null ? p.fiveHour : p.sevenDay;
              const label = p.fiveHour?.usedPercentage != null ? "5h" : "7d";
              const pct = win?.usedPercentage;
              const color = providerColor(p.provider);
              return (
                <span
                  key={p.provider}
                  className={"fleet-chip-sum" + (p.stale ? " stale" : "")}
                  title={`${p.provider} · ${label} ${pct == null ? "—" : Math.round(pct) + "%"}${win?.resetsAt ? " · resets in " + fmtReset(win.resetsAt, now) : ""}${p.note ? " · " + p.note : ""}`}
                >
                  <span className="fleet-tag" style={{ color }}>{p.provider}</span>
                  <b style={{ color }}>{pct == null ? "—" : `${Math.round(pct)}%`}</b>
                  {win?.resetsAt ? <span className="fleet-dim">&nbsp;↻{fmtReset(win.resetsAt, now)}</span> : null}
                </span>
              );
            })}
          </span>
        ) : (
          <span className="fleet-dim">caps: waiting for a statusline render…</span>
        )}
        {liveAgents.length > 0 && (
          <span className="fleet-run" title={liveAgents.map((a) => `${a.name}: ${a.status}`).join(" · ")}>
            ● {running}/{liveAgents.length} agents busy
          </span>
        )}
        <span className="fleet-sp" />
        <button
          className="fleet-refresh"
          onClick={(e) => {
            e.stopPropagation();
            void refresh();
          }}
          title="Refresh"
        >
          ⟳
        </button>
      </div>

      {open && (
        <div className="fleet-body">
          {err && <div className="fleet-err">{err}</div>}

          <div className="fleet-sec-title">Provider caps · rate limits</div>
          {limits.length === 0 ? (
            <div className="fleet-dim fleet-empty">
              Waiting for the statusline tap to capture usage (renders on your next turn).
            </div>
          ) : (
            <div className="fleet-provcaps">
              {limits.map((p) => (
                <ProviderCapBlock key={p.provider} p={p} now={now} onRefresh={refresh} />
              ))}
            </div>
          )}

          {roster.length > 0 && (
            <>
              <div className="fleet-sec-title fleet-roster-head">
                <span>
                  Fleet roster · {liveAgents.length} agents ({running} busy) — click an agent to see its workers
                </span>
                <span className="fleet-scope" role="tablist" aria-label="roster scope">
                  <button
                    className={"fleet-scope-btn" + (scope === "project" ? " on" : "")}
                    onClick={() => setScopePersist("project")}
                    title={currentProjectRoot ? `Agents in ${shortCwd(currentProjectRoot)}` : "No project open — showing all"}
                    type="button"
                  >
                    Current project
                  </button>
                  <button
                    className={"fleet-scope-btn" + (scope === "all" ? " on" : "")}
                    onClick={() => setScopePersist("all")}
                    title="Every fleet-tagged agent on this machine, across projects"
                    type="button"
                  >
                    All agents{hiddenCount > 0 && scope === "project" ? ` (+${hiddenCount})` : ""}
                  </button>
                </span>
              </div>
              <div className="fleet-roster">
                {scopedRoster.map((a) => (
                  <AgentRow key={`${a.name}:${a.pid}`} a={a} now={now} />
                ))}
                {scopedRoster.length === 0 && (
                  <div className="fleet-dim fleet-empty">
                    No agents in the current project — switch to “All agents” to see the other {roster.length}.
                  </div>
                )}
              </div>
            </>
          )}

          <div className="fleet-sec-title">Recent dispatches · heddle ledger</div>
          {shownRecent.length === 0 ? (
            <div className="fleet-dim fleet-empty">No real dispatches yet.</div>
          ) : (
            shownRecent.map((d) => <DispatchRow key={d.id} d={d} />)
          )}

          <RouteMixPanel
            claudeFiveHourPct={
              limits.find((l) => l.provider === "claude")?.fiveHour?.usedPercentage ?? null
            }
          />
          <DisciplinePanel liveAgents={roster.filter((a) => a.alive).map((a) => a.name)} />

          {usage.length > 0 && (
            <>
              <div className="fleet-sec-title">By provider · heddle dispatches</div>
              {usage.map((u) => (
                <div key={u.provider} className="fleet-prow">
                  <span className="fleet-prov" style={{ color: providerColor(u.provider) }}>
                    {u.provider}
                  </span>
                  <span className="fleet-dim">
                    {u.dispatches} disp · {u.succeeded}✓
                  </span>
                  <span className="fleet-sp" />
                  <span className="fleet-dim">
                    {fmtTokens(u.inputTokens)} in · {fmtTokens(u.outputTokens)} out
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SegBar({
  pct,
  color,
  segments = 10,
}: {
  pct: number | null | undefined;
  color: string;
  segments?: number;
}) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const filled = Math.round((p / 100) * segments);
  return (
    <span className="fleet-seg" style={{ color }}>
      {"█".repeat(filled)}
      <span className="fleet-seg-empty">{"░".repeat(segments - filled)}</span>
    </span>
  );
}

function CapLine({
  label,
  win,
  color,
  now,
  note,
}: {
  label: string;
  win: LimitWindow;
  color: string;
  now: number;
  note?: string;
}) {
  const pct = win?.usedPercentage;
  return (
    <div className="fleet-capline">
      <span className="fleet-capline-lbl">{label}</span>
      <SegBar pct={pct} color={color} />
      <span className="fleet-capline-pct">{pct == null ? "" : `${Math.round(pct)}%`}</span>
      <span className="fleet-dim fleet-capline-reset" title={pct == null ? note : undefined}>
        {pct == null ? "no active window" : win?.resetsAt ? `↻ ${fmtReset(win.resetsAt, now)}` : ""}
      </span>
    </div>
  );
}

function ProviderCapBlock({
  p,
  now,
  onRefresh,
}: {
  p: ProviderLimit;
  now: number;
  onRefresh: () => Promise<void>;
}) {
  const color = providerColor(p.provider);
  const [refreshing, setRefreshing] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const capturedMinutes = p.capturedAt == null ? null : Math.max(0, Math.floor((now - p.capturedAt * 1_000) / 60_000));
  const isStale = p.stale ?? (capturedMinutes != null && capturedMinutes > 30);
  const accounts = p.accounts ?? [];
  const extraWindows = (p.windows ?? []).filter(
    (win) => win.id !== "fiveHour" && win.id !== "sevenDay" && win.id !== "five_hour" && win.id !== "seven_day",
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={"fleet-provcap" + (isStale ? " stale" : "")}>
      <div className="fleet-provcap-header">
        <div className="fleet-provcap-name" style={{ color }}>
          {p.provider}
          {p.note && <span className="fleet-provcap-note" title={p.note}>ⓘ</span>}
          {p.model && <span className="fleet-dim fleet-provcap-model">{p.model}</span>}
          <button
            className={"fleet-provcap-refresh" + (refreshing ? " refreshing" : "")}
            disabled={refreshing}
            onClick={() => void handleRefresh()}
            title={`Refresh ${p.provider} caps`}
            type="button"
          >
            ⟳
          </button>
        </div>
        {capturedMinutes != null && (
          <span className={"fleet-provcap-captured" + (isStale ? " stale" : "")}>
            captured {capturedMinutes}m ago{isStale ? " · stale" : ""}
          </span>
        )}
      </div>
      <CapLine label="5h" win={p.fiveHour} color={color} now={now} note={p.note} />
      <CapLine label="7d" win={p.sevenDay} color={color} now={now} />
      {accounts.length > 1 && (
        <div className="fleet-provcap-accounts">
          <button
            className="fleet-provcap-account-toggle"
            onClick={() => setAccountsExpanded((expanded) => !expanded)}
            type="button"
          >
            {accounts.length} accounts {accountsExpanded ? "▾" : "▸"}
          </button>
          {accountsExpanded && accounts.map((account, index) => (
            <div className="fleet-provcap-account" key={`${account.label ?? "account"}-${index}`}>
              <span className="fleet-provcap-account-label">{account.label ?? "account"}</span>
              {account.plan && <span className="fleet-provcap-account-plan">· {account.plan}</span>}
              <span className="fleet-provcap-account-caps">
                <SegBar pct={account.sevenDay?.usedPercentage} color={color} segments={6} />
                {account.sevenDay?.usedPercentage != null && ` ${Math.round(account.sevenDay.usedPercentage)}%`}
                {account.fiveHour?.usedPercentage != null && (
                  <>
                    <span className="fleet-provcap-account-separator">·</span>
                    <SegBar pct={account.fiveHour.usedPercentage} color={color} segments={6} /> {Math.round(account.fiveHour.usedPercentage)}%
                  </>
                )}
              </span>
              {account.limitReached && <span className="fleet-provcap-limit-reached">limit reached</span>}
            </div>
          ))}
        </div>
      )}
      {extraWindows.map((win, index) => (
        <div className="fleet-provcap-window" key={`${win.id ?? win.label ?? "window"}-${index}`}>
          <span>{win.label ?? win.id ?? "window"}</span>
          <span>{win.usedPercentage == null ? "" : `${Math.round(win.usedPercentage)}%`}</span>
          {win.resetsAt && <span className="fleet-dim">↻ {fmtReset(win.resetsAt, now)}</span>}
        </div>
      ))}
    </div>
  );
}

/** Short-form time since an epoch-ms timestamp: "12s" / "4m" / "2h 05m" / "3d". */
function fmtAgo(ms: number, now: number): string {
  let s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/** Trailing path segment(s) for a cwd — the worktree/repo name is what tells agents apart. */
function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-1)[0] ?? cwd;
}

/**
 * One named agent (fleet tag) with its status; click to expand the workers it has in flight.
 * Status glyph: busy = solid accent, idle/waiting = dim ring, dead = struck.
 */
function AgentRow({ a, now }: { a: FleetAgent; now: number }) {
  const [openRow, setOpenRow] = useState(false);
  const liveWorkers = a.workers.filter((w) => !w.stale);
  const staleWorkers = a.workers.filter((w) => w.stale);
  const busy = a.alive && (a.status === "busy" || liveWorkers.length > 0);
  const glyph = !a.alive ? "○" : busy ? "●" : "◌";
  const glyphClass = !a.alive ? "dead" : busy ? "busy" : "idle";
  const hasChildren = a.workers.length > 0;
  return (
    <div className={"fleet-agent" + (openRow ? " open" : "") + (a.alive ? "" : " dead")}>
      <div
        className={"fleet-agent-row" + (hasChildren ? " has-children" : "")}
        onClick={() => hasChildren && setOpenRow((o) => !o)}
        role={hasChildren ? "button" : undefined}
        title={`${a.name} · pid ${a.pid} · ${a.status} · ${a.cwd}`}
      >
        <span className={"fleet-agent-chev" + (hasChildren ? "" : " none")}>{hasChildren ? (openRow ? "▾" : "▸") : "·"}</span>
        <span className={"fleet-agent-glyph " + glyphClass}>{glyph}</span>
        <span className="fleet-agent-name">{a.name}</span>
        <span className="fleet-agent-status">{a.alive ? a.status : "gone"}</span>
        <span className="fleet-dim fleet-agent-cwd">{shortCwd(a.cwd)}</span>
        <span className="fleet-sp" />
        {liveWorkers.length > 0 && (
          <span className="fleet-agent-wcount" title="workers in flight">
            {liveWorkers.length} worker{liveWorkers.length === 1 ? "" : "s"}
          </span>
        )}
        {staleWorkers.length > 0 && (
          <span className="fleet-dim fleet-agent-stale" title="ledger rows started >12h ago that never finished (orphans)">
            {staleWorkers.length} stale
          </span>
        )}
        <span className="fleet-dim fleet-agent-age" title="last activity">
          {fmtAgo(a.updatedAtMs, now)}
        </span>
      </div>
      {openRow && hasChildren && (
        <div className="fleet-agent-workers">
          {a.workers.map((w) => (
            <div key={w.id} className={"fleet-worker" + (w.stale ? " stale" : "")}>
              <span className={"fleet-badge " + (w.stale ? "fail" : "run")}>{w.stale ? "◌" : "●"}</span>
              <span className="fleet-model">
                {w.provider}/{w.model.replace(/^cursor-/, "")}
              </span>
              <span className="fleet-dim">{w.taskClass}</span>
              <span className="fleet-sp" />
              <span className="fleet-dim fleet-worker-cwd">{shortCwd(w.cwd)}</span>
              <span className="fleet-dim fleet-durn">{w.stale ? "orphan" : fmtDur(w.elapsedMs)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DispatchRow({ d, live }: { d: Dispatch; live?: boolean }) {
  const ok = d.ok === 1;
  return (
    <div className={"fleet-drow" + (live ? " live" : "")}>
      <span className={"fleet-badge " + (live ? "run" : ok ? "ok" : "fail")}>
        {live ? "●" : ok ? "✓" : "✗"}
      </span>
      {d.orchestrator && <span className="fleet-orch">{d.orchestrator}</span>}
      <span className="fleet-model">
        {d.provider}/{d.model.replace(/^cursor-/, "")}
      </span>
      <span className="fleet-sp" />
      {d.issue && <span className="fleet-issue">{d.issue}</span>}
      <span className="fleet-dim fleet-tok">
        {fmtTokens(d.inputTokens)}→{fmtTokens(d.outputTokens)}
      </span>
      <span className="fleet-dim fleet-durn">{fmtDur(d.durationMs)}</span>
    </div>
  );
}
