//! Rooms + roster rail (approved mock cards 01/06). Open rooms show an "open" tag; closed rooms
//! show a lock glyph + member count. Unread badge per room (latestId vs the operator's stored
//! lastSeen cursor for that target). Roster reuses the exact heddle_fleet_roster shape
//! FleetDrawer.tsx invokes (read there for reference; it is not edited or imported from).

import { useT } from "../../../i18n";
import { agentColor, type CommsRoom, type FleetAgent } from "./useCommsPoll";

function fmtAgo(ms: number, nowMs: number): string {
  let s = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function RosterRow({ agent }: { agent: FleetAgent }) {
  const t = useT();
  const color = agentColor(agent.name);
  const liveWorkers = agent.workers.filter((w) => !w.stale);

  return (
    <>
      <div className="comms-member" data-testid={`comms-member-${agent.name}`}>
        <span className={"comms-dot" + (agent.alive ? " comms-dot-on" : "")} />
        <span className="comms-member-letter" style={color ? { color } : undefined}>
          {agent.name.trim()[0]?.toUpperCase() ?? "?"}
        </span>
        <span className="comms-member-who">{agent.name}</span>
        {!agent.alive && (
          <span className="comms-member-role">{t("fleet.comms.idleFor", fmtAgo(agent.updatedAtMs, Date.now()))}</span>
        )}
      </div>
      {liveWorkers.map((w, i) => (
        <div className="comms-member comms-member-worker" key={w.id} data-testid={`comms-worker-${w.id}`}>
          <span className="comms-dot comms-dot-on" />
          <span className="comms-member-letter comms-member-letter-sm" style={color ? { color } : undefined}>
            {agent.name}.{i + 1}
          </span>
          <span className="comms-member-who">
            {t("fleet.comms.worker")} · {w.provider}
          </span>
        </div>
      ))}
    </>
  );
}

export interface RoomsRailProps {
  rooms: CommsRoom[];
  activeTarget: string | null;
  unreadByTarget: Record<string, boolean>;
  onSelectRoom: (target: string) => void;
  roster: FleetAgent[];
}

export function RoomsRail({ rooms, activeTarget, unreadByTarget, onSelectRoom, roster }: RoomsRailProps) {
  const t = useT();

  return (
    <div className="comms-rail" data-testid="comms-rail">
      <h3 className="comms-rail-h">{t("fleet.comms.rooms")}</h3>
      {rooms.map((r) => {
        const active = r.target === activeTarget;
        const unread = unreadByTarget[r.target];
        return (
          <div
            key={r.target}
            className={"comms-room" + (active ? " comms-room-active" : "")}
            role="button"
            tabIndex={0}
            data-testid={`comms-room-${r.target}`}
            onClick={() => onSelectRoom(r.target)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectRoom(r.target);
              }
            }}
          >
            <span className="comms-room-name">{r.target}</span>
            {r.open ? (
              <span className="comms-open-tag">{t("fleet.comms.open")}</span>
            ) : (
              <>
                <span className="comms-lock" title={t("fleet.comms.closedRoom")}>
                  🔒
                </span>
                <span className="comms-count">{r.memberCount ?? 0}</span>
              </>
            )}
            {unread && (
              <span className="comms-badge comms-badge-alert" data-testid={`comms-unread-${r.target}`} aria-label={t("fleet.comms.unread")} />
            )}
          </div>
        );
      })}

      <h3 className="comms-rail-h">{t("fleet.comms.fleetPresence")}</h3>
      {roster.map((a) => (
        <RosterRow key={`${a.name}:${a.pid}`} agent={a} />
      ))}
    </div>
  );
}
