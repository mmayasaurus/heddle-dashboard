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

/** Disabled whenever operator status isn't confirmed AVAILABLE — fail-safe the same way the
 *  composer is, so the brief pre-first-poll window (status unknown, no hint yet) reads disabled
 *  rather than enabled. `hint` is display-only: it fills the title when there IS a specific reason
 *  (HED-74c spec); disabled-with-no-hint-yet just keeps the default title. */
function NewRoomButton({ onClick, disabled, hint }: { onClick: () => void; disabled: boolean; hint: string | null }) {
  const t = useT();
  return (
    <button
      className="comms-newroom"
      type="button"
      data-testid="comms-new-room-btn"
      disabled={disabled}
      title={hint ?? t("fleet.comms.newRoomTitle")}
      onClick={onClick}
    >
      {t("fleet.comms.newRoom")}
    </button>
  );
}

function RoomRow({ room, active, unread, onSelect }: { room: CommsRoom; active: boolean; unread: boolean; onSelect: () => void }) {
  const t = useT();
  return (
    <div
      className={"comms-room" + (active ? " comms-room-active" : "")}
      role="button"
      tabIndex={0}
      data-testid={`comms-room-${room.target}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="comms-room-name">{room.target}</span>
      {room.open ? (
        <span className="comms-open-tag">{t("fleet.comms.open")}</span>
      ) : (
        <>
          <span className="comms-lock" title={t("fleet.comms.closedRoom")}>
            🔒
          </span>
          <span className="comms-count">{room.memberCount ?? 0}</span>
        </>
      )}
      {unread && <span className="comms-badge comms-badge-alert" data-testid={`comms-unread-${room.target}`} aria-label={t("fleet.comms.unread")} />}
    </div>
  );
}

export interface RoomsRailProps {
  rooms: CommsRoom[];
  activeTarget: string | null;
  unreadByTarget: Record<string, boolean>;
  onSelectRoom: (target: string) => void;
  roster: FleetAgent[];
  onNewRoom: () => void;
  newRoomDisabled: boolean;
  newRoomHint: string | null;
}

export function RoomsRail({ rooms, activeTarget, unreadByTarget, onSelectRoom, roster, onNewRoom, newRoomDisabled, newRoomHint }: RoomsRailProps) {
  const t = useT();

  return (
    <div className="comms-rail" data-testid="comms-rail">
      <h3 className="comms-rail-h">
        {t("fleet.comms.rooms")}
        <NewRoomButton onClick={onNewRoom} disabled={newRoomDisabled} hint={newRoomHint} />
      </h3>
      {rooms.map((r) => (
        <RoomRow key={r.target} room={r} active={r.target === activeTarget} unread={!!unreadByTarget[r.target]} onSelect={() => onSelectRoom(r.target)} />
      ))}

      <h3 className="comms-rail-h">{t("fleet.comms.fleetPresence")}</h3>
      {roster.map((a) => (
        <RosterRow key={`${a.name}:${a.pid}`} agent={a} />
      ))}
    </div>
  );
}
