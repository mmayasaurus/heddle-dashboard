import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectTree, type TreeHandlers } from "./ProjectTree";
import { associateRoomToProject } from "../../ipc/commands";
import { invoke } from "../../ipc/transport";

const storeState = vi.hoisted(() => ({
  projects: [{ id: "project-1", name: "Project one", rootPath: "/tmp/project", sortOrder: 0, collapsed: false, createdAt: 0 }],
  treeLoaded: true,
  setCreateProjectModalOpen: vi.fn(), importProject: vi.fn(), setCloneModalOpen: vi.fn(),
  shortcutOverrides: {},
  groups: [{ id: "group-1", name: "Group one", projectId: "project-1", parentGroupId: null, sortOrder: 0, collapsed: false, createdAt: 0, worktreePath: null }],
  sessions: [{ id: "fleet-chat", projectId: "__heddle_fleet__", groupId: null, name: "#fleet", kind: "chat", collapsed: false, sortOrder: 0, createdAt: 0, chatTarget: "#fleet" }],
  ephemeralSessions: {}, toggleCollapsed: vi.fn(), openSession: vi.fn(),
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
vi.mock("../../ipc/transport", () => ({
  isTauri: true,
  invoke: vi.fn((cmd: string) => {
    if (cmd === "heddle_fleet_roster") return Promise.resolve([{ name: "T", pid: 1, sessionId: "s", cwd: "/", status: "working", kind: "agent", updatedAtMs: 0, alive: true, workers: [] }]);
    if (cmd === "heddle_comms_operator_status") return Promise.resolve({ available: true, revoked: false, reason: null });
    if (cmd === "heddle_comms_create_room") return Promise.resolve({ room: { name: "#project-room" } });
    if (cmd === "heddle_comms_add_member") return Promise.resolve({ member: { room: "#project-room", address: "T" } });
    return Promise.reject(new Error(`unexpected ${cmd}`));
  }),
}));
vi.mock("../../ipc/commands", () => ({ associateRoomToProject: vi.fn(), listRoomAssociations: vi.fn(() => Promise.resolve([])) }));

const mockInvoke = vi.mocked(invoke);

const handlers: TreeHandlers = {
  view: { id: "view", name: "Main", treeFilter: "", statusFilter: null, statusFilterIds: null, markFilter: null, collapsedOverrides: null },
  isPrimary: true, onContext: vi.fn(), contextId: null, renamingId: null, renameVal: "", setRenameVal: vi.fn(),
  commitRename: vi.fn(), cancelRename: vi.fn(), onAddSession: vi.fn(), onAddGroup: vi.fn(),
};

describe("regression PR#285 — per-project New room action", () => {
  it("appears only for a non-Fleet project and opens a modal scoped to that project", async () => {
    render(<ProjectTree {...handlers} />);

    expect(screen.getAllByTitle("tree.newRoom")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("tree-new-room-project-1"));
    const submit = await screen.findByTestId("comms-modal-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.change(screen.getByTestId("comms-modal-name"), { target: { value: "project-room" } });
    fireEvent.click(screen.getByTestId("comms-modal-member-T"));
    fireEvent.click(submit);

    await waitFor(() => expect(associateRoomToProject).toHaveBeenCalledWith("#project-room", "project-1", false));
    expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_add_member", { room: "#project-room", address: "T" });
    expect(screen.queryByTestId("tree-new-room-__heddle_fleet__")).toBeNull();
  });
});
