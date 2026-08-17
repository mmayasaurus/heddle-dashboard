//! Operator write-path data layer (HED-74c): polls heddle_comms_operator_status every 30s so the
//! composer and room-management affordances know whether writes are currently possible, plus the
//! shared result shape/helpers for the four write commands (send, create-room, add/remove member).
//!
//! Backend payloads here are typed `unknown` and narrowed with runtime type predicates before use
//! — unlike the read-only poll in useCommsPoll.ts (whose shapes come straight from this app's own
//! SQLite reader), these responses cross an `heddle-comms` MCP child process (HED-74c PR C1) that
//! this module does not control the exact wire shape of. A malformed payload is treated as a safe
//! "unavailable / local error" default rather than trusted or allowed to throw.
//!
//! The operator subprocess may not exist yet on a given build (parallel Rust work): an invoke()
//! rejection for any of these commands is handled the same as a well-formed "unavailable" or
//! "error" response, never surfaced as an uncaught exception or a generic error string.

import { useEffect, useState } from "react";
import { invoke, isTauri } from "../../../ipc/transport";
import { useT } from "../../../i18n";

const STATUS_POLL_MS = 30_000;

export type OperatorStatusReason = "no-binary" | "no-token" | "revoked" | "spawn-failed" | null;

export interface OperatorStatus {
  available: boolean;
  revoked: boolean;
  reason: OperatorStatusReason;
}

const REASONS = new Set(["no-binary", "no-token", "revoked", "spawn-failed"]);

function isOperatorStatus(v: unknown): v is OperatorStatus {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.available !== "boolean") return false;
  if (typeof o.revoked !== "boolean") return false;
  if (o.reason !== null && !REASONS.has(o.reason as string)) return false;
  return true;
}

/** Safe default before the first poll resolves, or after a malformed/rejected one: unavailable
 *  with NO reason. Composer and the room affordances render disabled with no hint in this state
 *  rather than guess at one — a wrong hint would send the operator to fix the wrong thing. */
const UNKNOWN_STATUS: OperatorStatus = { available: false, revoked: false, reason: null };

type T = ReturnType<typeof useT>;

/** Maps a disabled reason to its exact operator-facing hint. Null means either available (no hint
 *  needed) or the reason is still unknown (pre-first-poll / malformed payload) — render nothing in
 *  that case, never a generic error string, per the HED-74c spec. */
export function operatorHint(t: T, reason: OperatorStatusReason): string | null {
  switch (reason) {
    case "no-binary":
      return t("fleet.comms.operatorHintNoBinary");
    case "no-token":
      return t("fleet.comms.operatorHintNoToken");
    case "revoked":
      return t("fleet.comms.operatorHintRevoked");
    case "spawn-failed":
      return t("fleet.comms.operatorHintSpawnFailed");
    default:
      return null;
  }
}

export interface UseOperatorStatusResult extends OperatorStatus {
  /** True once the first response (success, malformed, or rejection) has settled. */
  loaded: boolean;
}

/** Polls heddle_comms_operator_status every 30s while `expanded`, immediately on becoming
 *  expanded — mirrors useCommsPoll's roster poll, since every consumer (Composer, "+ New room",
 *  room-header member controls) only renders while the chatroom pane is expanded. */
export function useOperatorStatus(expanded: boolean): UseOperatorStatusResult {
  const [status, setStatus] = useState<OperatorStatus>(UNKNOWN_STATUS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    if (!expanded) return;
    let cancelled = false;
    const fetchStatus = async () => {
      if (!isTauri) return;
      try {
        const raw = await invoke<unknown>("heddle_comms_operator_status");
        if (cancelled) return;
        setStatus(isOperatorStatus(raw) ? raw : UNKNOWN_STATUS);
      } catch {
        if (!cancelled) setStatus(UNKNOWN_STATUS);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void fetchStatus();
    const id = window.setInterval(() => void fetchStatus(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [expanded]);

  return { ...status, loaded };
}

// ── Shared write-path result shape (send / create-room / add-member / remove-member) ──
// The broker's post_message (and, by the same HED-74c contract shape, create_room/join_room/
// leave_room) results carry {outcome, code, reason}; a 'refused' outcome (e.g. floor-held) is a
// NORMAL result, never a thrown error.

export interface CommsOperatorResult {
  outcome: string;
  code: string | null;
  reason: string | null;
}

export function isCommsOperatorResult(v: unknown): v is CommsOperatorResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.outcome !== "string") return false;
  if (o.code !== null && typeof o.code !== "string") return false;
  if (o.reason !== null && typeof o.reason !== "string") return false;
  return true;
}

/** Parses an invoke() result into a typed CommsOperatorResult. A malformed/unexpected shape
 *  becomes the local 'error' sentinel rather than being trusted or thrown. */
export function parseOperatorResult(raw: unknown): CommsOperatorResult {
  return isCommsOperatorResult(raw) ? raw : { outcome: "error", code: null, reason: null };
}

/** Sentinel for a thrown/rejected invoke() call, carrying the caught error's message as the
 *  reason so it still renders inline instead of vanishing as a swallowed exception. */
export function operatorErrorResult(e: unknown): CommsOperatorResult {
  return { outcome: "error", code: null, reason: String(e) };
}

/** True when a result must not be treated as success — either the broker's own 'refused' outcome
 *  (a NORMAL result, e.g. floor-held) or this module's local 'error' sentinel. Both render inline
 *  with their reason and must never clear anything the operator already typed. */
export function isOperatorFailure(r: CommsOperatorResult): boolean {
  return r.outcome === "refused" || r.outcome === "error";
}
