//! Shared "currently-open project" resolution: activeSessionId -> session -> session.projectId ->
//! project. Extracted so other consumers (e.g. the fleet chatroom, HED-167/170) can resolve project
//! scope the same way FleetDrawer and CenterPane already do, instead of re-inlining the chain.

import { useTermStore, type TermStore } from "../store/termStore";
import type { Project } from "../types";

type CurrentProjectState = Pick<TermStore, "activeSessionId" | "sessions" | "ephemeralSessions" | "projects">;

/**
 * Resolve the project owning the active session. Undefined when there is no active session, or the
 * active session (regular or ephemeral) has no matching project. Pure and store-shape-only, so it
 * works both as a `useTermStore` selector and in tests without rendering a component.
 */
export function selectCurrentProject(state: CurrentProjectState): Project | undefined {
  const sid = state.activeSessionId;
  const sess = sid ? (state.sessions.find((s) => s.id === sid) ?? state.ephemeralSessions[sid]) : undefined;
  return sess ? state.projects.find((p) => p.id === sess.projectId) : undefined;
}

/** Currently-open project, reactive to store changes. */
export function useCurrentProject(): Project | undefined {
  return useTermStore(selectCurrentProject);
}
