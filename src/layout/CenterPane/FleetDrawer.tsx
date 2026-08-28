//! FleetDrawer — collapsible bottom drawer under the terminal stage. Surfaces heddle's orchestration
//! state in two distinct lenses:
//!   - PROVIDER CAPS: true rolling 5-hour / 7-day rate-limit usage per provider, captured live from
//!     each provider's Claude Code statusline payload by ~/.heddle/usage-tap.mjs (the SAME numbers the
//!     statusline shows — accurate, not a spend estimate).
//!   - DISPATCH LEDGER (~/.heddle/ledger.db): what heddle itself routed + how it turned out.
//! Read-only, desktop-only, polls on a timer. Degrades to "waiting…" when a source is absent.

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke, isTauri } from "../../ipc/transport";
import { useT } from "../../i18n";
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
  id: string;
  label: string;
  plan: string | null;
  capturedAt: number | null;
  stale: boolean | null;
  loggedIn: boolean | null;
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  windows?: LimitWindow[];
  limitReached: boolean | null;
  note: string | null;
  detail?: {
    fableWeekly?: FableWeeklyDetail | null;
  } | null;
  fableWeeklyEstimatePct?: number | null;
  fableWeeklySamples?: number | null;
}
interface FableWeeklyDetail {
  fablePct: number;
  otherPct: number;
  unknownPct: number;
  samples: number;
  exact: boolean;
  minSamples: number;
  windowResetsAt: number | null;
  lastCapturedAt: number | null;
  updatedAt: number | null;
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
  activeAccount?: string | null;
  windows?: LimitWindow[];
  fableWeeklyEstimatePct?: number | null;
  fableWeeklySamples?: number | null;
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
interface Hud {
  model?: string | null;
  contextPct?: number | null;
  capturedAt: number;
  stale: boolean;
  gitBranch?: string | null;
  gitDirty: boolean;
  claudeMdCount: number;
  rulesCount: number;
  mcpCount: number;
}
interface FleetAgent {
  name: string;
  model?: string | null;
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  kind: string;
  updatedAtMs: number;
  alive: boolean;
  workers: FleetWorker[];
  hud?: Hud | null;
}

const POLL_MS = 30_000;
const OPEN_KEY = "heddle-fleet-open";
// Roster scope: "project" = only agents whose cwd is inside the currently-open project (the active
// session's project root); "all" = every fleet-tagged session on the machine. Persisted. Default =
// project, so several projects can be worked at once without clutter (Maya, 2026-08-15).
const SCOPE_KEY = "heddle-fleet-roster-scope";
type RosterScope = "project" | "all";

const nowSubscribers = new Set<() => void>();
let sharedNow = Math.floor(Date.now() / 1000) * 1000;
let nowTicker: number | undefined;

function subscribeToSharedNow(onStoreChange: () => void): () => void {
  nowSubscribers.add(onStoreChange);
  if (nowSubscribers.size === 1) {
    nowTicker = window.setInterval(() => {
      sharedNow = Math.floor(Date.now() / 1000) * 1000;
      nowSubscribers.forEach((subscriber) => {
        subscriber();
      });
    }, 1_000);
  }
  return () => {
    nowSubscribers.delete(onStoreChange);
    if (nowSubscribers.size === 0 && nowTicker !== undefined) {
      window.clearInterval(nowTicker);
      nowTicker = undefined;
    }
  };
}

function useSharedNow(): number {
  return useSyncExternalStore(subscribeToSharedNow, () => sharedNow, () => sharedNow);
}

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
function LiveClock({ render }: { render: (nowMs: number) => ReactNode }) {
  const now = useSharedNow();
  return <>{render(now)}</>;
}

function ResetCountdown({ resetsAt }: { resetsAt: number | null | undefined }) {
  const t = useT();

  if (!resetsAt) return null;
  return <LiveClock render={(now) => <>{fmtReset(resetsAt, now, t("fleet.resetting"))}</>} />;
}
/** Countdown to a reset time given as epoch SECONDS: "3h 30m" / "2d 22h" / "5m". */
function fmtReset(resetsAtSec: number | null | undefined, now: number, resetting: string): string {
  if (!resetsAtSec) return "";
  let s = resetsAtSec - Math.floor(now / 1000);
  if (s <= 0) return resetting;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function capturedMinutesAgo(capturedAt: number | null, now: number): number | null {
  return capturedAt == null ? null : Math.max(0, Math.floor((now - capturedAt * 1_000) / 60_000));
}

// Age-based staleness in SECONDS (no whole-minute flooring), shared by the provider chip and the
// HED-213 selected-account override: a capture time older than the freshness budget (staleAfterSecs)
// is stale; with no capture time, trust the backend flag. The backend `stale` is itself purely
// age-based (capturedAt vs staleAfterSecs, judged at poll time — docs/USAGE_TAP.md), so this live
// recompute is the SAME semantics, just fresher between the 30s polls.
function isStaleByAge(
  capturedAt: number | null | undefined,
  staleAfterSecs: number | undefined,
  fallbackStale: boolean | null | undefined,
  now: number,
): boolean {
  if (capturedAt == null) return fallbackStale === true;
  return (now - capturedAt * 1_000) / 1_000 > (staleAfterSecs ?? 1_800);
}

function isProviderStale(p: ProviderLimit, now: number): boolean {
  return isStaleByAge(p.capturedAt, p.staleAfterSecs, p.stale, now);
}

/** For the collapsed chip: CLAUDE's most-constrained account with FRESH data (HED-213), so the chip
 *  reflects a live account instead of a possibly-idle active/top-level one. Freshness is by LIVE age
 *  (isStaleByAge with the passed `now`), so an account aging past staleAfterSecs isn't picked even
 *  before the backend flag catches up (cubic P2). Compares on a CONSISTENT window — the 5h rolling
 *  wall when any fresh account exposes it, else 7d — never mixing 5h and 7d in the max (qodo/cubic
 *  P1). Null for non-claude / no accounts / no fresh usable window. */
function pickClaudeChipAccount(
  p: ProviderLimit,
  now: number,
): { win: LimitWindow; label: string; account: ProviderAccount } | null {
  if (p.provider !== "claude" || !p.accounts?.length) return null;
  const fresh = p.accounts.filter((a) => !isStaleByAge(a.capturedAt, p.staleAfterSecs, a.stale, now));
  const with5h = fresh.filter((a) => a.fiveHour?.usedPercentage != null);
  const use5h = with5h.length > 0;
  const pool = use5h ? with5h : fresh;
  const label = use5h ? "5h" : "7d";
  let best: { win: LimitWindow; label: string; account: ProviderAccount } | null = null;
  let bestPct = -1;
  for (const account of pool) {
    const win = use5h ? account.fiveHour : account.sevenDay;
    const pct = win?.usedPercentage;
    if (win == null || pct == null) continue;
    if (best == null || pct > bestPct) {
      best = { win, label, account };
      bestPct = pct;
    }
  }
  return best;
}

/** Codex emits a per-model bucket (e.g. "GPT-5.3-Codex-Spark") at 0% with no $used/$limit for
 * every model you haven't touched; those empty buckets are noise in the caps view. Drop them —
 * but ONLY for codex: other providers legitimately emit 0% percent-only windows that must render
 * (Gemini's 3p-weekly / 3p-5h third-party pools, Cursor's included-* pools). Scoped by provider
 * because the bucket ids are model-name slugs, indistinguishable from those pools by id/label. */
function suppressCodexEmptyBuckets(limits: ProviderLimit[]): ProviderLimit[] {
  const isEmptyBucket = (w: LimitWindow) =>
    w.usedPercentage === 0 && w.usedAmount == null && w.limitAmount == null;
  const dropEmpty = (ws: LimitWindow[] | undefined) =>
    ws == null ? ws : ws.filter((w) => !isEmptyBucket(w));
  return limits.map((p) => {
    if (p.provider !== "codex") return p;
    return {
      ...p,
      windows: dropEmpty(p.windows),
      accounts: p.accounts?.map((a) => ({ ...a, windows: dropEmpty(a.windows) })),
    };
  });
}

export function FleetDrawer() {
  const t = useT();
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
      setLimits(suppressCodexEmptyBuckets(l));
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

  const toggle = () => {
    setOpen((o) => {
      localStorage.setItem(OPEN_KEY, o ? "0" : "1");
      return !o;
    });
  };

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
        <span className="fleet-title">{t("fleet.title")}</span>
        {limits.length > 0 ? (
          <span className="fleet-sum">
            {limits.map((p) => {
              const color = providerColor(p.provider);
              // One chip per provider: the tightest live window (5h if present, else 7d/monthly) so
              // the bar answers "how close is each provider to a wall" at a glance. Providers with no
              // 5h/7d at all (cursor: only 30-day pools) fall through to their PROMOTED windows, picking
              // the highest-percentage one (Maya, 2026-08-17: the chip must show cursor's real number,
              // not "—"). The WHOLE computation runs inside LiveClock so the claude account pick AND
              // staleness both recompute live each second — an aging selected account yields to a
              // fresher one within the second, not at the next 30s poll (cubic) — and no Date.now()
              // runs during render.
              return (
                <LiveClock key={p.provider} render={(nowMs) => {
                  let win: LimitWindow | undefined = p.fiveHour?.usedPercentage != null ? p.fiveHour : p.sevenDay;
                  let label = p.fiveHour?.usedPercentage != null ? "5h" : "7d";
                  // HED-213: for claude, the chip reflects the most-constrained FRESH account (not the
                  // possibly-idle active/top-level one) — see pickClaudeChipAccount.
                  const claudePick = pickClaudeChipAccount(p, nowMs);
                  let accountLabel: string | null = null;
                  let selectedAccount: ProviderAccount | null = null;
                  if (claudePick) {
                    win = claudePick.win;
                    label = claudePick.label;
                    accountLabel = claudePick.account.id;
                    selectedAccount = claudePick.account;
                  }
                  // Branch on the usable list ITSELF (not shouldPromoteWindows) so the reduce's
                  // non-empty proof is local to this block — corgea, PR #47.
                  const usable = filterExtraWindows(p.windows ?? []).filter(isUsableWindow);
                  if (!selectedAccount && isNullWindow(p.fiveHour) && isNullWindow(p.sevenDay) && usable.length > 0) {
                    const tightest = usable.reduce((a, b) =>
                      (b.usedPercentage ?? -1) > (a.usedPercentage ?? -1) ? b : a);
                    win = tightest;
                    label = shortWindowLabel(tightest);
                  }
                  const pct = win?.usedPercentage ?? null;
                  const chipStale = selectedAccount
                    ? isStaleByAge(selectedAccount.capturedAt, p.staleAfterSecs, selectedAccount.stale, nowMs)
                    : isProviderStale(p, nowMs);
                  return (
                    <span
                      className={"fleet-chip-sum" + (chipStale ? " stale" : "")}
                      title={`${p.provider}${accountLabel ? " · " + accountLabel : ""} · ${label} ${pct == null ? "—" : Math.round(pct) + "%"}${p.note ? " · " + p.note : ""}`}
                    >
                      <span className="fleet-tag" style={{ color }}>{p.provider}</span>
                      {accountLabel && <span className="fleet-chip-acct fleet-dim">{accountLabel}</span>}
                      <b style={{ color }}>{pct == null ? "—" : `${Math.round(pct)}%`}</b>
                      {win?.resetsAt ? <span className="fleet-dim">&nbsp;↻<ResetCountdown resetsAt={win.resetsAt} /></span> : null}
                    </span>
                  );
                }} />
              );
            })}
          </span>
        ) : (
          <span className="fleet-dim">{t("fleet.capsWaiting")}</span>
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
          title={t("fleet.refresh")}
          aria-label={t("fleet.refresh")}
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
                <ProviderCapBlock key={p.provider} p={p} onRefresh={refresh} />
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
                    {t("fleet.currentProject")}
                  </button>
                  <button
                    className={"fleet-scope-btn" + (scope === "all" ? " on" : "")}
                    onClick={() => setScopePersist("all")}
                    title="Every fleet-tagged agent on this machine, across projects"
                    type="button"
                  >
                    {t("fleet.allAgents")}{hiddenCount > 0 && scope === "project" ? ` (+${hiddenCount})` : ""}
                  </button>
                </span>
              </div>
              <div className="fleet-roster">
                {scopedRoster.map((a) => (
                  <AgentRow key={`${a.name}:${a.pid}`} a={a} />
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
              limits.find((l) => l.provider === "claude")?.fiveHour.usedPercentage ?? null
            }
          />
          <DisciplinePanel liveAgents={liveAgents.map((a) => a.name)} />

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
  softCapTick = false,
}: {
  pct: number | null | undefined;
  color: string;
  segments?: number;
  softCapTick?: boolean;
}) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const filled = Math.round((p / 100) * segments);
  return (
    <span className="fleet-seg" style={{ color }}>
      <span className="fleet-seg-run">
        {"█".repeat(filled)}
        <span className="fleet-seg-empty">{"░".repeat(segments - filled)}</span>
        {softCapTick && <span className="fleet-seg-soft-cap fleet-seg-soft-cap-tick" aria-hidden="true" />}
      </span>
    </span>
  );
}

function FableWeeklyLine({ account, color }: { account: ProviderAccount; color: string }) {
  const t = useT();
  const pct = account.fableWeeklyEstimatePct;
  const detail = account.detail?.fableWeekly;

  if (pct == null) {
    return <div className="fleet-provcap-account-row fleet-provcap-fable-weekly fleet-provcap-spacer">&nbsp;</div>;
  }

  const roundedPct = Math.round(pct);
  const label = detail?.exact ? t("fleet.fableWeeklyExact", roundedPct) : t("fleet.fableWeekly", roundedPct);
  const title = detail
    ? t("fleet.fableWeeklyBreakdown", Math.round(detail.fablePct), Math.round(detail.otherPct), Math.round(detail.unknownPct), detail.samples)
    : undefined;
  return (
    <div className="fleet-capline fleet-provcap-account-row fleet-provcap-fable-weekly" title={title}>
      <span className="fleet-capline-lbl fleet-provcap-fable-label" title={label} aria-label={label}>Fable</span>
      <SegBar pct={pct} color={color} softCapTick />
      <span className="fleet-capline-pct fleet-provcap-fable-est" title={label}>{`${roundedPct}%`}</span>
      <span className="fleet-dim fleet-capline-reset" title={label}>{detail?.exact ? "" : t("fleet.fableWeeklyEstMark")}</span>
    </div>
  );
}

/** `$used / $limit` for a usd-denominated window; falls back to whichever side is present. `null`
 * for non-usd windows or when neither amount is known. (Grafted from #51 — W's design.) */
function fmtWindowUsedLimit(win: LimitWindow): string | null {
  if (win.unit !== "usd") return null;
  const used = win.usedAmount != null ? `$${win.usedAmount.toFixed(2)}` : null;
  const limit = win.limitAmount != null ? `$${win.limitAmount.toFixed(2)}` : null;
  if (used && limit) return `${used} / ${limit}`;
  return used ?? limit;
}

function CapLine({
  label,
  win,
  color,
  note,
  className,
  title,
  namedWindow = false,
}: {
  label: string;
  win: LimitWindow;
  color: string;
  note?: string | null;
  className?: string;
  title?: string;
  /** Named/promoted pools (#51's insight) keep their reset clock + any $used/$limit visible rather
   *  than the "no active window" line even when idle. (The null-pct → indeterminate dash is now
   *  universal — HED-209 — applied to rolling 5h/7d too, so no window ever renders as a 0%-filled
   *  bar just because it has no measurement.) */
  namedWindow?: boolean;
}) {
  const t = useT();
  const pct = win.usedPercentage;
  const pctLabel = pct == null ? "" : `${Math.round(pct)}%`;
  const amount = namedWindow ? fmtWindowUsedLimit(win) : null;
  return (
    <div className={"fleet-capline" + (className ? ` ${className}` : "")}>
      <span className="fleet-capline-lbl" title={title ?? label}>{label}</span>
      {/* HED-209: a null pct means "no measurement", not zero — render the indeterminate dash for
          ANY window (rolling 5h/7d included), never a 0%-filled SegBar that reads as a real 0%.
          Guard is `== null` so a genuine pct === 0 still draws an empty bar + "0%". */}
      {pct == null ? <span className="fleet-capline-indeterminate" title={title ?? label}>—</span> : <SegBar pct={pct} color={color} />}
      <span className="fleet-capline-pct" title={pctLabel}>{pctLabel}</span>
      <LiveClock render={(now) => {
        if (namedWindow) {
          const reset = win.resetsAt ? `↻ ${fmtReset(win.resetsAt, now, t("fleet.resetting"))}` : "";
          const text = [reset, amount].filter(Boolean).join(" · ");
          const full = [reset, amount, note].filter(Boolean).join(" · ");
          return <span className="fleet-dim fleet-capline-reset" title={full}>{text}</span>;
        }
        // Reset clock semantics for the rolling (non-named) branch:
        //  - MEASURED window (pct != null): keep the reset clock for any resetsAt, as before — an
        //    elapsed timestamp renders "↻ resetting" (the window is rolling over).
        //  - NO-MEASUREMENT window (pct == null): it's "active" ONLY with a FUTURE resetsAt (the
        //    keeper-estimate state — Copilot review). An EXPIRED or absent resetsAt is stale data,
        //    not an active window, so show "no active window" rather than a misleading "↻ resetting"
        //    (qodo review — fmtReset returns the resetting label for an elapsed timestamp).
        const nowSec = Math.floor(now / 1000);
        const resetClock = win.resetsAt ? `↻ ${fmtReset(win.resetsAt, now, t("fleet.resetting"))}` : null;
        const futureReset = win.resetsAt != null && win.resetsAt > nowSec ? resetClock : null;
        const resetText = pct != null ? (resetClock ?? "") : (futureReset ?? t("fleet.noActiveWindow"));
        // Keep the diagnostic note in the tooltip whenever the window has no measurement (cubic
        // review); a real pct keeps no note, as before.
        const resetTitle = pct == null ? [resetText, note].filter(Boolean).join(" · ") : resetText;
        return <span className="fleet-dim fleet-capline-reset" title={resetTitle}>{resetText}</span>;
      }} />
    </div>
  );
}

/** Extra named windows beyond 5h/7d (the shape both the provider-level and per-account `windows[]` share). */
function filterExtraWindows(windows: LimitWindow[] | null | undefined): LimitWindow[] {
  return (windows ?? []).filter(
    (win) => win.id !== "fiveHour" && win.id !== "sevenDay" && win.id !== "five_hour" && win.id !== "seven_day",
  );
}

function isNullWindow(win: LimitWindow | null | undefined): boolean {
  return (win?.usedPercentage ?? null) == null;
}

/** A window carries real data worth rendering — a bare id/label with nothing else (e.g. a named
 * window emitted for a failed/disabled account fetch) does not. */
function isUsableWindow(win: LimitWindow | null | undefined): boolean {
  return win != null && (win.usedPercentage != null || win.resetsAt != null);
}

/** True when neither rolling window carries real data but at least one named window does — the
 * case where those windows should stand in for 5h/7d as the primary bars. */
function shouldPromoteWindows(
  fiveHour: LimitWindow | null | undefined,
  sevenDay: LimitWindow | null | undefined,
  windows: LimitWindow[],
): boolean {
  return isNullWindow(fiveHour) && isNullWindow(sevenDay) && windows.some(isUsableWindow);
}

/** An account is worth defaulting to when it has real 5h/7d data or at least one usable named window. */
function accountHasUsableData(account: ProviderAccount): boolean {
  return (
    !isNullWindow(account.fiveHour) ||
    !isNullWindow(account.sevenDay) ||
    filterExtraWindows(account.windows).some(isUsableWindow)
  );
}

/**
 * Short column label (fits the 40px label column) for a window promoted to a primary CapLine.
 * The three Cursor pools are hand-mapped since their real labels don't reduce mechanically
 * (the API pool's label leads with "included", not "API"); anything else falls back to its
 * label's first word, truncated to 4 chars.
 */
function shortWindowLabel(win: LimitWindow): string {
  switch (win.id) {
    case "included-total": return "INCL";
    case "included-api": return "API";
    case "usage-based": return "O-D";
    case "3p-weekly": return "3P 7d";
    case "3p-5h": return "3P 5h";
    default: {
      const firstWord = (win.label ?? win.id ?? "").trim().split(/\s+/)[0] ?? "";
      return firstWord.slice(0, 4).toUpperCase();
    }
  }
}

/**
 * Short labels for a block of windows rendered together, de-duplicated by window order: a
 * collision (e.g. two windows both truncating to "INCL") appends a numeric suffix to the later
 * one(s) — INCL, INCL2, INCL3 — so the block never shows the same label twice.
 */
function shortWindowLabels(windows: LimitWindow[]): string[] {
  const seen = new Map<string, number>();
  return windows.map((win) => {
    const base = shortWindowLabel(win);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}${count}`;
  });
}

function fmtWindowAmount(n: number | null | undefined, unit: string | null | undefined): string {
  if (n == null) return "";
  if (unit === "usd") return `$${n.toFixed(2)}`;
  return unit ? `${n} ${unit}` : String(n);
}

/** Full label + amounts for a promoted window's tooltip — the short column label loses this detail. */
function windowTooltip(win: LimitWindow): string {
  const full = win.label ?? win.id ?? "window";
  if (win.usedAmount != null && win.limitAmount != null) {
    return `${full} — ${fmtWindowAmount(win.usedAmount, win.unit)} of ${fmtWindowAmount(win.limitAmount, win.unit)}`;
  }
  return full;
}

/**
 * Renders 5h/7d as usual, unless both are empty and at least one named window carries usable data
 * (usedPercentage or resetsAt) — then the usable named windows become the primary CapLines instead
 * (short deduped label + SegBar, full detail in the title tooltip). Windows lacking both fields
 * (e.g. from a failed/disabled account fetch) never render as a CapLine.
 * When 5h/7d are NOT promoted, any usable named windows still render as additional CapLines beneath
 * them — accounts with real 5h/7d and per-model windows (e.g. codex) keep both, not just the pair.
 * Shared by the provider-level caps and each account's caps inside the account cycler.
 */
function CapLineGroup({
  fiveHour,
  sevenDay,
  windows,
  color,
  note,
  className,
}: {
  fiveHour: LimitWindow | null | undefined;
  sevenDay: LimitWindow | null | undefined;
  windows: LimitWindow[];
  color: string;
  note?: string | null;
  className?: string;
}) {
  const usableWindows = windows.filter(isUsableWindow);
  const labels = shortWindowLabels(usableWindows);
  const renderNamedWindows = (withNote: boolean) =>
    usableWindows.map((win, index) => (
      <CapLine
        key={`${win.id ?? win.label ?? "window"}-${index}`}
        label={labels[index]}
        win={win}
        color={color}
        note={withNote && index === 0 ? note : undefined}
        title={windowTooltip(win)}
        className={className}
        namedWindow
      />
    ));

  if (shouldPromoteWindows(fiveHour, sevenDay, windows)) {
    return <>{renderNamedWindows(true)}</>;
  }
  return (
    <>
      <CapLine label="5h" win={fiveHour ?? { usedPercentage: null, resetsAt: null }} color={color} note={note} className={className} />
      <CapLine label="7d" win={sevenDay ?? { usedPercentage: null, resetsAt: null }} color={color} className={className} />
      {renderNamedWindows(false)}
    </>
  );
}

/**
 * One account's detail: head row (id · label · i/N chip · ⟳ rotate), its caplines (promoted when
 * eligible), and the captured/state rows. Shared by any provider with accounts.length >= 2, plus
 * Claude at accounts.length >= 1 (Claude keeps showing its single account's detail instead of the
 * top-level 5h/7d). FableWeeklyLine and the login-state/keeper-estimate messaging stay Claude-only —
 * other providers only surface a state row when their account actually carries loggedIn/limitReached
 * data, and hide it entirely otherwise.
 */
function AccountCycler({
  p,
  accounts,
  selectedAccountId,
  onSelectAccount,
  color,
}: {
  p: ProviderLimit;
  accounts: ProviderAccount[];
  selectedAccountId: string | undefined;
  onSelectAccount: (_id: string) => void;
  color: string;
}) {
  const t = useT();
  const isClaude = p.provider === "claude";
  // Index is clamped to [0, length-1] and the cycler only renders with accounts.length >= 1
  // (showAccountCycler gate), so this access cannot miss — no guard (codacy, PR #47).
  const selectedAccountIndex = Math.max(0, accounts.findIndex((account) => account.id === selectedAccountId));
  const selectedAccount = accounts[selectedAccountIndex];
  const acctWindows = filterExtraWindows(selectedAccount.windows);

  return (
    <div className="fleet-provcap-account-detail">
      <div className="fleet-provcap-account-row fleet-provcap-account-head">
        <span className="fleet-provcap-account-label" title={selectedAccount.id}>{selectedAccount.id}</span>
        {selectedAccount.label && selectedAccount.label !== selectedAccount.id && (
          <span className="fleet-provcap-account-plan" title={`· ${selectedAccount.label}`}>· {selectedAccount.label}</span>
        )}
        {accounts.length > 1 && <>
          <span className="fleet-sp" />
          <span className="fleet-provcap-account-position" title={`${selectedAccountIndex + 1}/${accounts.length}`}>{selectedAccountIndex + 1}/{accounts.length}</span>
          <button
            className="fleet-provcap-account-rotate"
            onClick={() => {
              onSelectAccount(accounts[(selectedAccountIndex + 1) % accounts.length].id);
            }}
            aria-label={t("fleet.rotateAccounts")}
            title={t("fleet.rotateAccounts")}
            type="button"
          >
            ⟳
          </button>
        </>}
      </div>
      <CapLineGroup
        fiveHour={selectedAccount.fiveHour}
        sevenDay={selectedAccount.sevenDay}
        windows={acctWindows}
        color={color}
        note={selectedAccount.note}
        className="fleet-provcap-account-row"
      />
      {isClaude && <FableWeeklyLine account={selectedAccount} color={color} />}
      <LiveClock render={(now) => {
        const capturedAt = selectedAccount.capturedAt ?? (p.activeAccount === selectedAccount.id ? p.capturedAt : null);
        const capturedMinutes = capturedMinutesAgo(capturedAt, now);
        const liveStale = isStaleByAge(capturedAt, p.staleAfterSecs, selectedAccount.stale, now);
        const showMarker = liveStale && selectedAccount.loggedIn !== false;
        // The "idle" framing (with the 5h/7d-only-while-driven hint) is Claude-specific: its 5h/7d
        // come from the statusline tap, so an idle account's numbers simply aren't refreshing.
        // Codex/Cursor set loggedIn=null and their `stale` is a real fetch/refresh FAILURE — keep the
        // actionable "stale" warning for them, never a reassuring "idle".
        // "idle" implies a logged-IN account whose numbers just aren't refreshing; require
        // loggedIn === true so an unknown-login (null) account shows the honest "stale" marker
        // instead of a reassuring "idle" that would contradict the "login unknown" state row (qodo).
        const isIdle = showMarker && isClaude && selectedAccount.loggedIn === true;
        const markerText = showMarker ? ` · ${t(isIdle ? "fleet.idle" : "fleet.stale")}` : "";
        const markerTooltip = showMarker ? ` · ${t(isIdle ? "fleet.idleHint" : "fleet.stale")}` : "";
        const capturedTooltip = capturedMinutes != null ? `${t("fleet.capturedMinutesAgo", capturedMinutes)}${markerTooltip}` : "—";
        const keeperEstimate = [selectedAccount.fiveHour, selectedAccount.sevenDay].some(
          (window) => window?.usedPercentage == null && (window?.resetsAt ?? 0) > Math.floor(now / 1_000),
        );
        const stateMessages = [
          selectedAccount.loggedIn === false ? t("fleet.loggedOut") : null,
          isClaude && selectedAccount.loggedIn == null ? t("fleet.loginUnknown") : null,
          isClaude && selectedAccount.loggedIn === true && keeperEstimate ? t("fleet.keeperEstimate") : null,
          selectedAccount.limitReached ? t("fleet.limitReached") : null,
        ].filter((message): message is string => message != null);
        return (
          <>
            <div className="fleet-provcap-account-row fleet-provcap-captured-row" title={capturedTooltip}>
              {capturedMinutes != null ? (
                <span className={"fleet-provcap-captured" + (showMarker ? (isIdle ? " idle" : " stale") : "")}>
                  {t("fleet.capturedMinutesAgo", capturedMinutes)}{markerText}
                </span>
              ) : "—"}
            </div>
            {(isClaude || stateMessages.length > 0) && (
              <div className="fleet-provcap-account-row fleet-provcap-account-state" title={stateMessages.join(" · ") || undefined}>
                {selectedAccount.loggedIn === false && <span className="fleet-provcap-logged-out" title={t("fleet.loggedOut")}>{t("fleet.loggedOut")}</span>}
                {isClaude && selectedAccount.loggedIn == null && <span className="fleet-dim" title={t("fleet.loginUnknown")}>{t("fleet.loginUnknown")}</span>}
                {isClaude && selectedAccount.loggedIn === true && keeperEstimate && <span className="fleet-provcap-keeper-estimate" title={t("fleet.keeperEstimate")}>{t("fleet.keeperEstimate")}</span>}
                {selectedAccount.limitReached && <span className="fleet-provcap-limit-reached" title={t("fleet.limitReached")}>{t("fleet.limitReached")}</span>}
                {stateMessages.length === 0 && <span className="fleet-provcap-spacer">&nbsp;</span>}
              </div>
            )}
          </>
        );
      }} />
    </div>
  );
}

function ProviderCapBlock({
  p,
  onRefresh,
}: {
  p: ProviderLimit;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const color = providerColor(p.provider);
  // Subscribe to the shared 1s clock so the block's stale styling transitions live between the 30s
  // polls (qodo/cubic review). Scoped to this provider block, not all of FleetDrawer; the block
  // already re-renders its captured-row + reset countdowns every 1s via LiveClock, so re-rendering
  // its static parts too is marginal (a handful of small blocks).
  const now = useSharedNow();
  const isStale = isProviderStale(p, now);
  const [refreshing, setRefreshing] = useState(false);
  const accounts = p.accounts ?? [];
  // Claude keeps its single-account detail view at accounts.length === 1; every other provider only
  // switches from the top-level 5h/7d to the account cycler once there's more than one account to cycle.
  const showAccountCycler = accounts.length >= 2 || (p.provider === "claude" && accounts.length >= 1);
  // Prefer the active account; when absent, default to the first account with real data rather than
  // blindly accounts[0] — a failed/disabled fetch shouldn't be the face the drawer opens to.
  const defaultAccountId = p.activeAccount && accounts.some((account) => account.id === p.activeAccount)
    ? p.activeAccount
    : (accounts.find(accountHasUsableData) ?? accounts[0])?.id;
  const [selectedAccountId, setSelectedAccountId] = useState(defaultAccountId);
  useEffect(() => {
    setSelectedAccountId(defaultAccountId);
  }, [defaultAccountId]);
  const effectiveSelectedId = selectedAccountId ?? defaultAccountId;
  const extraWindows = filterExtraWindows(p.windows);
  // CapLineGroup below already renders extraWindows (promoted or as supplementary CapLines) whenever
  // the cycler is off, so `.fleet-provcap-extras` only ever has something to show for the cycler itself.
  const hasExtras = showAccountCycler;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      try {
        await invoke<string[]>("heddle_refresh_provider_limits", { provider: p.provider });
      } catch (err) {
        console.error("heddle: provider refresh failed", err);
      }
      await onRefresh();
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={"fleet-provcap" + (isStale ? " stale" : "")}>
      <div className="fleet-provcap-name" style={{ color }}>
        <span className="fleet-provcap-provider" title={p.provider}>{p.provider}</span>
        {p.note && <span className="fleet-provcap-note" title={p.note}>ⓘ</span>}
        {showAccountCycler ? <span className="fleet-dim fleet-provcap-model" title={`${accounts.length} acct`}>{accounts.length} acct</span> : p.model && <span className="fleet-dim fleet-provcap-model" title={p.model}>{p.model}</span>}
        <button
          className={"fleet-provcap-refresh" + (refreshing ? " refreshing" : "")}
          disabled={refreshing}
          onClick={() => {
            void handleRefresh();
          }}
          title={`${t("fleet.refresh")} ${p.provider} caps`}
          aria-label={t("fleet.refresh")}
          type="button"
        >
          ⟳
        </button>
      </div>
      {!showAccountCycler && <LiveClock render={(now) => {
        const capturedMinutes = capturedMinutesAgo(p.capturedAt, now);
        const providerIsStale = isProviderStale(p, now);
        return (
          <div className="fleet-provcap-captured-row" title={capturedMinutes != null ? `${t("fleet.capturedMinutesAgo", capturedMinutes)}${providerIsStale ? ` · ${t("fleet.stale")}` : ""}` : "—"}>
            {capturedMinutes != null ? (
              <span className={"fleet-provcap-captured" + (providerIsStale ? " stale" : "")} title={`${t("fleet.capturedMinutesAgo", capturedMinutes)}${providerIsStale ? ` · ${t("fleet.stale")}` : ""}`}>
                {t("fleet.capturedMinutesAgo", capturedMinutes)}{providerIsStale ? ` · ${t("fleet.stale")}` : ""}
              </span>
            ) : "—"}
          </div>
        );
      }} />}
      {!showAccountCycler && (
        <CapLineGroup fiveHour={p.fiveHour} sevenDay={p.sevenDay} windows={extraWindows} color={color} note={p.note} />
      )}
      {/* A single-account non-Claude provider has no cycler, but its one account's trouble states
          must still surface — without this, a logged-out or limit-hit lone account is invisible
          (gitar, PR #47). Info without the cycler chrome. */}
      {!showAccountCycler && accounts.length === 1 && (accounts[0].loggedIn === false || accounts[0].limitReached) && (
        <div className="fleet-provcap-account-row fleet-provcap-account-state" title={accounts[0].id}>
          {accounts[0].loggedIn === false && <span className="fleet-provcap-logged-out" title={t("fleet.loggedOut")}>{t("fleet.loggedOut")}</span>}
          {accounts[0].limitReached && <span className="fleet-provcap-limit-reached" title={t("fleet.limitReached")}>{t("fleet.limitReached")}</span>}
        </div>
      )}
      {hasExtras && (
        <div className="fleet-provcap-extras">
          <AccountCycler p={p} accounts={accounts} selectedAccountId={effectiveSelectedId} onSelectAccount={setSelectedAccountId} color={color} />
        </div>
      )}
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

// Exact ids with a bespoke short form; anything else falls through to the generic rules below.
const MODEL_DISPLAY: Record<string, string> = {
  "claude-fable-5": "fable",
  "claude-opus-4-8": "opus 4.8",
  "claude-opus-5": "opus 5",
};
const MODEL_FAMILY_WORDS = ["sonnet", "haiku", "opus", "fable"];
const MODEL_CHIP_MAX_CHARS = 12;

function truncateModelChip(label: string): string {
  return label.length > MODEL_CHIP_MAX_CHARS ? `${label.slice(0, MODEL_CHIP_MAX_CHARS - 1)}…` : label;
}

/** Short display form for a fleet agent's own model id — the chip text (full id stays in the tooltip). */
function shortModel(id: string): string {
  // `id` is process-derived, never trust a bracket lookup with it directly — an id of literally
  // "constructor" or "toString" must fall through to the generic path below, not resolve to an
  // Object.prototype member.
  if (Object.prototype.hasOwnProperty.call(MODEL_DISPLAY, id)) return MODEL_DISPLAY[id];
  if (id.startsWith("claude-sonnet-")) return "sonnet";
  if (id.startsWith("claude-haiku-")) return "haiku";
  const remainder = id.startsWith("claude-") ? id.slice("claude-".length) : id;
  const [family, ...versionTokens] = remainder.split("-");
  if (MODEL_FAMILY_WORDS.includes(family)) {
    return truncateModelChip([family, ...versionTokens].join(" "));
  }
  return truncateModelChip(id.split("-").slice(-2).join("-"));
}

/**
 * One named agent (fleet tag) with its status; click to expand the workers it has in flight.
 * Status glyph: busy = solid accent, idle/waiting = dim ring, dead = struck.
 */
function AgentHudLine({ hud }: { hud: Hud }) {
  const t = useT();
  return <LiveClock render={(now) => {
    const stale = isStaleByAge(hud.capturedAt, 900, hud.stale, now);
    const chunks = [
      hud.model ? t("fleet.hudModel", hud.model) : null,
      hud.gitBranch ? t("fleet.hudGit", hud.gitBranch, hud.gitDirty) : null,
      hud.contextPct != null ? t("fleet.hudContext", hud.contextPct) : null,
      t("fleet.hudResources", hud.claudeMdCount, hud.rulesCount, hud.mcpCount),
      stale ? t("fleet.hudAge", fmtAgo(hud.capturedAt * 1_000, now)) : null,
    ].filter((chunk): chunk is string => chunk != null);
    // Caps await an account field on the capture (#106 follow-up).
    return <div className={"fleet-agent-hud" + (stale ? " fleet-dim stale" : "")}>{chunks.join(t("fleet.hudSeparator"))}</div>;
  }} />;
}

function AgentRow({ a }: { a: FleetAgent }) {
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
        title={`${a.name}${a.model ? ` · ${a.model}` : ""} · pid ${a.pid} · ${a.status} · ${a.cwd}`}
      >
        <span className={"fleet-agent-chev" + (hasChildren ? "" : " none")}>{hasChildren ? (openRow ? "▾" : "▸") : "·"}</span>
        <span className={"fleet-agent-glyph " + glyphClass}>{glyph}</span>
        <span className="fleet-agent-name">{a.name}</span>
        {a.alive && a.model && <span className="fleet-agent-model">{shortModel(a.model)}</span>}
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
        <LiveClock render={(now) => (
          <span className="fleet-dim fleet-agent-age" title="last activity">
            {fmtAgo(a.updatedAtMs, now)}
          </span>
        )} />
      </div>
      {a.hud && <AgentHudLine hud={a.hud} />}
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
