//! RouteMixPanel (HED-69) — the Fleet drawer's route-mix scoreboard: per-UTC-hour worker tokens by
//! provider (the work routed OFF the Claude pool) + per-orchestrator dispatch counts, from the
//! `heddle_route_mix` ledger aggregate. Next to it, the Claude 5-hour cap delta for the CURRENT
//! hour, computed client-side from the cap percentages the drawer already polls — no cap-history
//! backend exists, so the delta is honest about its basis: it renders "—" until two samples have
//! landed in the same UTC hour, and a mid-hour window reset renders as ↻ rather than a negative.
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
const PROVIDER_COLOR: Record<string, string> = {
  claude: "#b07cf0",
  codex: "#4fc08d",
  cursor: "#e3a857",
  gemini: "#5ec8d8",
};
const providerColor = (p: string) => PROVIDER_COLOR[p] ?? "var(--text-mid)";

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

/** Localized "HH:00" label for a UTC bucket key. */
function localHourLabel(hour: string): string {
  const d = new Date(`${hour}:00:00.000Z`);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

/** Claude 5h cap movement within the current UTC hour, from sampled percentages. */
export interface CapDelta {
  kind: "none" | "delta" | "reset";
  points?: number;
}

/**
 * Fold a new sample into the per-hour sample store and derive the current hour's delta.
 * Exported for tests: this is the arithmetic the chip renders, kept free of React.
 */
export function foldCapSample(
  samples: { hour: string; first: number; last: number } | null,
  pct: number | null,
  now: number,
): { samples: { hour: string; first: number; last: number } | null; delta: CapDelta } {
  if (pct == null) return { samples, delta: derive(samples) };
  const hour = utcHourKey(now);
  if (!samples || samples.hour !== hour) {
    const next = { hour, first: pct, last: pct };
    return { samples: next, delta: derive(next) };
  }
  const next = { ...samples, last: pct };
  return { samples: next, delta: derive(next) };
}

function derive(s: { hour: string; first: number; last: number } | null): CapDelta {
  if (!s || s.first === s.last) return s ? { kind: "none" } : { kind: "none" };
  // The 5h window resetting mid-hour makes the percentage drop; that is a reset, not negative use.
  if (s.last < s.first) return { kind: "reset" };
  return { kind: "delta", points: s.last - s.first };
}

export function RouteMixPanel({ claudeFiveHourPct }: { claudeFiveHourPct: number | null }) {
  const t = useT();
  const [mix, setMix] = useState<RouteMix | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const samplesRef = useRef<{ hour: string; first: number; last: number } | null>(null);
  const [capDelta, setCapDelta] = useState<CapDelta>({ kind: "none" });

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const load = () =>
      invoke<RouteMix>("heddle_route_mix", { hours: 6 })
        .then((m) => {
          if (!alive) return;
          setMix(m);
          setErr(null);
        })
        .catch((e) => {
          if (alive) setErr(String(e));
        });
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // Sample the drawer-provided Claude 5h percentage into the current UTC hour.
  useEffect(() => {
    const { samples, delta } = foldCapSample(samplesRef.current, claudeFiveHourPct, Date.now());
    samplesRef.current = samples;
    setCapDelta(delta);
  }, [claudeFiveHourPct]);

  if (!isTauri) return null;

  const nowHour = utcHourKey(Date.now());

  return (
    <div className="fleet-routemix">
      <div className="fleet-sec-title">{t("fleet.routeMix.title")}</div>
      {err && <div className="fleet-err">{err}</div>}
      {!err && (!mix || mix.hours.length === 0) ? (
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
          <span className="fleet-sp" />
          {h.hour === nowHour && capDelta.kind === "delta" && (
            <span className="fleet-routemix-cap" style={{ color: providerColor("claude") }}>
              {t("fleet.routeMix.capDelta", Math.round((capDelta.points ?? 0) * 10) / 10)}
            </span>
          )}
          {h.hour === nowHour && capDelta.kind === "reset" && (
            <span className="fleet-dim">{t("fleet.routeMix.capReset")}</span>
          )}
          {h.hour === nowHour && capDelta.kind === "none" && (
            <span className="fleet-dim">{t("fleet.routeMix.capPending")}</span>
          )}
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
