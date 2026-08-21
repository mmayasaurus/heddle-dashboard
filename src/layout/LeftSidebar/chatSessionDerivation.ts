import type { Project, RoomAssociation, Session } from "../../types";

export interface ChatRoomSource {
  target: string;
}

export const FLEET_PROJECT_ID = "__heddle_fleet__";

interface DeriveChatTreeInput {
  projects: Project[];
  rooms: ChatRoomSource[];
  associations: RoomAssociation[];
}

interface DerivedChatTree {
  fleetProject: Project | null;
  sessions: Session[];
}

function chatSession(target: string, projectId: string, sortOrder: number): Session {
  return {
    id: `chat:${encodeURIComponent(target)}`,
    projectId,
    groupId: null,
    name: target,
    kind: "chat",
    chatTarget: target,
    parentSessionId: null,
    collapsed: false,
    sortOrder,
    createdAt: 0,
  };
}

/**
 * Produces transient chat sessions from the comms room list and persisted room associations.
 * These nodes are intentionally never written to the session database: room membership and
 * ownership remain authoritative in comms.db and project_rooms respectively.
 */
export function deriveChatTree({
  projects,
  rooms,
  associations,
}: DeriveChatTreeInput): DerivedChatTree {
  const projectIds = new Set(projects.map((project) => project.id));
  const associationByRoom = new Map(associations.map((association) => [association.roomName, association]));
  const associated = new Map<string, RoomAssociation[]>();
  const fleetRooms: string[] = [];

  for (const { target } of rooms) {
    const association = associationByRoom.get(target);
    if (target === "#fleet" || !association || !projectIds.has(association.projectId)) {
      fleetRooms.push(target);
      continue;
    }
    const projectRooms = associated.get(association.projectId) ?? [];
    projectRooms.push(association);
    associated.set(association.projectId, projectRooms);
  }

  const sessions: Session[] = [];
  for (const project of projects) {
    const projectRooms = associated.get(project.id) ?? [];
    projectRooms.sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.roomName.localeCompare(right.roomName);
    });
    projectRooms.forEach((room, index) => {
      sessions.push(chatSession(room.roomName, project.id, index));
    });
  }

  fleetRooms.sort((left, right) => {
    if (left === "#fleet") return -1;
    if (right === "#fleet") return 1;
    return left.localeCompare(right);
  });
  fleetRooms.forEach((target, index) => {
    sessions.push(chatSession(target, FLEET_PROJECT_ID, index));
  });

  return {
    fleetProject: fleetRooms.length > 0
      ? {
          id: FLEET_PROJECT_ID,
          name: "Fleet",
          rootPath: "",
          sortOrder: Number.MAX_SAFE_INTEGER,
          collapsed: false,
          createdAt: 0,
        }
      : null,
    sessions,
  };
}
