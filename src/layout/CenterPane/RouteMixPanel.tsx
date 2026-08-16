//! RouteMixPanel (HED-69) — the Fleet drawer's route-mix scoreboard: per-UTC-hour worker tokens by
//! provider (the work routed OFF the Claude pool) + per-orchestrator dispatch counts, from the
//! `heddle_route_mix` ledger aggregate. Above the buckets, a dedicated current-hour row shows the
//! Claude 5-hour cap movement — rendered independently of the buckets, because the key
//! failure-to-delegate scenario is exactly "cap moved, no dispatches this hour".
//!
//! Cap-delta honesty rules (no cap-history backend exists, per the ticket's "no new backend beyond
//! a ledger aggregate"): samples come from the cap percentages the drawer already polls, held in a
//! MODULE-scope store so closing/reopening the drawer doesn't discard the in-hour baseline (an app
//! restart does, and the chip honestly returns to pending). The chip is DERIVED AT RENDER TIME
//! from (store, current UTC hour), so an hour rollover immediately returns it to pending instead
//! of showing the previous hour's movement. A mid-hour window reset re-anchors the baseline at the
//! post-reset value: the tick that observes the drop shows ↻, and later movement shows "↻ +Xpt"
//! (delta since the reset), never a negative and never a delta against the invalidated baseline.
//!
//! Own component file by design: FleetDrawer.tsx is another agent's lane; the drawer only mounts
//! `<RouteMixPanel claudeFiveHourPct={…} />`.

import { useEffect, useRef, useState } from "react";

import "./RouteMixPanel.css";
import { useT } from "../../i18n";
import { invoke, isTauri } from "../../ipc/transport";

interface ProviderHourTokens {
  provider: string;
  dispatches: number;
  inputTokens: number;
  outputTokens: number;
}
interface HourBucket {
  hour: string; // "YYYY-MM-DDTHH" (UTC)
  providers: ProviderHourTokens[];
}
interface OrchestratorCount {
  orchestrator: string;
  dispatches: number;
  succeeded: number;
}
interface RouteMix {
  windowHours: number;
  hours: HourBucket[];
  orchestrators: OrchestratorCount[];
}

const POLL_MS = 60_000;

// Same accents as the drawer's provider bars, so the scoreboard reads as one system.
const PROVIDER_COLOR = new Map<string, string>([
  ["claude", "#b07cf0"],
  ["codex", "#4fc08d"],
  ["cursor", "#e3a857"],
  ["gemini", "#5ec8d8"],
]);
const providerColor = (p: string) => PROVIDER_COLOR.get(p) ?? "var(--text-mid)";

function fmtTokens(n: number): string {
  if (n <= 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

/** Current UTC hour key in the bucket format ("YYYY-MM-DDTHH"). */
function utcHourKey(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

/** Local label for a UTC bucket start, minutes included — fractional-offset time zones
 *  (UTC+05:30/+05:45) start UTC hours at :30/:45 local, and "06:00" would misattribute them. */
function localHourLabel(hour: string): string {
  const d = new Date(`${hour}:00:00.000Z`);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** In-hour cap sample state. Module-scoped (see header) — exported only for tests. */
export interface CapSamples {
  hour: string;
  first: number;
  last: number;
  count: number;
  /** A window reset was observed this hour; `first` is re-anchored at the post-reset value. */
  resetAnchored: boolean;
}

export type CapDelta =
  | { kind: "pending" }
  | { kind: "delta"; points: number; afterReset: boolean }
  | { kind: "reset" };

/** Fold one sampled percentage into the store (pure; exported for tests). */
export function foldCapSample(
  store: CapSamples | null,
  pct: number | null,
  now: number,
): CapSamples | null {
  if (pct == null) return store;
  const hour = utcHourKey(now);
  if (!store || store.hour !== hour) {
    return { hour, first: pct, last: pct, count: 1, resetAnchored: false };
  }
  if (pct < store.last) {
    // 5h window reset mid-hour: re-anchor so later movement measures from the reset, not the
    // invalidated pre-reset baseline.
    return { hour, first: pct, last: pct, count: store.count + 1, resetAnchored: true };
  }
  return { ...store, last: pct, count: store.count + 1 };
}

/** Derive the chip for the CURRENT hour (pure; exported for tests). Stale stores — a different
 *  hour than now — are pending by definition, which is what kills every rollover-staleness path. */
export function deriveCapDelta(store: CapSamples | null, nowHour: string): CapDelta {
  if (!store || store.hour !== nowHour || store.count < 2) return { kind: "pending" };
  if (store.last > store.first) {
    return { kind: "delta", points: store.last - store.first, afterReset: store.resetAnchored };
  }
  if (store.resetAnchored) return { kind: "reset" };
  return { kind: "delta", points: 0, afterReset: false };
}

/** Survives drawer close/reopen within one app run; an app restart honestly loses the baseline. */
let capStore: CapSamples | null = null;
/** Test hook: reset the module store between cases. */
export function resetCapStoreForTest(): void {
  capStore = null;
}

export function RouteMixPanel({ claudeFiveHourPct }: { claudeFiveHourPct: number | null }) {
  const t = useT();
  const [mix, setMix] = useState<RouteMix | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Latest sampled percentage, readable from the poll interval without a stale closure: React only
  // re-fires the prop effect on VALUE changes, so an unchanged percentage across polls would never
  // fold a second sample — and a genuinely flat hour would sit on "pending" forever. The interval
  // folds this ref every tick (samples-on-schedule) alongside the on-change effect.
  const latestPctRef = useRef<number | null>(claudeFiveHourPct);
  latestPctRef.current = claudeFiveHourPct;
  // Render-clock: bumped by the poll so the render-time chip derivation crosses hour boundaries
  // even when the sampled percentage never changes.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const load = () =>
      invoke<RouteMix>("heddle_route_mix", { hours: 6 })
        .then((m) => {
          if (!alive) return;
          setMix(m);
          setLoaded(true);
          setErr(null);
        })
        .catch((e) => {
          if (alive) setErr(String(e));
        });
    void load();
    const id = window.setInterval(() => {
      void load();
      capStore = foldCapSample(capStore, latestPctRef.current, Date.now());
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // Fold each drawer-provided sample into the module store.
  useEffect(() => {
    capStore = foldCapSample(capStore, claudeFiveHourPct, Date.now());
    setTick((n) => n + 1);
  }, [claudeFiveHourPct]);

  if (!isTauri) return null;

  const nowHour = utcHourKey(Date.now());
  const capDelta = deriveCapDelta(capStore, nowHour);

  return (
    <div className="fleet-routemix">
      <div className="fleet-sec-title">{t("fleet.routeMix.title")}</div>
      {err && <div className="fleet-err">{err}</div>}

      {/* Current-hour cap row — independent of buckets: "cap moved, nothing dispatched" is the
          exact signal this scoreboard exists to expose. */}
      <div className="fleet-prow" data-cap-row={nowHour}>
        <span className="fleet-dim fleet-routemix-hour">{localHourLabel(nowHour)}</span>
        {capDelta.kind === "delta" && (
          <span className="fleet-routemix-cap" style={{ color: providerColor("claude") }}>
            {capDelta.afterReset
              ? t("fleet.routeMix.capDeltaAfterReset", round1(capDelta.points))
              : t("fleet.routeMix.capDelta", round1(capDelta.points))}
          </span>
        )}
        {capDelta.kind === "reset" && (
          <span className="fleet-dim">{t("fleet.routeMix.capReset")}</span>
        )}
        {capDelta.kind === "pending" && (
          <span className="fleet-dim">{t("fleet.routeMix.capPending")}</span>
        )}
      </div>

      {loaded && !err && mix != null && mix.hours.length === 0 ? (
        <div className="fleet-dim fleet-empty">{t("fleet.routeMix.empty")}</div>
      ) : null}
      {mix?.hours.map((h) => (
        <div key={h.hour} className="fleet-prow" data-hour={h.hour}>
          <span className="fleet-dim fleet-routemix-hour">{localHourLabel(h.hour)}</span>
          {h.providers.map((p) => (
            <span
              key={p.provider}
              className="fleet-routemix-prov"
              style={{ color: providerColor(p.provider) }}
              title={t("fleet.routeMix.provTooltip", p.provider, p.dispatches)}
            >
              {p.provider} {fmtTokens(p.inputTokens + p.outputTokens)}
            </span>
          ))}
        </div>
      ))}
      {mix && mix.orchestrators.length > 0 && (
        <div className="fleet-prow fleet-routemix-orch">
          <span className="fleet-dim">{t("fleet.routeMix.byOrchestrator", mix.windowHours)}</span>
          <span className="fleet-sp" />
          {mix.orchestrators.map((o) => (
            <span key={o.orchestrator} className="fleet-dim fleet-routemix-orchitem">
              {o.orchestrator}×{o.dispatches}
              {o.succeeded < o.dispatches ? ` (${o.succeeded}✓)` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
