//! DisciplinePanel (HED-85) — "are agents actually using memtrace?" as a glance. Renders the
//! `heddle_discipline` reader's per-agent/per-repo memory-layer counts (memtrace + serena), gate
//! state, and gate denials, plus the red-flag state Maya asked for: a LIVE agent (present in the
//! drawer's roster) with ZERO memory-layer calls in the window renders as a red "0 calls" row —
//! the sink only contains memory-layer rows, so absence-of-rows for a live agent IS the signal
//! (S's HED-82 emitter contract, workspace 40531d0/9a720c2).
//!
//! Own component file by design; FleetDrawer mounts `<DisciplinePanel liveAgents={…} />`.

import { useEffect, useState } from "react";

import "./RouteMixPanel.css";
import { useT } from "../../i18n";
import { invoke, isTauri } from "../../ipc/transport";

interface DisciplineRow {
  agent: string;
  repoId: string;
  memtraceCalls: number;
  serenaCalls: number;
  deniedCalls: number;
  gate: boolean;
  lastTs: string;
}
interface Discipline {
  windowHours: number;
  rows: DisciplineRow[];
  legacyUnattributedMemtrace: number;
}

const POLL_MS = 60_000;

/** Coerce whatever the backend hands back into a renderable shape.
 *
 *  Same reasoning as RouteMixPanel's normalizeMix: this panel renders INSIDE FleetDrawer, so a
 *  throw here unmounts the whole drawer — roster, caps and dispatch list all vanish, not just
 *  this row. An unexpected payload must degrade to "nothing recorded", never to an exception.
 *  A row missing its counters is DROPPED rather than defaulted to zero, because a fabricated
 *  zero here would render as a red "live, 0 calls" accusation against an agent. */
/** gate MUST be validated, not merely read: an undefined gate renders the red "gate OFF" state,
 *  which is precisely the false accusation this coercion exists to prevent. A row that cannot say
 *  whether the gate was on has no business claiming it was off. */
function isDisciplineRow(r: unknown): r is DisciplineRow {
  const x = r as Partial<DisciplineRow> | null;
  return (
    !!x &&
    typeof x.agent === "string" &&
    Number.isFinite(x.memtraceCalls) &&
    Number.isFinite(x.serenaCalls) &&
    typeof x.gate === "boolean" &&
    Number.isFinite(x.deniedCalls)
  );
}

function normalizeDiscipline(d: unknown): Discipline {
  // Typed `unknown` all the way down on purpose — casting to Partial<Discipline> would let
  // TypeScript claim each element is a well-formed row, the exact guarantee we lack for backend
  // input, and would make the runtime guards below read as dead code.
  const o = (d ?? {}) as Record<string, unknown>;
  const rows: unknown[] = Array.isArray(o.rows) ? o.rows : [];
  return {
    windowHours: typeof o.windowHours === "number" ? o.windowHours : 0,
    rows: rows.filter(isDisciplineRow),
    legacyUnattributedMemtrace:
      typeof o.legacyUnattributedMemtrace === "number" ? o.legacyUnattributedMemtrace : 0,
  };
}

/**
 * Live agents with zero memory-layer rows in the window — the red-flag set. Exported for tests:
 * this decision is the panel's whole reason to exist, so it stays pure and directly testable.
 */
export function zeroCallAgents(liveAgents: string[], rows: DisciplineRow[]): string[] {
  const used = new Set(
    rows.filter((r) => r.memtraceCalls + r.serenaCalls > 0).map((r) => r.agent),
  );
  return liveAgents.filter((a) => !used.has(a));
}

export function DisciplinePanel({ liveAgents }: { liveAgents: string[] }) {
  const t = useT();
  const [data, setData] = useState<Discipline | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const load = () =>
      invoke<unknown>("heddle_discipline", { hours: 24 })
        .then((d) => {
          if (!alive) return;
          setData(normalizeDiscipline(d));
          setErr(null);
        })
        .catch((e: unknown) => {
          if (alive) setErr(String(e));
        });
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (!isTauri) return null;

  const flagged = data ? zeroCallAgents(liveAgents, data.rows) : [];

  return (
    <div className="fleet-routemix">
      <div className="fleet-sec-title">{t("fleet.discipline.title")}</div>
      {err && <div className="fleet-err">{err}</div>}
      {flagged.map((a) => (
        <div key={`flag-${a}`} className="fleet-prow fleet-discipline-flag">
          <span className="fleet-discipline-red">{t("fleet.discipline.zeroCalls", a)}</span>
        </div>
      ))}
      {/* "Nothing recorded" must not appear beside a positive vendor total — contradictory. */}
      {!err &&
      data &&
      data.rows.length === 0 &&
      flagged.length === 0 &&
      data.legacyUnattributedMemtrace === 0 ? (
        <div className="fleet-dim fleet-empty">{t("fleet.discipline.empty")}</div>
      ) : null}
      {data?.rows.map((r) => (
        <div key={`${r.agent}/${r.repoId}`} className="fleet-prow">
          <span className="fleet-routemix-hour">{r.agent}</span>
          <span className="fleet-dim">{r.repoId}</span>
          <span className="fleet-sp" />
          <span className="fleet-routemix-prov">memtrace ×{r.memtraceCalls}</span>
          <span className="fleet-routemix-prov">serena ×{r.serenaCalls}</span>
          {r.deniedCalls > 0 && (
            <span className="fleet-discipline-red">
              {t("fleet.discipline.denied", r.deniedCalls)}
            </span>
          )}
          <span className={r.gate ? "fleet-dim" : "fleet-discipline-red"}>
            {r.gate ? t("fleet.discipline.gateOn") : t("fleet.discipline.gateOff")}
          </span>
        </div>
      ))}
      {data && data.legacyUnattributedMemtrace > 0 && (
        <div className="fleet-prow">
          <span className="fleet-dim">
            {t("fleet.discipline.legacy", data.legacyUnattributedMemtrace)}
          </span>
        </div>
      )}
    </div>
  );
}
