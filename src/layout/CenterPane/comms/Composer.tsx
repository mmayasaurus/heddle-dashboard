//! Operator message composer (approved mock card 02) — bottom of the transcript column. Writes
//! only: this file never imports CommsMessage or touches the transcript array. On success it
//! clears the input and relies entirely on useCommsPoll's existing 2.5s cursor poll to surface the
//! sent message — inserting it locally would risk showing something the broker never actually
//! logged (a refusal, a rewrite, a dedupe). A refusal (e.g. floor-held) is a NORMAL post_message
//! result, not a thrown error: it renders inline with its reason and the typed body is preserved
//! so the operator can retry without retyping. The @all toggle re-ADDRESSES the send to the
//! broker's broadcast address; it never decorates the body.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "../../../ipc/transport";
import { useT } from "../../../i18n";
import type { CommsNeedsHumanRow } from "./useCommsPoll";
import {
  isOperatorFailure,
  operatorErrorResult,
  operatorHint,
  parseOperatorResult,
  type CommsOperatorResult,
  type OperatorStatus,
} from "./useOperatorStatus";

function refusalText(t: ReturnType<typeof useT>, result: CommsOperatorResult, floorHolder: string | null): string {
  if (result.reason === "floor-held" && floorHolder) return t("fleet.comms.refusalFloorHeld", floorHolder);
  return result.reason ?? t("fleet.comms.refusalGeneric");
}

function deliveryNoteText(t: ReturnType<typeof useT>, result: CommsOperatorResult, target: string): string | null {
  if (result.outcome === "failed" && result.code === "no-live-session") {
    return t("fleet.comms.deliveredNoLiveSession", target);
  }
  if (result.code !== "broadcast" || result.reason == null) return null;

  const inboxSplit = /\d+\/(\d+) pushed, (\d+)\/\1 to inbox/.exec(result.reason);
  if (!inboxSplit) return null;
  const [, recipientCount, inboxCount] = inboxSplit;
  if (Number(inboxCount) === 0) return null;
  return t("fleet.comms.broadcastInboxSplit", Number(inboxCount), Number(recipientCount));
}

/** Owns the send call + its outcome. Never clears `sending`'s caller-owned text on refusal/error —
 *  only `onDone` (called on confirmed success) is responsible for that, via the caller's callback. */
function useComposerSend(
  target: string | null,
  contextTarget: string | null,
  replyToId: number | undefined,
  onDone: () => void,
  t: ReturnType<typeof useT>,
) {
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<CommsOperatorResult | null>(null);
  const [deliveryNote, setDeliveryNote] = useState<string | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    genRef.current++;
    setSending(false);
  }, [contextTarget]);

  const send = async (body: string) => {
    if (target == null) return;
    const gen = ++genRef.current;
    setRefusal(null);
    setDeliveryNote(null);
    setSending(true);
    try {
      const raw = await invoke<unknown>("heddle_comms_send", { target, body, replyTo: replyToId ?? null });
      const result = parseOperatorResult(raw);
      if (genRef.current !== gen) return;
      if (isOperatorFailure(result)) {
        setRefusal(result);
        return;
      }
      setDeliveryNote(deliveryNoteText(t, result, target));
      onDone();
    } catch (e) {
      if (genRef.current === gen) setRefusal(operatorErrorResult(e));
    } finally {
      if (genRef.current === gen) setSending(false);
    }
  };

  return { sending, refusal, setRefusal, deliveryNote, setDeliveryNote, send };
}

interface ReplyContextProps {
  replyTo: CommsNeedsHumanRow;
  onClear: () => void;
}

function ReplyContext({ replyTo, onClear }: ReplyContextProps) {
  const t = useT();
  return (
    <div className="comms-reply-ctx" data-testid="comms-reply-ctx">
      <span className="comms-reply-txt">
        {t("fleet.comms.replyingTo", replyTo.sender)}: {replyTo.body}
      </span>
      <button
        type="button"
        className="comms-reply-clear"
        data-testid="comms-reply-clear"
        onClick={onClear}
        aria-label={t("common.close")}
        title={t("common.close")}
      >
        ×
      </button>
    </div>
  );
}

function RefusalBanner({ result, floorHolder }: { result: CommsOperatorResult; floorHolder: string | null }) {
  const t = useT();
  return (
    <div className="comms-refusal" data-testid="comms-refusal">
      {refusalText(t, result, floorHolder)}
    </div>
  );
}

interface ComposerRowProps {
  text: string;
  setText: (v: string) => void;
  atAll: boolean;
  setAtAll: (v: boolean) => void;
  disabled: boolean;
  canSend: boolean;
  effectiveTarget: string | null;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
}

function ComposerRow({ text, setText, atAll, setAtAll, disabled, canSend, effectiveTarget, onKeyDown, onSend }: ComposerRowProps) {
  const t = useT();
  return (
    <div className="comms-composer-row">
      <span className="comms-composer-as">{t("fleet.comms.asOperator")}</span>
      {effectiveTarget && (
        <span className="comms-composer-to" data-testid="comms-composer-to" aria-label={t("fleet.comms.sendingTo", effectiveTarget)}>
          → {effectiveTarget}
        </span>
      )}
      <textarea
        className="comms-composer-input"
        data-testid="comms-composer-input"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
        aria-label={effectiveTarget ? t("fleet.comms.composerPlaceholder", effectiveTarget) : t("fleet.comms.asOperator")}
        rows={1}
      />
      <label className="comms-toggle" data-testid="comms-atall-toggle">
        <input
          type="checkbox"
          checked={atAll}
          disabled={disabled}
          onChange={(e) => {
            setAtAll(e.target.checked);
          }}
        />
        {t("fleet.comms.atAll")}
      </label>
      <button className="comms-send" type="button" data-testid="comms-send-btn" disabled={!canSend} onClick={onSend}>
        {t("fleet.comms.send")}
      </button>
    </div>
  );
}

export interface ComposerProps {
  target: string | null;
  status: OperatorStatus;
  floorHolder: string | null;
  replyTo: CommsNeedsHumanRow | null;
  onClearReplyTo: () => void;
  onSent?: () => void;
}

export function Composer({ target, status, floorHolder, replyTo, onClearReplyTo, onSent }: ComposerProps) {
  const t = useT();
  const [text, setText] = useState("");
  const [atAll, setAtAll] = useState(false);
  // @all is an ADDRESS in the broker (address.ts: BROADCAST = "@all", parsed as kind "broadcast"),
  // not a body prefix. Prefixing the text would post an ordinary room message that merely STARTS
  // with "@all" — it would look sent and reach nobody extra. The toggle changes the destination.
  const effectiveTarget = atAll ? "@all" : target;
  const { sending, refusal, setRefusal, deliveryNote, setDeliveryNote, send } = useComposerSend(
    effectiveTarget,
    target,
    replyTo?.id,
    () => {
      setText("");
      onClearReplyTo();
      onSent?.();
    },
    t,
  );

  // Composer state is per-TARGET, not global: a half-typed body, the @all toggle, and a stale
  // refusal banner all belong to the room/DM they were composed for. Switching the active target
  // must clear them, or a draft (or an old refusal) from one room could bleed into whichever
  // target is active next (HED-74c review round 1, B4). Deliberately keyed on the raw `target`
  // prop, not `effectiveTarget` — toggling @all is not a room switch and must not clear a draft.
  useEffect(() => {
    setText("");
    setAtAll(false);
    setRefusal(null);
    setDeliveryNote(null);
  }, [target, setDeliveryNote, setRefusal]);

  const hint = operatorHint(t, status.reason);
  const disabled = !status.available || target == null || sending;
  const canSend = !disabled && text.trim().length > 0;
  const doSend = () => {
    if (canSend) void send(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  return (
    <div className="comms-composer" data-testid="comms-composer">
      {replyTo && <ReplyContext replyTo={replyTo} onClear={onClearReplyTo} />}
      {refusal && <RefusalBanner result={refusal} floorHolder={floorHolder} />}
      {deliveryNote && (
        <div className="comms-delivery-note" data-testid="comms-delivery-note" role="status" aria-live="polite">
          {deliveryNote}
        </div>
      )}
      {hint && (
        <div className="comms-composer-hint" data-testid="comms-composer-hint">
          {hint}
        </div>
      )}
      <ComposerRow
        text={text}
        setText={setText}
        atAll={atAll}
        setAtAll={setAtAll}
        disabled={disabled}
        canSend={canSend}
        effectiveTarget={effectiveTarget}
        onKeyDown={onKeyDown}
        onSend={doSend}
      />
    </div>
  );
}
