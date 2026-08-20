import type { CSSProperties } from "react";
import { isTauri } from "../../../ipc/transport";
import { ChatColumn } from "./ChatroomPane";
import "./comms.css";
import { useCommsPoll } from "./useCommsPoll";
import { useOperatorStatus } from "./useOperatorStatus";

interface ChatSessionPaneProps {
  chatTarget: string;
  hidden?: boolean;
  area?: CSSProperties;
}

export function ChatSessionPane({ chatTarget, hidden = false, area }: ChatSessionPaneProps) {
  // Only the visible pane polls: background keep-alive chat panes (display:none) would otherwise each
  // run the 2.5s comms poll + 30s operator-status poll for nothing. A pane resumes polling when shown.
  const poll = useCommsPoll(!hidden, chatTarget);
  const opStatus = useOperatorStatus(!hidden);

  if (!isTauri) return null;

  return (
    <div style={{ position: "absolute", ...area, display: hidden ? "none" : undefined }}>
      <ChatColumn
        poll={poll}
        activeTarget={chatTarget}
        highlightId={null}
        opStatus={opStatus}
        replyTo={null}
        onClearReplyTo={() => {}}
        onNeedsHumanRowClick={() => {}}
      />
    </div>
  );
}
