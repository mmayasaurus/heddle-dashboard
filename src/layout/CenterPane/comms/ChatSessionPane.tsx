import { useEffect, useState, type CSSProperties } from "react";
import { isTauri } from "../../../ipc/transport";
import { useT } from "../../../i18n";
import { ChatColumn } from "./ChatroomPane";
import "./comms.css";
import { useCommsPoll, type CommsNeedsHumanRow } from "./useCommsPoll";
import { useOperatorStatus } from "./useOperatorStatus";

interface ChatSessionPaneProps {
  chatTarget: string;
  hidden?: boolean;
  area?: CSSProperties;
}

export function ChatSessionPane({ chatTarget, hidden = false, area }: ChatSessionPaneProps) {
  const t = useT();
  const target = chatTarget.trim();
  const hasTarget = target.length > 0;
  const [activeTarget, setActiveTarget] = useState<string | null>(hasTarget ? target : null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<CommsNeedsHumanRow | null>(null);
  const containerStyle: CSSProperties = { position: "absolute", ...area, display: hidden ? "none" : undefined };

  useEffect(() => {
    setActiveTarget(target || null);
    setHighlightId(null);
    setReplyTo(null);
  }, [target]);

  // Hidden keep-alive chat panes must not make *any* comms request, including the rooms poll.
  const poll = useCommsPoll(!hidden && hasTarget, hasTarget ? activeTarget : null, false);
  const opStatus = useOperatorStatus(!hidden && hasTarget);

  if (!isTauri) return null;
  if (!hasTarget) {
    return (
      <div className="comms-empty-state comms-session-pane" style={containerStyle} data-testid="chat-session-empty-target">
        {t("fleet.comms.targetUnavailable")}
      </div>
    );
  }
  if (!poll.loaded) return <div className="comms-loading comms-session-pane" style={containerStyle} data-testid="comms-loading" aria-hidden="true" />;
  if (!poll.schemaOk) {
    return (
      <div className="comms-schema-banner comms-session-pane" style={containerStyle} data-testid="comms-schema-banner">
        {t("fleet.comms.schemaUnsupported", poll.schemaVersion)}
      </div>
    );
  }
  if (poll.schemaVersion === 0) {
    return (
      <div className="comms-empty-state comms-session-pane" style={containerStyle} data-testid="comms-empty-state">
        {t("fleet.comms.emptyState")}
      </div>
    );
  }

  const handleNeedsHumanRowClick = (row: CommsNeedsHumanRow) => {
    setActiveTarget(row.sender);
    setHighlightId(row.id);
    setReplyTo(row);
  };

  return (
    <div className="comms-session-pane" style={containerStyle}>
      <ChatColumn
        poll={poll}
        activeTarget={activeTarget}
        highlightId={highlightId}
        opStatus={opStatus}
        replyTo={replyTo}
        onClearReplyTo={() => { setReplyTo(null); }}
        onNeedsHumanRowClick={handleNeedsHumanRowClick}
      />
    </div>
  );
}
