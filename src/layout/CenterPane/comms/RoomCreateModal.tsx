//! Room-creation modal (approved mock card 07) — "+ New room" in the rail header opens this.
//! create_room is idempotent on an existing name (HED-74c facts), so a partial member-add failure
//! is safe to retry by resubmitting the same form: the room itself won't be recreated, only the
//! still-missing members get re-added. The modal stays open on any failure so the operator can see
//! what happened and retry; it closes itself only after a fully clean create + every picked member
//! added. Escape (bound here, independently of ChatroomPane's own Escape-to-collapse, which is
//! suppressed while this modal is open) or the × button closes it without submitting anything.

import { useEffect, useState } from "react";
import { invoke } from "../../../ipc/transport";
import { useT } from "../../../i18n";
import type { FleetAgent } from "./useCommsPoll";
import { isOperatorFailure, operatorErrorResult, parseOperatorResult, type CommsOperatorResult } from "./useOperatorStatus";

function useEscapeCloses(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);
}

interface SubmitState {
  submitting: boolean;
  error: CommsOperatorResult | null;
  failedMembers: string[];
}

/** Creates the room, then adds every picked member in turn, collecting failures without aborting
 *  the rest of the batch. Closes the modal only when nothing failed. */
function useCreateRoomSubmit(onClose: () => void) {
  const [state, setState] = useState<SubmitState>({ submitting: false, error: null, failedMembers: [] });

  const addMember = async (room: string, address: string): Promise<boolean> => {
    try {
      const raw = await invoke<unknown>("heddle_comms_add_member", { room, address });
      return !isOperatorFailure(parseOperatorResult(raw));
    } catch {
      return false;
    }
  };

  const submit = async (name: string, topic: string, open: boolean, members: string[]) => {
    setState({ submitting: true, error: null, failedMembers: [] });
    const room = `#${name}`;
    try {
      const raw = await invoke<unknown>("heddle_comms_create_room", { name: room, topic: topic || null, open });
      const result = parseOperatorResult(raw);
      if (isOperatorFailure(result)) {
        setState({ submitting: false, error: result, failedMembers: [] });
        return;
      }
    } catch (e) {
      setState({ submitting: false, error: operatorErrorResult(e), failedMembers: [] });
      return;
    }
    const failed: string[] = [];
    for (const address of members) {
      if (!(await addMember(room, address))) failed.push(address);
    }
    setState({ submitting: false, error: null, failedMembers: failed });
    if (failed.length === 0) onClose();
  };

  return { ...state, submit };
}

interface MemberPickerProps {
  roster: FleetAgent[];
  selected: Set<string>;
  onToggle: (name: string) => void;
}

function MemberPicker({ roster, selected, onToggle }: MemberPickerProps) {
  const t = useT();
  return (
    <div className="comms-modal-field">
      <span className="comms-modal-label">{t("fleet.comms.roomMembersLabel")}</span>
      <div className="comms-modal-members" data-testid="comms-modal-members">
        {roster.map((a) => (
          <button
            key={a.name}
            type="button"
            className={"comms-member-chip" + (selected.has(a.name) ? " comms-member-chip-on" : "")}
            data-testid={`comms-modal-member-${a.name}`}
            aria-pressed={selected.has(a.name)}
            onClick={() => {
              onToggle(a.name);
            }}
          >
            {a.name}
          </button>
        ))}
      </div>
    </div>
  );
}

interface RoomCreateFieldsProps {
  name: string;
  setName: (v: string) => void;
  topic: string;
  setTopic: (v: string) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  nameError: boolean;
}

function RoomCreateFields({ name, setName, topic, setTopic, open, setOpen, nameError }: RoomCreateFieldsProps) {
  const t = useT();
  return (
    <>
      <div className="comms-modal-field">
        <span className="comms-modal-label">{t("fleet.comms.roomNameLabel")}</span>
        <div className="comms-modal-name-row">
          <span className="comms-modal-hash">#</span>
          <input
            className="comms-modal-input"
            data-testid="comms-modal-name"
            value={name}
            placeholder={t("fleet.comms.roomNamePlaceholder")}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        {nameError && (
          <div className="comms-modal-error" data-testid="comms-modal-name-error">
            {t("fleet.comms.roomNameRequired")}
          </div>
        )}
      </div>
      <div className="comms-modal-field">
        <span className="comms-modal-label">{t("fleet.comms.roomTopicLabel")}</span>
        <input
          className="comms-modal-input"
          data-testid="comms-modal-topic"
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
          }}
        />
      </div>
      <label className="comms-toggle" data-testid="comms-modal-open-toggle">
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => {
            setOpen(e.target.checked);
          }}
        />
        {t("fleet.comms.roomOpenLabel")}
      </label>
    </>
  );
}

export interface RoomCreateModalProps {
  roster: FleetAgent[];
  onClose: () => void;
}

export function RoomCreateModal({ roster, onClose }: RoomCreateModalProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nameError, setNameError] = useState(false);
  const { submitting, error, failedMembers, submit } = useCreateRoomSubmit(onClose);
  useEscapeCloses(onClose);

  const toggleMember = (address: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(true);
      return;
    }
    setNameError(false);
    void submit(trimmed, topic.trim(), open, [...selected]);
  };

  return (
    <div className="comms-modal-backdrop" data-testid="comms-room-modal">
      <div className="comms-modal" role="dialog" aria-label={t("fleet.comms.newRoomModalTitle")}>
        <div className="comms-modal-head">
          <span className="comms-modal-title">{t("fleet.comms.newRoomModalTitle")}</span>
          <button
            className="comms-close"
            type="button"
            data-testid="comms-modal-close"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            ×
          </button>
        </div>
        <RoomCreateFields name={name} setName={setName} topic={topic} setTopic={setTopic} open={open} setOpen={setOpen} nameError={nameError} />
        <MemberPicker roster={roster} selected={selected} onToggle={toggleMember} />
        {error && (
          <div className="comms-modal-error" data-testid="comms-modal-create-error">
            {error.reason ?? t("fleet.comms.refusalGeneric")}
          </div>
        )}
        {failedMembers.length > 0 && (
          <div className="comms-modal-error" data-testid="comms-modal-members-failed">
            {t("fleet.comms.membersFailed", failedMembers.join(", "))}
          </div>
        )}
        <button className="comms-send" type="button" data-testid="comms-modal-submit" disabled={submitting} onClick={handleSubmit}>
          {submitting ? t("fleet.comms.creating") : t("fleet.comms.createRoom")}
        </button>
      </div>
    </div>
  );
}
