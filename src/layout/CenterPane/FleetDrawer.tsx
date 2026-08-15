//! FleetDrawer — collapsible bottom drawer under the terminal stage. Surfaces heddle's orchestration
//! state in two distinct lenses:
//!   - PROVIDER CAPS: true rolling 5-hour / 7-day rate-limit usage per provider, captured live from
//!     each provider's Claude Code statusline payload by ~/.heddle/usage-tap.mjs (the SAME numbers the
//!     statusline shows — accurate, not a spend estimate).
//!   - DISPATCH LEDGER (~/.heddle/ledger.db): what heddle itself routed + how it turned out.
//! Read-only, desktop-only, polls on a timer. Degrades to "waiting…" when a source is absent.

import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "../../ipc/transport";

interface LimitWindow {
  usedPercentage: number | null;
  resetsAt: number | null; // epoch SECONDS
}
interface ProviderLimit {
  provider: string;
  model: string | null;
  capturedAt: number | null;
  fiveHour: LimitWindow;
  sevenDay: LimitWindow;
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

const POLL_MS = 30_000;
const OPEN_KEY = "heddle-fleet-open";

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
  const [limits, setLimits] = useState<ProviderLimit[]>([]);
  const [inFlight, setInFlight] = useState<Dispatch[]>([]);
  const [recent, setRecent] = useState<Dispatch[]>([]);
  const [usage, setUsage] = useState<ProviderUsage[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try {
      const [l, f, r, u] = await Promise.all([
        invoke<ProviderLimit[]>("heddle_provider_limits"),
        invoke<Dispatch[]>("heddle_in_flight"),
        invoke<Dispatch[]>("heddle_recent", { limit: 30 }),
        invoke<ProviderUsage[]>("heddle_provider_usage"),
      ]);
      setLimits(l);
      setInFlight(f);
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

  const claude = limits.find((l) => l.provider === "claude");
  const c5 = claude?.fiveHour?.usedPercentage;
  const running = inFlight.length;
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
        {claude && c5 != null ? (
          <span className="fleet-sum">
            <span className="fleet-tag" style={{ color: providerColor("claude") }}>
              claude 5h
            </span>
            <b style={{ color: providerColor("claude") }}>{Math.round(c5)}%</b>
            {claude.fiveHour.resetsAt ? (
              <span className="fleet-dim">&nbsp;· {fmtReset(claude.fiveHour.resetsAt, now)}</span>
            ) : null}
          </span>
        ) : (
          <span className="fleet-dim">caps: waiting for a statusline render…</span>
        )}
        {running > 0 && <span className="fleet-run">● {running} running</span>}
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

          {running > 0 && (
            <>
              <div className="fleet-sec-title">Running ({running})</div>
              {inFlight.map((d) => (
                <DispatchRow key={d.id} d={d} live />
              ))}
            </>
          )}

          <div className="fleet-sec-title">Recent dispatches · heddle ledger</div>
          {shownRecent.length === 0 ? (
            <div className="fleet-dim fleet-empty">No real dispatches yet.</div>
          ) : (
            shownRecent.map((d) => <DispatchRow key={d.id} d={d} />)
          )}

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
}: {
  label: string;
  win: LimitWindow;
  color: string;
  now: number;
}) {
  const pct = win?.usedPercentage;
  return (
    <div className="fleet-capline">
      <span className="fleet-capline-lbl">{label}</span>
      <SegBar pct={pct} color={color} />
      <span className="fleet-capline-pct">{pct == null ? "" : `${Math.round(pct)}%`}</span>
      <span className="fleet-dim fleet-capline-reset">
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
  const capturedMinutes = p.capturedAt == null ? null : Math.max(0, Math.floor((now - p.capturedAt * 1_000) / 60_000));
  const isStale = capturedMinutes != null && capturedMinutes > 30;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="fleet-provcap">
      <div className="fleet-provcap-header">
        <div className="fleet-provcap-name" style={{ color }}>
          {p.provider}
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
            captured {capturedMinutes}m ago
          </span>
        )}
      </div>
      <CapLine label="5h" win={p.fiveHour} color={color} now={now} />
      <CapLine label="7d" win={p.sevenDay} color={color} now={now} />
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
