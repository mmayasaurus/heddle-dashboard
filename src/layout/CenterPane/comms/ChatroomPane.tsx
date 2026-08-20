//! Fleet chatroom (HED-74b read-only surface + HED-74c operator write path). Default-collapsed
//! strip that expands to an overlay with rooms+roster rail, transcript, pinned needs-human strip,
//! floor banner, and — as of HED-74c — the operator composer and room-creation/membership
//! affordances. The read-only poll (useCommsPoll) and the write path (useOperatorStatus + the
//! four heddle_comms_* write commands) are fully separate data layers; nothing here ever inserts
//! a message into the transcript locally — sends only ever clear the input and let the existing
//! 2.5s poll surface whatever the broker actually logged.
//!
//! Self-contained: owns its own polling, its own CSS (comms.css), and its own open/closed
//! persistence. The lane owner mounts <ChatroomPane /> with a single line; this file and its
//! siblings under comms/ do not depend on or modify any existing component.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useSuspendNativeViews } from "../../../hooks/nativeViewSuspend";
import { invoke, isTauri } from "../../../ipc/transport";
import { useT } from "../../../i18n";
import "./comms.css";
import { Composer } from "./Composer";
import { FloorBanner } from "./FloorBanner";
import { NeedsHumanStrip } from "./NeedsHumanStrip";
import { RoomCreateModal } from "./RoomCreateModal";
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
import {
  isOperatorFailure,
  operatorErrorResult,
  operatorHint,
  parseOperatorResult,
  useOperatorStatus,
  type CommsOperatorResult,
  type UseOperatorStatusResult,
} from "./useOperatorStatus";

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

/** Owns the address field + the add/remove call for RoomMemberControls below. A room-scoped hook
 *  (not a plain closure) because it needs its own state; kept separate from the rendering purely
 *  to stay inside the per-function Codacy line budget. */
function useMemberAction(room: string) {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommsOperatorResult | null>(null);

  const act = async (cmd: "heddle_comms_add_member" | "heddle_comms_remove_member") => {
    const trimmed = address.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const raw = await invoke<unknown>(cmd, { room, address: trimmed });
      const parsed = parseOperatorResult(raw);
      if (isOperatorFailure(parsed)) {
        setResult(parsed);
      } else {
        setResult(null);
        setAddress("");
      }
    } catch (e) {
      setResult(operatorErrorResult(e));
    } finally {
      setBusy(false);
    }
  };

  return { address, setAddress, busy, result, act };
}

/** Operator-only add/remove for an existing CLOSED room, in the chat header (HED-74c spec). No
 *  per-room member LIST is available from the backend (rooms only carry a count), so this is a
 *  free-typed address rather than a picker — the roster letters are already visible in the rail
 *  for reference. `opDisabled` is the fail-safe operator-availability gate (same as the composer's
 *  own `!status.available`, true until the first status poll confirms otherwise); `hint` is
 *  display-only text for the tooltip. */
function RoomMemberControls({ room, opDisabled, hint }: { room: string; opDisabled: boolean; hint: string | null }) {
  const t = useT();
  const { address, setAddress, busy, result, act } = useMemberAction(room);
  const disabled = opDisabled || busy;
  return (
    <div className="comms-member-ctl" data-testid="comms-member-controls">
      <input
        className="comms-member-ctl-input"
        data-testid="comms-member-ctl-input"
        value={address}
        disabled={disabled}
        placeholder={t("fleet.comms.memberAddress")}
        title={hint ?? undefined}
        onChange={(e) => {
          setAddress(e.target.value);
        }}
      />
      <button type="button" data-testid="comms-member-add" disabled={disabled || !address.trim()} onClick={() => void act("heddle_comms_add_member")}>
        {t("fleet.comms.addMember")}
      </button>
      <button
        type="button"
        data-testid="comms-member-remove"
        disabled={disabled || !address.trim()}
        onClick={() => void act("heddle_comms_remove_member")}
      >
        {t("fleet.comms.removeMember")}
      </button>
      {result && (
        <span className="comms-member-ctl-result" data-testid="comms-member-ctl-result">
          {result.reason ?? t("fleet.comms.refusalGeneric")}
        </span>
      )}
    </div>
  );
}

interface ChatColumnProps {
  poll: UseCommsPollResult;
  activeTarget: string | null;
  highlightId: number | null;
  opStatus: UseOperatorStatusResult;
  replyTo: CommsNeedsHumanRow | null;
  onClearReplyTo: () => void;
  onNeedsHumanRowClick: (row: CommsNeedsHumanRow) => void;
}

/** The right-hand column: chat header (+ operator member controls on a closed room), pinned
 *  needs-human strip, floor banner, poll-error line, transcript, and the composer. */
function ChatColumn({ poll, activeTarget, highlightId, opStatus, replyTo, onClearReplyTo, onNeedsHumanRowClick }: ChatColumnProps) {
  const t = useT();
  const { needsHuman, floor, roomsError, transcriptError, rosterError, messages, rooms, refresh } = poll;
  const activeRoom = rooms.find((r) => r.target === activeTarget);
  const hint = operatorHint(t, opStatus.reason);
  return (
    <div className="comms-chat">
      <div className="comms-chat-head">
        <span className="comms-chat-name">{activeTarget ?? ""}</span>
        {activeRoom && !activeRoom.open && (
          // Keyed on the room target so React remounts (not reuses) this on a room switch — its
          // address input and last result are per-room local state that must not survive one (B5).
          <RoomMemberControls key={activeRoom.target} room={activeRoom.target} opDisabled={!opStatus.available} hint={hint} />
        )}
      </div>
      <NeedsHumanStrip rows={needsHuman} onRowClick={onNeedsHumanRowClick} />
      <FloorBanner floor={floor} />
      {(roomsError ?? transcriptError ?? rosterError) && (
        <div className="comms-err" data-testid="comms-error">
          {roomsError ?? transcriptError ?? rosterError}
        </div>
      )}
      <Transcript messages={messages} highlightId={highlightId} />
      <Composer target={activeTarget} status={opStatus} floorHolder={floor?.holder ?? null} replyTo={replyTo} onClearReplyTo={onClearReplyTo} onSent={refresh} />
    </div>
  );
}

interface ExpandedOverlayProps {
  poll: UseCommsPollResult;
  activeTarget: string | null;
  highlightId: number | null;
  opStatus: UseOperatorStatusResult;
  replyTo: CommsNeedsHumanRow | null;
  onClearReplyTo: () => void;
  onToggle: () => void;
  onSelectRoom: (target: string) => void;
  onNeedsHumanRowClick: (row: CommsNeedsHumanRow) => void;
  onNewRoom: () => void;
  showRoomCreate: boolean;
  onCloseRoomCreate: () => void;
}

type OverlayBodyProps = Omit<ExpandedOverlayProps, "onToggle" | "showRoomCreate" | "onCloseRoomCreate">;

/** The loading/schema/empty gate, then the rail + chat column once real data is in. Split out of
 *  ExpandedOverlay purely to stay inside the per-function Codacy line budget — same props minus
 *  the three the titlebar/modal-shell layer above it owns. */
function OverlayBody({ poll, activeTarget, highlightId, opStatus, replyTo, onClearReplyTo, onSelectRoom, onNeedsHumanRowClick, onNewRoom }: OverlayBodyProps) {
  const t = useT();
  const { loaded, schemaOk, schemaVersion, rooms, unreadByTarget, roster } = poll;
  if (!loaded) return <div className="comms-loading" data-testid="comms-loading" aria-hidden="true" />;
  if (!schemaOk) {
    return (
      <div className="comms-schema-banner" data-testid="comms-schema-banner">
        {t("fleet.comms.schemaUnsupported", schemaVersion)}
      </div>
    );
  }
  if (schemaVersion === 0) {
    return (
      <div className="comms-empty-state" data-testid="comms-empty-state">
        {t("fleet.comms.emptyState")}
      </div>
    );
  }
  return (
    <div className="comms-app">
      <RoomsRail
        rooms={rooms}
        activeTarget={activeTarget}
        unreadByTarget={unreadByTarget}
        onSelectRoom={onSelectRoom}
        roster={roster}
        onNewRoom={onNewRoom}
        newRoomDisabled={!opStatus.available}
        newRoomHint={operatorHint(t, opStatus.reason)}
      />
      <ChatColumn
        poll={poll}
        activeTarget={activeTarget}
        highlightId={highlightId}
        opStatus={opStatus}
        replyTo={replyTo}
        onClearReplyTo={onClearReplyTo}
        onNeedsHumanRowClick={onNeedsHumanRowClick}
      />
    </div>
  );
}

/** Expanded overlay: titlebar + OverlayBody, with the room-create modal layered on top when open. */
function ExpandedOverlay(props: ExpandedOverlayProps) {
  const { onToggle, showRoomCreate, onCloseRoomCreate, poll } = props;
  const t = useT();
  return (
    <div className="comms-overlay" data-testid="comms-overlay" role="dialog" aria-label={t("fleet.comms.title")}>
      <div className="comms-titlebar">
        <span className="comms-titlebar-title">{t("fleet.comms.title")}</span>
        <button className="comms-close" onClick={onToggle} aria-label={t("common.close")} title={t("common.close")} type="button">
          ×
        </button>
      </div>
      <OverlayBody {...props} />
      {showRoomCreate && <RoomCreateModal roster={poll.roster} onClose={onCloseRoomCreate} />}
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
 *  doesn't steal Escape from anything else on the page. Suppressed while the room-create modal is
 *  open — that modal owns Escape itself (closing just the modal), and without this guard both
 *  window-level listeners would fire together and collapse the whole pane out from under it. */
function useEscapeToCollapse(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>, suppressed: boolean) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || suppressed) return;
      lsSet(OPEN_KEY, "0");
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen, suppressed]);
}

/** Binds the write-local-state callbacks the collapsed/expanded views need. Not a hook (calls
 *  none) — deliberately not `use`-prefixed so it can be called after the isTauri gate. Switching
 *  rooms (but not receiving a needs-human click, which sets its own target) clears any pending
 *  reply-to context — replying to a message in a room the operator has since navigated away from
 *  would silently reply to the wrong place. */
function bindChatroomActions(
  setOpen: Dispatch<SetStateAction<boolean>>,
  setActiveTarget: Dispatch<SetStateAction<string | null>>,
  setHighlightId: Dispatch<SetStateAction<number | null>>,
  setPinned: Dispatch<SetStateAction<boolean>>,
  setReplyTo: Dispatch<SetStateAction<CommsNeedsHumanRow | null>>,
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
    setReplyTo(null);
  };
  const handleNeedsHumanRowClick = (row: CommsNeedsHumanRow) => {
    setPinned(true);
    setActiveTarget(row.target);
    setHighlightId(row.id);
    setReplyTo(row);
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
  const [replyTo, setReplyTo] = useState<CommsNeedsHumanRow | null>(null);
  const [showRoomCreate, setShowRoomCreate] = useState(false);
  const poll = useCommsPoll(open, activeTarget);
  const opStatus = useOperatorStatus(open);

  useDefaultRoomFallback(poll.rooms, activeTarget, pinned, setActiveTarget);
  useEscapeToCollapse(open, setOpen, showRoomCreate);

  if (!isTauri) return null;

  const { toggle, selectRoom, handleNeedsHumanRowClick } = bindChatroomActions(setOpen, setActiveTarget, setHighlightId, setPinned, setReplyTo);

  if (!open) {
    return <CollapsedStrip needsHuman={poll.needsHuman} recentRefusals={poll.recentRefusals} onToggle={toggle} />;
  }

  return (
    <ExpandedOverlay
      poll={poll}
      activeTarget={activeTarget}
      highlightId={highlightId}
      opStatus={opStatus}
      replyTo={replyTo}
      onClearReplyTo={() => {
        setReplyTo(null);
      }}
      onToggle={toggle}
      onSelectRoom={selectRoom}
      onNeedsHumanRowClick={handleNeedsHumanRowClick}
      onNewRoom={() => {
        setShowRoomCreate(true);
      }}
      showRoomCreate={showRoomCreate}
      onCloseRoomCreate={() => {
        setShowRoomCreate(false);
      }}
    />
  );
}
