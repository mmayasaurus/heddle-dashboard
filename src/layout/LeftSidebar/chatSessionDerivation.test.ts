import { describe, expect, it } from "vitest";
import type { Project, RoomAssociation } from "../../types";
import type { CommsRoom } from "../CenterPane/comms/useCommsPoll";
import {
  deriveChatTree,
  FLEET_PROJECT_ID,
} from "./chatSessionDerivation";

const project = (id: string): Project => ({
  id,
  name: id,
  rootPath: `/tmp/${id}`,
  sortOrder: 0,
  collapsed: false,
  createdAt: 0,
});

const room = (target: string): CommsRoom => ({
  target,
  open: false,
  topic: null,
  memberCount: null,
  latestId: 0,
});

const association = (roomName: string, projectId: string, isDefault = false): RoomAssociation => ({
  roomName,
  projectId,
  isDefault,
});

describe("HED-265 chat session derivation", () => {
  it("groups associated rooms under their projects", () => {
    const result = deriveChatTree({
      projects: [project("alpha"), project("beta")],
      rooms: [room("#alpha"), room("#beta")],
      associations: [association("#alpha", "alpha"), association("#beta", "beta")],
    });

    expect(result.sessions.map((session) => [session.projectId, session.chatTarget])).toEqual([
      ["alpha", "#alpha"],
      ["beta", "#beta"],
    ]);
  });

  it("sorts a project's default room before its other rooms", () => {
    const result = deriveChatTree({
      projects: [project("alpha")],
      rooms: [room("#zeta"), room("#alpha"), room("#general")],
      associations: [
        association("#zeta", "alpha"),
        association("#alpha", "alpha", true),
        association("#general", "alpha"),
      ],
    });

    expect(result.sessions.map((session) => session.chatTarget)).toEqual([
      "#alpha",
      "#general",
      "#zeta",
    ]);
  });

  it("places unassociated rooms and #fleet in the global Fleet section", () => {
    const result = deriveChatTree({
      projects: [project("alpha")],
      rooms: [room("#alpha"), room("#side"), room("#fleet")],
      associations: [
        association("#alpha", "alpha"),
        association("#fleet", "alpha"),
      ],
    });

    expect(result.fleetProject).toMatchObject({ id: FLEET_PROJECT_ID, name: "Fleet" });
    expect(result.sessions
      .filter((session) => session.projectId === FLEET_PROJECT_ID)
      .map((session) => session.chatTarget))
      .toEqual(["#fleet", "#side"]);
  });
});
