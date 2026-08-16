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
      invoke<Discipline>("heddle_discipline", { hours: 24 })
        .then((d) => {
          if (!alive) return;
          setData(d);
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
