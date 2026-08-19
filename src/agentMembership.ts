//! Authoritative project-membership check for fleet agents: is an agent's cwd inside one of a
//! project's registered git worktrees? Distinct from FleetDrawer's inCurrentProject (a display-only
//! basename heuristic with false positives) — this matches exactly against the worktree set returned
//! by `list_project_worktrees`, so it is safe to use for real scoping decisions (HED-167/170).

/** Strip trailing slashes so "/x/" and "/x" compare equal. */
function stripTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * True when `agentCwd` is exactly one of `worktreePaths`, or nested under one of them. Exact matching
 * against the worktree set — no basename/prefix heuristics, so a directory that merely shares a path
 * prefix without itself being a registered worktree does not match.
 */
export function agentInProjectWorktrees(agentCwd: string, worktreePaths: string[]): boolean {
  const cwd = stripTrailingSlashes(agentCwd);
  return worktreePaths.some((worktreePath) => {
    const root = stripTrailingSlashes(worktreePath);
    return cwd === root || cwd.startsWith(root + "/");
  });
}
