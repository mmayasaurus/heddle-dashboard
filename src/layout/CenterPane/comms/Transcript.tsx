//! Message transcript for the active room. Trust rendering is the security-critical part of this
//! file (HED-74b non-negotiable): render style is decided ONLY by `tier` + `verified`. An
//! unverified row can never render privileged (operator/directive) styling even if its tier
//! field claims to be one — defense in depth on top of the DB CHECK constraint. `fromNameClaim`
//! is surfaced as a suffix on the sender line and can never replace or restyle the sender.
//! Message bodies are plain text: they are interpolated as JSX children (React escapes text
//! content automatically), never through dangerouslySetInnerHTML or a markdown renderer.

import { useEffect } from "react";
import { dateLocale, useT } from "../../../i18n";
import { agentColor, type CommsDeliveries, type CommsMessage } from "./useCommsPoll";

type TrustStyle = "operator" | "directive" | "peer";

/** The one place that decides bubble style. Deliberately reads only tier + verified. */
function trustStyleFor(m: CommsMessage): TrustStyle {
  if (m.verified && m.tier === "operator") return "operator";
  if (m.verified && m.tier === "orchestrator-directive") return "directive";
  return "peer";
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
}

const RECEIPT_CATEGORIES: Array<keyof CommsDeliveries> = ["sent", "held", "released", "refused"];

function DeliveryChips({ d }: { d: CommsDeliveries }) {
  const shown = RECEIPT_CATEGORIES.filter((k) => d[k] > 0);
  if (shown.length === 0) return null;
  return (
    <div className="comms-receipts" data-testid="comms-receipts">
      {shown.map((k) => (
        <span
          key={k}
          className={"comms-chip-receipt" + (k === "refused" ? " comms-chip-refused" : "")}
          data-testid={`comms-receipt-${k}`}
        >
          {k} {d[k]}
        </span>
      ))}
    </div>
  );
}

function MessageRow({ m, highlighted }: { m: CommsMessage; highlighted: boolean }) {
  const t = useT();
  const style = trustStyleFor(m);
  const color = agentColor(m.sender);
  const letter = m.sender?.trim()[0]?.toUpperCase() ?? "?";

  return (
    <div
      id={`comms-msg-${m.id}`}
      data-testid={`comms-msg-${m.id}`}
      data-trust-style={style}
      className={"comms-msg comms-msg-" + style + (highlighted ? " comms-msg-highlight" : "")}
    >
      <span className="comms-msg-letter" style={color ? { color } : undefined}>
        {letter}
      </span>
      <div className="comms-msg-body">
        <div className="comms-msg-head">
          <span className="comms-msg-who">
            {m.sender}
            {m.fromNameClaim && (
              <span className="comms-msg-claim" data-testid={`comms-claim-${m.id}`}>
                {" "}
                (claims {m.fromNameClaim})
              </span>
            )}
          </span>
          {style === "operator" && (
            <span className="comms-seal" data-testid={`comms-seal-${m.id}`}>
              ✓ {t("fleet.comms.operatorSeal")}
            </span>
          )}
          {style === "directive" && (
            <span className="comms-chip-directive" data-testid={`comms-directive-chip-${m.id}`}>
              {t("fleet.comms.directiveChip", m.target)}
            </span>
          )}
          <span className="comms-msg-ts">{formatTs(m.ts)}</span>
        </div>
        <div className="comms-bubble" data-testid={`comms-body-${m.id}`}>
          {m.body}
        </div>
        {style === "directive" && m.deliveries && <DeliveryChips d={m.deliveries} />}
      </div>
    </div>
  );
}

export interface TranscriptProps {
  messages: CommsMessage[];
  highlightId?: number | null;
}

export function Transcript({ messages, highlightId = null }: TranscriptProps) {
  useEffect(() => {
    if (highlightId == null) return;
    const el = document.getElementById(`comms-msg-${highlightId}`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // messages is a deliberate dependency: if highlightId's row belongs to a room that hadn't
    // loaded yet, the element doesn't exist on the first pass — retrying as messages arrive lets
    // it scroll once the row actually mounts. Scrolling again to the same id is harmless.
  }, [highlightId, messages]);

  return (
    <div className="comms-scroll" data-testid="comms-transcript">
      {messages.map((m) => (
        <MessageRow key={m.id} m={m} highlighted={m.id === highlightId} />
      ))}
    </div>
  );
}
