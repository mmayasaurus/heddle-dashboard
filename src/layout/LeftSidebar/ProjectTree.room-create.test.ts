import { describe, expect, it, vi } from "vitest";
import { associateThisRoom } from "./ProjectTree";
import { associateRoomToProject, listRoomAssociations } from "../../ipc/commands";

vi.mock("../../ipc/commands", () => ({
  associateRoomToProject: vi.fn(),
  listRoomAssociations: vi.fn(),
}));

const mockAssociate = vi.mocked(associateRoomToProject);
const mockList = vi.mocked(listRoomAssociations);

describe("regression PR#285 — project room association", () => {
  it("skips association when the room already maps to the target project", async () => {
    mockList.mockResolvedValue([{ roomName: "#project-room", projectId: "project-1", isDefault: true }]);

    await associateThisRoom("#project-room", "project-1");

    expect(mockAssociate).not.toHaveBeenCalled();
  });

  it("preserves a default association when its stored room name lacks #", async () => {
    mockList.mockResolvedValue([{ roomName: "heddle-dashboard", projectId: "p1", isDefault: true }]);

    await associateThisRoom("#heddle-dashboard", "p1");

    expect(mockAssociate).not.toHaveBeenCalled();
  });

  it("associates an unassociated room without making it the default", async () => {
    mockList.mockResolvedValue([]);

    await associateThisRoom("#project-room", "project-1");

    expect(mockAssociate).toHaveBeenCalledWith("#project-room", "project-1", false);
  });
});
