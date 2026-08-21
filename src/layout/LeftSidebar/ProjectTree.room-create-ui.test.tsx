import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectTree, type TreeHandlers } from "./ProjectTree";
import { associateRoomToProject } from "../../ipc/commands";

const storeState = vi.hoisted(() => ({
  projects: [{ id: "project-1", name: "Project one", rootPath: "/tmp/project", sortOrder: 0, collapsed: false, createdAt: 0 }],
  treeLoaded: true,
  setCreateProjectModalOpen: vi.fn(), importProject: vi.fn(), setCloneModalOpen: vi.fn(),
  shortcutOverrides: {}, groups: [], sessions: [], ephemeralSessions: {}, toggleCollapsed: vi.fn(), openSession: vi.fn(),
  activeSessionId: null, revealProjectId: null, setRevealProject: vi.fn(), density: "normal", navLayout: "normal",
  revealSuppressId: null, setRevealSuppress: vi.fn(),
  moveNode: vi.fn(), moveMany: vi.fn(), selection: [], selectionAnchor: null, selectSingle: vi.fn(), toggleSelect: vi.fn(),
  setSelection: vi.fn(), setInspectTarget: vi.fn(), setSidebarTreeViewCollapsed: vi.fn(), runtimes: {}, notifications: {},
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 28 })),
    measure: vi.fn(), scrollToIndex: vi.fn(), measureElement: vi.fn(),
  }),
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../store/termStore", () => ({
  useTermStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("../../ipc/transport", () => ({ isTauri: true, invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../ipc/commands", () => ({ associateRoomToProject: vi.fn(), listRoomAssociations: vi.fn(() => Promise.resolve([])) }));
vi.mock("../CenterPane/comms/useOperatorStatus", () => ({
  useOperatorStatus: () => ({ available: true, reason: null, revoked: false, loaded: true }),
  operatorHint: () => null,
}));
vi.mock("../CenterPane/comms/RoomCreateModal", () => ({
  RoomCreateModal: ({ onCreated }: { onCreated: (room: string) => Promise<void> }) => (
    <button type="button" data-testid="scoped-room-modal" onClick={() => void onCreated("#project-room")}>create</button>
  ),
}));

const handlers: TreeHandlers = {
  view: { id: "view", name: "Main", treeFilter: "", statusFilter: null, statusFilterIds: null, markFilter: null, collapsedOverrides: null },
  isPrimary: true, onContext: vi.fn(), contextId: null, renamingId: null, renameVal: "", setRenameVal: vi.fn(),
  commitRename: vi.fn(), cancelRename: vi.fn(), onAddSession: vi.fn(), onAddGroup: vi.fn(),
};

describe("regression PR#285 — per-project New room action", () => {
  it("appears only for a non-Fleet project and opens a modal scoped to that project", async () => {
    render(<ProjectTree {...handlers} />);

    fireEvent.click(screen.getByTestId("tree-new-room-project-1"));
    expect(screen.getByTestId("scoped-room-modal")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scoped-room-modal"));

    await waitFor(() => expect(associateRoomToProject).toHaveBeenCalledWith("#project-room", "project-1", false));
    expect(screen.queryByTestId(`tree-new-room-${"__fleet__"}`)).toBeNull();
  });
});
