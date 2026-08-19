//! Coverage for the shared "currently-open project" resolution: activeSessionId -> session ->
//! session.projectId -> project — the same chain FleetDrawer.tsx and CenterPane.tsx each inline
//! independently. Tests the pure selector directly, with no store or IPC mocking required.

import { describe, expect, it } from "vitest";
import { selectCurrentProject } from "./useCurrentProject";
import type { Project, Session } from "../types";

const project = (id: string): Project => ({
  id,
  name: id,
  rootPath: `/repo/${id}`,
  sortOrder: 0,
  collapsed: false,
  createdAt: 0,
});

const session = (id: string, projectId: string): Session => ({
  id,
  projectId,
  name: id,
  kind: "terminal",
  collapsed: false,
  sortOrder: 0,
  createdAt: 0,
});

describe("selectCurrentProject", () => {
  it("returns undefined with no active session", () => {
    const got = selectCurrentProject({
      activeSessionId: null,
      sessions: [session("s1", "p1")],
      ephemeralSessions: {},
      projects: [project("p1")],
    });
    expect(got).toBeUndefined();
  });

  it("resolves through a persisted session to its project", () => {
    const p1 = project("p1");
    const got = selectCurrentProject({
      activeSessionId: "s1",
      sessions: [session("s1", "p1")],
      ephemeralSessions: {},
      projects: [p1, project("p2")],
    });
    expect(got).toBe(p1);
  });

  it("falls back to ephemeralSessions when the active session is not persisted", () => {
    const p1 = project("p1");
    const got = selectCurrentProject({
      activeSessionId: "eph1",
      sessions: [],
      ephemeralSessions: { eph1: session("eph1", "p1") },
      projects: [p1],
    });
    expect(got).toBe(p1);
  });

  it("returns undefined when the session's project no longer exists", () => {
    const got = selectCurrentProject({
      activeSessionId: "s1",
      sessions: [session("s1", "gone")],
      ephemeralSessions: {},
      projects: [project("p1")],
    });
    expect(got).toBeUndefined();
  });

  it("returns undefined when the active session id matches neither list", () => {
    const got = selectCurrentProject({
      activeSessionId: "missing",
      sessions: [session("s1", "p1")],
      ephemeralSessions: {},
      projects: [project("p1")],
    });
    expect(got).toBeUndefined();
  });
});
