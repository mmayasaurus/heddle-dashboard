//! Right-side Info tab: basic session details and uptime, model/context, Claude/Codex/Grok quotas,
//! current-turn statistics, and process-tree CPU/memory usage at the bottom. Extracted from RightPanel;
//! usage helpers are private to this tab, while the shared KV row lives in parts.

import { useCallback, useEffect, useRef, useState } from "react";
import Icons from "../../components/Icons";
import { fmtBytes, fmtTokens } from "../../format";
import { dateLocale } from "../../i18n";
import { useGitBranch } from "../../hooks/useGitBranch";
import {
  agentContextInfo,
  agentTurnStats,
  claudeUsage,
  codexUsage,
  grokUsage,
  type AgentContextInfo,
  type AgentTurnStats,
  type ClaudeUsage,
  type CodexUsage,
  type GrokUsage,
} from "../../ipc/commands";
import { processStats, type ProcStats } from "../../ipc/info";
import { effectiveStatus, type Session, type SessionKind } from "../../types";
import { useTermStore } from "../../store/termStore";
import { usageBrandIconEl } from "../../components/brandIcons";
import { kindIconEl } from "../sessionViewers/sessionMeta";
import { KV } from "./parts";

/** Stop automatic quota reads after this many consecutive failures; manual refresh resets the breaker. */
const USAGE_MAX_FAILS = 3;

/** Format uptime as 12s, 4m 12s, 1h 3m, or 2d 5h. */
function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** One-second clock tick for leaf components, limiting rerenders to the small regions that display it. */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Self-contained uptime row that rerenders only this KV each second. */
function UptimeKV({ startedAt }: { startedAt: number | undefined }) {
  const now = useNowTick();
  return <KV k="uptime" v={startedAt ? fmtUptime(now - startedAt) : "—"} />;
}

/** Resources leaf: sample CPU and memory for the session's PID tree every three seconds and rerender
 * only this section. `processStats` runs through desktop_call on the blocking thread pool. Polling
 * occurs only while this component is mounted and stops when the panel is hidden. */
function ResourcesSection({ pid }: { pid: number | undefined }) {
  const [stats, setStats] = useState<ProcStats | null>(null);
  useEffect(() => {
    if (pid == null) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const sample = () =>
      processStats(pid)
        .then((s) => !cancelled && setStats(s))
        .catch(() => !cancelled && setStats(null));
    sample();
    // Three seconds still appears live to users while reducing sampling cost by one-third versus 2s.
    const t = setInterval(sample, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pid]);

  return (
    <div className="insp-section">
      <h4>Resources</h4>
      <KV k="cpu" v={stats ? `${stats.cpu.toFixed(1)}%` : "—"} />
      <KV k="memory" v={stats ? fmtBytes(stats.rssBytes) : "—"} />
    </div>
  );
}

/** Normalize Claude ISO strings and Codex Unix seconds to Date, returning null for invalid values. */
function toResetDate(at: string | number | null | undefined): Date | null {
  if (at == null || at === "") return null;
  const d = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format quota reset time as local 24-hour HH:mm, adding M/D when it falls on another day. */
function fmtAbsTime(d: Date): string {
  const hm = d.toLocaleTimeString(dateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  const md = d.toLocaleDateString(dateLocale(), { month: "numeric", day: "numeric" });
  return `${md} ${hm}`;
}

/** Countdown to automatic refresh as mm:ss or h:mm:ss, clamped to 0:00 and driven by `now`. */
function fmtRefreshLeft(ms: number): string {
  let s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Format the "updated at" time as HH:mm:ss. */
function fmtUpdatedAt(ts: number): string {
  return new Date(ts).toLocaleTimeString(dateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Convert a Codex window length in minutes to labels such as 5h, 7d, or 30d. */
function codexWindowLabel(min: number): string {
  if (min <= 360) return "5h";
  if (min < 1440) return `${Math.round(min / 60)}h`;
  if (min <= 10080) return "7d";
  if (min <= 44640) return "30d";
  return `${Math.round(min / 1440)}d`;
}

/** Color usage percentages by severity: red at 90%, orange at 70%, otherwise normal. */
function usageColor(pct: number): string {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--orange, #d8954a)";
  return "var(--text-primary)";
}

/** Quota row with a label and the used percentage plus the window's reset time. */
function UsageRow({
  label,
  pct,
  reset,
}: {
  label: string;
  pct: number;
  reset?: string | number | null;
}) {
  const target = toResetDate(reset);
  return (
    <div className="kv">
      <span className="k">{label}</span>
      <span className="v">
        <span style={{ color: usageColor(pct), fontVariantNumeric: "tabular-nums" }}>
          {Math.round(pct)}% used
        </span>
        {target && (
          <span
            style={{
              color: "var(--text-faint)",
              marginLeft: 8,
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            · ↻ {fmtAbsTime(target)}
          </span>
        )}
      </span>
    </div>
  );
}

/** Placeholder for loading or failed quota reads, with the full error on hover. Once the circuit
 * breaker stops automatic refresh, prompt the user to click refresh while retaining the error tooltip. */
function UsageHint({
  busy,
  err,
  gaveUp,
}: {
  busy: boolean;
  err: string | null;
  gaveUp: boolean;
}) {
  const note = gaveUp ? "auto-refresh paused · click ↻ to retry" : err;
  return (
    <div className="kv">
      <span className="k" style={{ color: "var(--text-faint)" }}>
        {busy ? "loading…" : err ? "unavailable" : "—"}
      </span>
      {!busy && err && (
        <span
          className="v"
          title={err}
          style={{
            color: "var(--text-faint)",
            fontSize: 10,
            maxWidth: 190,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {note}
        </span>
      )}
    </div>
  );
}

/** Display label for each quota source. */
function providerLabel(kind: SessionKind): string {
  if (kind === "codex") return "Codex";
  if (kind === "grok") return "Grok";
  return "Claude";
}

/** Quota section with a Usage title, branded source matching sidebar colors, refresh countdown, and
 * refresh button. Keep the last-updated time in a tooltip to preserve a compact layout. */
function UsageSection({
  kind,
  usageAt,
  usageBusy,
  refreshSec,
  spinTick,
  onRefresh,
  children,
}: {
  kind: SessionKind;
  usageAt: number | null;
  usageBusy: boolean;
  refreshSec: number;
  spinTick: number;
  onRefresh: () => void;
  children: React.ReactNode;
}) {
  // Keep the one-second countdown tick local so only this section rerenders.
  const now = useNowTick();
  const nextLeft =
    usageAt != null && refreshSec > 0 ? Math.max(0, usageAt + refreshSec * 1000 - now) : null;
  const tip = usageAt != null ? `Updated ${fmtUpdatedAt(usageAt)}` : "Refresh";
  return (
    <div className="insp-section">
      <h4 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>Usage</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontWeight: 600,
            letterSpacing: 0.3,
            textTransform: "none",
            fontSize: 9,
            lineHeight: 1.5,
            padding: "1px 7px 1px 5px",
            borderRadius: 999,
            background: "var(--bg-active)",
            color: "var(--text-dim)",
          }}
        >
          {usageBrandIconEl(kind, 11) ?? kindIconEl(kind, 11)}
          {providerLabel(kind)}
        </span>
        {nextLeft != null && (
          <span
            title={tip}
            style={{
              marginLeft: "auto",
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: "none",
              color: "var(--text-faint)",
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ↻ {fmtRefreshLeft(nextLeft)}
          </span>
        )}
        <button
          title={tip}
          onClick={onRefresh}
          disabled={usageBusy}
          style={{
            marginLeft: nextLeft != null ? 0 : "auto",
            display: "inline-flex",
            alignItems: "center",
            background: "transparent",
            border: "none",
            padding: 2,
            color: usageBusy ? "var(--accent)" : "var(--text-faint)",
            cursor: usageBusy ? "default" : "pointer",
            opacity: 1,
          }}
        >
          <span key={spinTick} className={usageBusy ? "spin" : undefined} style={{ display: "inline-flex" }}>
            <Icons.restart size={11} />
          </span>
        </button>
      </h4>
      {children}
    </div>
  );
}

export function InfoTab({ session, cwd }: { session: Session; cwd: string | null }) {
  const runtime = useTermStore((s) => s.runtimes[session.id]);
  const display = effectiveStatus(runtime);
  const branch = useGitBranch(cwd);
  const isAgent =
    session.kind !== "terminal" && session.kind !== "browser" && session.kind !== "chat";
  const isClaude = session.kind === "claude";
  const isCodex = session.kind === "codex";
  const isGrok = session.kind === "grok";
  const hasContext = isClaude || isCodex || isGrok;
  const hasUsage = isClaude || isCodex || isGrok;

  // Model/context usage comes from Claude/Codex transcripts or Grok session signals. Refresh on
  // session changes, work-state changes at turn end, and tool changes after each call.
  const [ctx, setCtx] = useState<AgentContextInfo | null>(null);
  const [turn, setTurn] = useState<AgentTurnStats | null>(null);
  const agentState = runtime?.agentState;
  const currentTool = runtime?.currentTool;
  useEffect(() => {
    // Gate reads until hooks capture agentSessionId (transcript / signals path is then locatable).
    if (!hasContext || !session.agentSessionId) {
      setCtx(null);
      setTurn(null);
      return;
    }
    let cancelled = false;
    agentContextInfo(session.id)
      .then((c) => !cancelled && setCtx(c))
      .catch(() => !cancelled && setCtx(null));
    if (isClaude) {
      agentTurnStats(session.id)
        .then((t) => !cancelled && setTurn(t))
        .catch(() => !cancelled && setTurn(null));
    } else {
      setTurn(null);
    }
    return () => {
      cancelled = true;
    };
  }, [session.id, session.agentSessionId, hasContext, isClaude, agentState, currentTool]);

  // While working, context tokens and turn statistics change between tool and turn-end events. Poll
  // every 1.5 seconds during work for freshness and stop outside the working state.
  useEffect(() => {
    if (!hasContext || !session.agentSessionId || agentState !== "working") return;
    let cancelled = false;
    const t = setInterval(() => {
      agentContextInfo(session.id)
        .then((c) => !cancelled && setCtx(c))
        .catch(() => {});
      if (isClaude) {
        agentTurnStats(session.id)
          .then((s) => !cancelled && setTurn(s))
          .catch(() => {});
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [session.id, session.agentSessionId, hasContext, isClaude, agentState]);

  // Account-level quotas: Claude/Grok use HTTP endpoints; Codex prefers live app-server then rollout.
  const usageRefreshSec = useTermStore((s) => s.usageRefreshSec);
  const [claudeUse, setClaudeUse] = useState<ClaudeUsage | null>(null);
  const [codexUse, setCodexUse] = useState<CodexUsage | null>(null);
  const [grokUse, setGrokUse] = useState<GrokUsage | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageAt, setUsageAt] = useState<number | null>(null);
  const [usageErr, setUsageErr] = useState<string | null>(null);
  // Trip the breaker after USAGE_MAX_FAILS; success or manual refresh resets the failure count.
  const [usageFail, setUsageFail] = useState(0);
  const usageGaveUp = usageFail >= USAGE_MAX_FAILS;
  // Increment on refresh to remount the spinner and reliably restart its animation.
  const [spinTick, setSpinTick] = useState(0);
  // Ignore late results from the previous session or an older overlapping refresh.
  const usageRequestRef = useRef(0);
  const previousAgentStateRef = useRef(agentState);

  useEffect(
    () => () => {
      usageRequestRef.current += 1;
    },
    [],
  );

  // Fetch quota from the source for this session type; force bypasses Claude/Grok backend caches.
  const loadUsage = useCallback(
    (force: boolean) => {
      const request = ++usageRequestRef.current;
      const isCurrent = () => usageRequestRef.current === request;
      // Remount by spinTick and keep the spinner visible for at least two rotations. Claude can return
      // in milliseconds and Codex almost instantly, making a single rotation imperceptible.
      setSpinTick((n) => n + 1);
      // Manual forced refresh resets the failure count and circuit breaker for another attempt.
      if (force) setUsageFail(0);
      const start = Date.now();
      const stop = () => {
        const wait = Math.max(0, 1100 - (Date.now() - start));
        setTimeout(() => isCurrent() && setUsageBusy(false), wait);
      };
      if (isClaude) {
        setUsageBusy(true);
        claudeUsage(force)
          .then((u) => {
            if (!isCurrent()) return;
            setClaudeUse(u);
            setUsageAt(Date.now());
            setUsageErr(null);
            setUsageFail(0);
          })
          .catch((e) => {
            if (!isCurrent()) return;
            setClaudeUse(null);
            setUsageErr(String(e));
            setUsageFail((n) => n + 1);
          })
          .finally(stop);
      } else if (isCodex) {
        setUsageBusy(true);
        // Show the local rollout snapshot first instead of making the panel wait for app-server startup/network.
        // Then replace it with the authoritative live value. The backend live call still falls back to rollout,
        // while preserving a snapshot already shown here if that second call fails transiently.
        let localShown = false;
        codexUsage(session.id)
          .then((u) => {
            if (!isCurrent()) return;
            localShown = true;
            setCodexUse(u);
            setUsageAt(Date.now());
            setUsageErr(null);
            setUsageFail(0);
          })
          .catch(() => {})
          .then(() => codexUsage(session.id, true))
          .then((u) => {
            if (!isCurrent()) return;
            setCodexUse(u);
            setUsageAt(Date.now());
            setUsageErr(null);
            setUsageFail(0);
          })
          .catch((e) => {
            if (!isCurrent()) return;
            if (!localShown) setCodexUse(null);
            setUsageErr(String(e));
            setUsageFail((n) => n + 1);
          })
          .finally(stop);
      } else if (isGrok) {
        setUsageBusy(true);
        grokUsage(force)
          .then((u) => {
            if (!isCurrent()) return;
            setGrokUse(u);
            setUsageAt(Date.now());
            setUsageErr(null);
            setUsageFail(0);
          })
          .catch((e) => {
            if (!isCurrent()) return;
            setGrokUse(null);
            setUsageErr(String(e));
            setUsageFail((n) => n + 1);
          })
          .finally(stop);
      }
    },
    [isClaude, isCodex, isGrok, session.id],
  );

  // On session or type changes, clear stale data from the other source, reset failures, and fetch now.
  useEffect(() => {
    if (!isClaude) setClaudeUse(null);
    if (!isCodex) setCodexUse(null);
    if (!isGrok) setGrokUse(null);
    if (hasUsage) {
      setUsageAt(null);
      setUsageFail(0);
      loadUsage(false);
    }
  }, [loadUsage, isClaude, isCodex, isGrok, hasUsage]);

  // Schedule refresh only for positive intervals. Backend caching protects Claude/Grok limits; stop after trip.
  useEffect(() => {
    if (!hasUsage || usageRefreshSec <= 0 || usageGaveUp) return;
    const t = setInterval(() => loadUsage(false), usageRefreshSec * 1000);
    return () => clearInterval(t);
  }, [loadUsage, hasUsage, usageRefreshSec, usageGaveUp]);

  // Codex local reads are unthrottled, so refresh immediately on turn/tool changes unless tripped. A local read
  // failure is not an account-endpoint failure and must not trip the automatic-refresh circuit breaker.
  useEffect(() => {
    if (!isCodex || usageGaveUp) return;
    let cancelled = false;
    codexUsage(session.id)
      .then((u) => {
        if (cancelled) return;
        setCodexUse(u);
        setUsageAt(Date.now());
        setUsageErr(null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isCodex, session.id, agentState, currentTool, usageGaveUp]);

  // Grok signals.json updates as the turn progresses; reread context when tools/state change without
  // re-hitting the rate-limited billing endpoint (account usage still follows usageRefreshSec).
  useEffect(() => {
    if (!isGrok || !session.agentSessionId) return;
    let cancelled = false;
    agentContextInfo(session.id)
      .then((c) => {
        if (!cancelled) setCtx(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isGrok, session.id, session.agentSessionId, agentState, currentTool]);

  // Codex can emit its turn-end lifecycle event just before the final token_count snapshot reaches the rollout.
  // Reconcile once after that short write window so a missed local read does not remain stale until the next
  // configured interval (five minutes by default).
  useEffect(() => {
    const previous = previousAgentStateRef.current;
    previousAgentStateRef.current = agentState;
    if (!isCodex || previous !== "working" || agentState === "working" || usageGaveUp) return;
    const t = setTimeout(() => loadUsage(false), 750);
    return () => clearTimeout(t);
  }, [agentState, isCodex, loadUsage, usageGaveUp]);

  // `started` is the process start time. Leaf components own their one-second ticks so InfoTab does
  // not rerender as a whole every second.
  const startedAt = runtime?.startedAt;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div className="insp-section">
        <h4>{isAgent ? "Agent" : "Process"}</h4>
        <KV k="session" v={session.name} />
        <KV k="type" v={isAgent ? "code agent" : "shell"} />
        <KV k="status" v={display} />
        <KV k="cwd" v={cwd || "—"} />
        <KV k="branch" v={branch || "—"} accent />
        {isAgent ? (
          <KV k="agent" v={runtime?.agent || session.kind} accent />
        ) : (
          <KV k="pid" v={runtime?.pid ?? "—"} />
        )}
        <KV
          k="started"
          v={startedAt ? new Date(startedAt).toLocaleTimeString(dateLocale()) : "—"}
        />
        <UptimeKV startedAt={startedAt} />
      </div>

      {isAgent && (
        <div className="insp-section">
          <h4>Model</h4>
          <KV k="model" v={ctx?.model ?? "—"} accent />
          <KV
            k="context"
            v={
              ctx?.contextTokens != null
                ? `${fmtTokens(ctx.contextTokens)} / ${fmtTokens(ctx.contextLimit)}`
                : "—"
            }
          />
          <KV k="tool" v={currentTool ?? ctx?.currentTool ?? "—"} accent />
        </div>
      )}

      {isClaude && (
        <UsageSection
          kind={session.kind}
          usageAt={usageAt}
          usageBusy={usageBusy}
          refreshSec={usageRefreshSec}
          spinTick={spinTick}
          onRefresh={() => loadUsage(true)}
        >
          {claudeUse && (claudeUse.fiveHour || claudeUse.sevenDay) ? (
            <>
              {claudeUse.fiveHour && (
                <UsageRow label="5h" pct={claudeUse.fiveHour.utilization} reset={claudeUse.fiveHour.resetsAt} />
              )}
              {claudeUse.sevenDay && (
                <UsageRow label="7d" pct={claudeUse.sevenDay.utilization} reset={claudeUse.sevenDay.resetsAt} />
              )}
              {claudeUse.sevenDayOpus && (
                <UsageRow
                  label="7d · opus"
                  pct={claudeUse.sevenDayOpus.utilization}
                  reset={claudeUse.sevenDayOpus.resetsAt}
                />
              )}
            </>
          ) : (
            <UsageHint busy={usageBusy} err={usageErr} gaveUp={usageGaveUp} />
          )}
        </UsageSection>
      )}

      {isCodex && (
        <UsageSection
          kind={session.kind}
          usageAt={usageAt}
          usageBusy={usageBusy}
          refreshSec={usageRefreshSec}
          spinTick={spinTick}
          onRefresh={() => loadUsage(true)}
        >
          {codexUse && (codexUse.primary || codexUse.secondary) ? (
            <>
              {codexUse.primary && (
                <UsageRow
                  label={codexWindowLabel(codexUse.primary.windowMinutes)}
                  pct={codexUse.primary.usedPercent}
                  reset={codexUse.primary.resetsAt}
                />
              )}
              {codexUse.secondary && (
                <UsageRow
                  label={codexWindowLabel(codexUse.secondary.windowMinutes)}
                  pct={codexUse.secondary.usedPercent}
                  reset={codexUse.secondary.resetsAt}
                />
              )}
            </>
          ) : (
            <UsageHint busy={usageBusy} err={usageErr} gaveUp={usageGaveUp} />
          )}
        </UsageSection>
      )}

      {isGrok && (
        <UsageSection
          kind={session.kind}
          usageAt={usageAt}
          usageBusy={usageBusy}
          refreshSec={usageRefreshSec}
          spinTick={spinTick}
          onRefresh={() => loadUsage(true)}
        >
          {grokUse ? (
            <>
              <UsageRow
                label={grokUse.windowLabel || "7d"}
                pct={grokUse.usedPercent}
                reset={grokUse.periodEnd}
              />
              {grokUse.buildPercent != null && (
                <UsageRow label="build" pct={grokUse.buildPercent} />
              )}
            </>
          ) : (
            <UsageHint busy={usageBusy} err={usageErr} gaveUp={usageGaveUp} />
          )}
        </UsageSection>
      )}

      {turn && (
        <div className="insp-section">
          <h4>This turn</h4>
          <KV k="tokens" v={fmtTokens(turn.tokens)} />
          <KV k="tools used" v={turn.toolsUsed} />
          <KV k="files touched" v={turn.filesTouched} accent />
        </div>
      )}

      <ResourcesSection pid={runtime?.pid} />
    </div>
  );
}
