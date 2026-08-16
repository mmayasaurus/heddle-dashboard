//! Fleet chatroom — read-only surface (HED-74b). Default-collapsed strip that expands to an
//! overlay with rooms+roster rail, transcript, pinned needs-human strip, and floor banner.
//! NO composer, NO room creation, NO writes of any kind — those land in a separate PR.
//!
//! Self-contained: owns its own polling (useCommsPoll), its own CSS (comms.css), and its own
//! open/closed persistence. The lane owner mounts <ChatroomPane /> with a single line; this file
//! and its siblings under comms/ do not depend on or modify any existing component.

import { useEffect, useState } from "react";
import { isTauri } from "../../../ipc/transport";
import { useT } from "../../../i18n";
import "./comms.css";
import { FloorBanner } from "./FloorBanner";
import { NeedsHumanStrip } from "./NeedsHumanStrip";
import { RoomsRail } from "./RoomsRail";
import { Transcript } from "./Transcript";
import { formatNeedsHumanCount, lsGet, lsSet, useCommsPoll, type CommsNeedsHumanRow } from "./useCommsPoll";

const OPEN_KEY = "heddle.comms.open";

export function ChatroomPane() {
  const t = useT();
  const [open, setOpen] = useState(() => lsGet(OPEN_KEY) === "1");
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  // True once a needs-human row click has set activeTarget to an address that may not be in
  // rooms[] (a DM/agent target) — pins it so the default-room fallback effect below leaves it
  // alone instead of bouncing back to #fleet on the next rooms poll.
  const [pinned, setPinned] = useState(false);

  const {
    loaded,
    schemaOk,
    schemaVersion,
    rooms,
    needsHuman,
    recentRefusals,
    roomsError,
    messages,
    floor,
    transcriptError,
    roster,
    rosterError,
    unreadByTarget,
  } = useCommsPoll(open, activeTarget);

  // Once rooms are known, default to #fleet (the open everyone-room), else the first open room,
  // else the first listed — covers the initial expand and a previously active room disappearing.
  // Skipped entirely while pinned (a needs-human click chose a non-room target on purpose).
  useEffect(() => {
    if (rooms.length === 0) return;
    if (pinned && activeTarget != null) return;
    if (activeTarget && rooms.some((r) => r.target === activeTarget)) return;
    const fallback = rooms.find((r) => r.target === "#fleet") ?? rooms.find((r) => r.open) ?? rooms[0];
    setActiveTarget(fallback.target);
  }, [rooms, activeTarget, pinned]);

  // Escape collapses the overlay while it's expanded; it's never wired up while collapsed, so it
  // doesn't steal Escape from anything else on the page.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      lsSet(OPEN_KEY, "0");
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!isTauri) return null;

  const toggle = () => {
    setOpen((o) => {
      lsSet(OPEN_KEY, o ? "0" : "1");
      return !o;
    });
  };

  const selectRoom = (target: string) => {
    setPinned(false);
    setActiveTarget(target);
    setHighlightId(null);
  };

  const handleNeedsHumanRowClick = (row: CommsNeedsHumanRow) => {
    setPinned(true);
    setActiveTarget(row.target);
    setHighlightId(row.id);
  };

  if (!open) {
    return (
      <div
        className="comms-strip"
        data-testid="comms-strip"
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        role="button"
        tabIndex={0}
        title={t("fleet.comms.title")}
      >
        <span className="comms-strip-glyph" aria-hidden="true">
          🧵
        </span>
        <span className="comms-strip-title">{t("fleet.comms.title")}</span>
        {needsHuman.length > 0 && (
          <span className="comms-badge comms-badge-alert" data-testid="comms-strip-needs-badge">
            {formatNeedsHumanCount(needsHuman.length)}
          </span>
        )}
        {recentRefusals > 0 && (
          <span className="comms-chip-amber" data-testid="comms-strip-refusals-chip">
            {recentRefusals}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="comms-overlay" data-testid="comms-overlay" role="dialog" aria-label={t("fleet.comms.title")}>
      <div className="comms-titlebar">
        <span className="comms-titlebar-title">{t("fleet.comms.title")}</span>
        <button className="comms-close" onClick={toggle} aria-label={t("common.close")} title={t("common.close")} type="button">
          ×
        </button>
      </div>

      {!loaded ? (
        <div className="comms-loading" data-testid="comms-loading" aria-hidden="true" />
      ) : !schemaOk ? (
        <div className="comms-schema-banner" data-testid="comms-schema-banner">
          {t("fleet.comms.schemaUnsupported", schemaVersion)}
        </div>
      ) : schemaVersion === 0 ? (
        <div className="comms-empty-state" data-testid="comms-empty-state">
          {t("fleet.comms.emptyState")}
        </div>
      ) : (
        <div className="comms-app">
          <RoomsRail
            rooms={rooms}
            activeTarget={activeTarget}
            unreadByTarget={unreadByTarget}
            onSelectRoom={selectRoom}
            roster={roster}
          />
          <div className="comms-chat">
            <div className="comms-chat-head">
              <span className="comms-chat-name">{activeTarget ?? ""}</span>
            </div>
            <NeedsHumanStrip rows={needsHuman} onRowClick={handleNeedsHumanRowClick} />
            <FloorBanner floor={floor} />
            {(roomsError ?? transcriptError ?? rosterError) && (
              <div className="comms-err" data-testid="comms-error">
                {roomsError ?? transcriptError ?? rosterError}
              </div>
            )}
            <Transcript messages={messages} highlightId={highlightId} />
          </div>
        </div>
      )}
    </div>
  );
}
