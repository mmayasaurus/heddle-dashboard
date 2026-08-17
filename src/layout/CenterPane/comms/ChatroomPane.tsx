//! Fleet chatroom — read-only surface (HED-74b). Default-collapsed strip that expands to an
//! overlay with rooms+roster rail, transcript, pinned needs-human strip, and floor banner.
//! NO composer, NO room creation, NO writes of any kind — those land in a separate PR.
//!
//! Self-contained: owns its own polling (useCommsPoll), its own CSS (comms.css), and its own
//! open/closed persistence. The lane owner mounts <ChatroomPane /> with a single line; this file
//! and its siblings under comms/ do not depend on or modify any existing component.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useSuspendNativeViews } from "../../../hooks/nativeViewSuspend";
import { isTauri } from "../../../ipc/transport";
import { useT } from "../../../i18n";
import "./comms.css";
import { FloorBanner } from "./FloorBanner";
import { NeedsHumanStrip } from "./NeedsHumanStrip";
import { RoomsRail } from "./RoomsRail";
import { Transcript } from "./Transcript";
import {
  formatNeedsHumanCount,
  lsGet,
  lsSet,
  useCommsPoll,
  type CommsNeedsHumanRow,
  type CommsRoom,
  type UseCommsPollResult,
} from "./useCommsPoll";

const OPEN_KEY = "heddle.comms.open";

interface CollapsedStripProps {
  needsHuman: CommsNeedsHumanRow[];
  recentRefusals: number;
  onToggle: () => void;
}

/** Default-collapsed state: a single-line strip with the needs-human badge and refusals chip. */
function CollapsedStrip({ needsHuman, recentRefusals, onToggle }: CollapsedStripProps) {
  const t = useT();
  return (
    <div
      className="comms-strip"
      data-testid="comms-strip"
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
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

interface ExpandedOverlayProps {
  poll: UseCommsPollResult;
  activeTarget: string | null;
  highlightId: number | null;
  onToggle: () => void;
  onSelectRoom: (target: string) => void;
  onNeedsHumanRowClick: (row: CommsNeedsHumanRow) => void;
}

/** Expanded overlay: titlebar + loading/schema/empty gate + rail/chat body. */
function ExpandedOverlay({ poll, activeTarget, highlightId, onToggle, onSelectRoom, onNeedsHumanRowClick }: ExpandedOverlayProps) {
  const t = useT();
  const { loaded, schemaOk, schemaVersion, rooms, unreadByTarget, roster, needsHuman, floor, roomsError, transcriptError, rosterError, messages } =
    poll;
  return (
    <div className="comms-overlay" data-testid="comms-overlay" role="dialog" aria-label={t("fleet.comms.title")}>
      <div className="comms-titlebar">
        <span className="comms-titlebar-title">{t("fleet.comms.title")}</span>
        <button className="comms-close" onClick={onToggle} aria-label={t("common.close")} title={t("common.close")} type="button">
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
          <RoomsRail rooms={rooms} activeTarget={activeTarget} unreadByTarget={unreadByTarget} onSelectRoom={onSelectRoom} roster={roster} />
          <div className="comms-chat">
            <div className="comms-chat-head">
              <span className="comms-chat-name">{activeTarget ?? ""}</span>
            </div>
            <NeedsHumanStrip rows={needsHuman} onRowClick={onNeedsHumanRowClick} />
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

/** Once rooms are known, defaults activeTarget to #fleet (the open everyone-room), else the
 *  first open room, else the first listed — covers the initial expand and a previously active
 *  room disappearing. Skipped entirely while pinned (a needs-human click chose a non-room target
 *  on purpose). */
function useDefaultRoomFallback(
  rooms: CommsRoom[],
  activeTarget: string | null,
  pinned: boolean,
  setActiveTarget: Dispatch<SetStateAction<string | null>>,
) {
  useEffect(() => {
    if (rooms.length === 0) return;
    if (pinned && activeTarget != null) return;
    if (activeTarget && rooms.some((r) => r.target === activeTarget)) return;
    const fallback = rooms.find((r) => r.target === "#fleet") ?? rooms.find((r) => r.open) ?? rooms[0];
    setActiveTarget(fallback.target);
  }, [rooms, activeTarget, pinned, setActiveTarget]);
}

/** Escape collapses the overlay while it's expanded; it's never wired up while collapsed, so it
 *  doesn't steal Escape from anything else on the page. */
function useEscapeToCollapse(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      lsSet(OPEN_KEY, "0");
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);
}

/** Binds the three write-local-state callbacks the collapsed/expanded views need. Not a hook
 *  (calls none) — deliberately not `use`-prefixed so it can be called after the isTauri gate. */
function bindChatroomActions(
  setOpen: Dispatch<SetStateAction<boolean>>,
  setActiveTarget: Dispatch<SetStateAction<string | null>>,
  setHighlightId: Dispatch<SetStateAction<number | null>>,
  setPinned: Dispatch<SetStateAction<boolean>>,
) {
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
  return { toggle, selectRoom, handleNeedsHumanRowClick };
}

export function ChatroomPane() {
  const [open, setOpen] = useState(() => lsGet(OPEN_KEY) === "1");
  // A native child webview (a browser tab) is a real OS view that punches through the parent and
  // ignores z-index entirely — nothing in the DOM can ever paint above it. This app already solves
  // that with a ref-counted suspension hook used by Backdrop, ContextMenu and every modal; the
  // overlay just has to opt in. Suspension HIDES the browser view, so the tab goes blank behind
  // the chat — the right trade for a full-stage surface you read and type into (HED-111).
  // isTauri && open, not just open: the hook must stay unconditional (hooks can't be gated by an
  // early return), but a non-Tauri/web mount with `open` persisted to "1" in localStorage would
  // otherwise increment the process-wide suspension counter for a component that renders null and
  // has no native views to suspend (4 reviewers, #40).
  useSuspendNativeViews(isTauri && open);
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  // True once a needs-human row click has set activeTarget to an address that may not be in
  // rooms[] (a DM/agent target) — pins it so the default-room fallback effect leaves it alone
  // instead of bouncing back to #fleet on the next rooms poll.
  const [pinned, setPinned] = useState(false);
  const poll = useCommsPoll(open, activeTarget);

  useDefaultRoomFallback(poll.rooms, activeTarget, pinned, setActiveTarget);
  useEscapeToCollapse(open, setOpen);

  if (!isTauri) return null;

  const { toggle, selectRoom, handleNeedsHumanRowClick } = bindChatroomActions(setOpen, setActiveTarget, setHighlightId, setPinned);

  if (!open) {
    return <CollapsedStrip needsHuman={poll.needsHuman} recentRefusals={poll.recentRefusals} onToggle={toggle} />;
  }

  return (
    <ExpandedOverlay
      poll={poll}
      activeTarget={activeTarget}
      highlightId={highlightId}
      onToggle={toggle}
      onSelectRoom={selectRoom}
      onNeedsHumanRowClick={handleNeedsHumanRowClick}
    />
  );
}
