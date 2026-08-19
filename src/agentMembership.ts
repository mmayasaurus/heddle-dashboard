//! Authoritative project-membership check for fleet agents: is an agent's cwd inside one of a
//! project's registered git worktrees? Distinct from FleetDrawer's inCurrentProject (a display-only
//! basename heuristic with false positives) — this matches exactly against the worktree set returned
//! by `list_project_worktrees`, so it is safe to use for real scoping decisions (HED-167/170).

/**
 * Normalize a path for cross-platform, case-insensitive comparison: backslashes become forward
 * slashes, trailing slashes are stripped, and the result is lowercased. The desktop targets (macOS,
 * Windows) are case-insensitive filesystems, and git/roster paths on the same OS use a consistent
 * separator, so normalizing makes nested matching work on Windows without changing the exact-set
 * semantics.
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * True when `agentCwd` is exactly one of `worktreePaths`, or nested under one of them. Exact matching
 * against the worktree set — no basename/prefix heuristics, so a directory that merely shares a path
 * prefix without itself being a registered worktree does not match. Empty worktree-path entries are
 * skipped after normalization so they can never match every absolute cwd.
 */
export function agentInProjectWorktrees(agentCwd: string, worktreePaths: string[]): boolean {
  const cwd = normalizePath(agentCwd);
  return worktreePaths.some((worktreePath) => {
    const root = normalizePath(worktreePath);
    if (root === "") return false;
    return cwd === root || cwd.startsWith(root + "/");
  });
}
