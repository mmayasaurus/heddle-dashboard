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
import { useCommsPoll, type CommsNeedsHumanRow } from "./useCommsPoll";

const OPEN_KEY = "heddle.comms.open";

export function ChatroomPane() {
  const t = useT();
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);

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
    unreadByTarget,
  } = useCommsPoll(open, activeTarget);

  // Once rooms are known, default to #fleet (the open everyone-room), else the first open room,
  // else the first listed — covers the initial expand and a previously active room disappearing.
  useEffect(() => {
    if (rooms.length === 0) return;
    if (activeTarget && rooms.some((r) => r.target === activeTarget)) return;
    const fallback = rooms.find((r) => r.target === "#fleet") ?? rooms.find((r) => r.open) ?? rooms[0];
    setActiveTarget(fallback.target);
  }, [rooms, activeTarget]);

  if (!isTauri) return null;

  const toggle = () => {
    setOpen((o) => {
      localStorage.setItem(OPEN_KEY, o ? "0" : "1");
      return !o;
    });
  };

  const selectRoom = (target: string) => {
    setActiveTarget(target);
    setHighlightId(null);
  };

  const handleNeedsHumanRowClick = (row: CommsNeedsHumanRow) => {
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
            {needsHuman.length}
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
            {(roomsError || transcriptError) && (
              <div className="comms-err" data-testid="comms-error">
                {roomsError ?? transcriptError}
              </div>
            )}
            <Transcript messages={messages} highlightId={highlightId} />
          </div>
        </div>
      )}
    </div>
  );
}
