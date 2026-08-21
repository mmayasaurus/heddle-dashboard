import { useEffect } from "react";
import { listRoomAssociations } from "../../ipc/commands";
import { invoke, isTauri } from "../../ipc/transport";
import { useTermStore } from "../../store/termStore";
import { deriveChatTree, type ChatRoomSource } from "./chatSessionDerivation";

interface RoomsSnapshot {
  rooms: ChatRoomSource[];
}

const ROOMS_POLL_MS = 5_000;

/** Keeps the ephemeral room-to-session projection current for the tree and center pane. */
export function useDerivedChatSessions(): void {
  const projects = useTermStore((state) => state.projects);
  const setChatSessions = useTermStore((state) => state.setChatSessions);

  useEffect(() => {
    // Keep shallow store mocks used by isolated sidebar tests renderable during the transition.
    if (!setChatSessions) return;
    if (!isTauri) {
      setChatSessions([]);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const [snapshot, associations] = await Promise.all([
          invoke<RoomsSnapshot>("heddle_comms_rooms"),
          listRoomAssociations(),
        ]);
        if (cancelled) return;
        setChatSessions(deriveChatTree({ projects, rooms: snapshot.rooms, associations }).sessions);
      } catch {
        // Keep the last successfully derived room list until either IPC surface recovers.
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), ROOMS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projects, setChatSessions]);
}
