//! Coverage for agentInProjectWorktrees against the real Spinventory sibling-worktree layout (HED-167):
//! `git worktree list` at a project root registers sibling directories like
//! `Rebuild-Project-Root.agent-b` alongside the root itself, so membership must match the exact
//! registered set — never a loose prefix/basename heuristic (see FleetDrawer's inCurrentProject,
//! deliberately not reused here).

import { describe, expect, it } from "vitest";
import { agentInProjectWorktrees } from "./agentMembership";

const WORKTREES = [
  "/x/Rebuild-Project-Root",
  "/x/Rebuild-Project-Root.agent-b",
  "/x/Rebuild-Project-Root.forms",
];

describe("agentInProjectWorktrees", () => {
  it("matches a cwd that is itself a registered sibling worktree", () => {
    expect(agentInProjectWorktrees("/x/Rebuild-Project-Root.agent-b", WORKTREES)).toBe(true);
  });

  it("matches the root worktree itself", () => {
    expect(agentInProjectWorktrees("/x/Rebuild-Project-Root", WORKTREES)).toBe(true);
  });

  it("matches a cwd nested under a registered worktree", () => {
    expect(agentInProjectWorktrees("/x/Rebuild-Project-Root.forms/sub/dir", WORKTREES)).toBe(true);
  });

  it("rejects an unrelated repository", () => {
    expect(agentInProjectWorktrees("/x/other-repo", WORKTREES)).toBe(false);
  });

  it("rejects a path that merely shares a prefix but isn't a registered worktree", () => {
    expect(agentInProjectWorktrees("/x/Rebuild-Project-Root-NOT-A-WORKTREE", WORKTREES)).toBe(false);
  });

  it("normalizes trailing slashes on both the cwd and the worktree entries", () => {
    expect(agentInProjectWorktrees("/x/Rebuild-Project-Root/", WORKTREES)).toBe(true);
    expect(agentInProjectWorktrees("/x/Rebuild-Project-Root", ["/x/Rebuild-Project-Root/"])).toBe(true);
  });

  it("returns false against an empty worktree set", () => {
    expect(agentInProjectWorktrees("/x/Rebuild-Project-Root", [])).toBe(false);
  });
});
