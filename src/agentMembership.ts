//! Authoritative project-membership check for fleet agents: is an agent's cwd inside one of a
//! project's registered git worktrees? Distinct from FleetDrawer's inCurrentProject (a display-only
//! basename heuristic with false positives) — this matches exactly against the worktree set returned
//! by `list_project_worktrees`, so it is safe to use for real scoping decisions (HED-167/170).

/**
 * Normalize a path for cross-platform comparison: backslashes become forward slashes and trailing
 * slashes are stripped, so nested matching works on Windows. Comparison stays CASE-SENSITIVE — the
 * agent cwd and the git worktree paths both come from the same OS in canonical case, so they match
 * as-is, while case-folding would wrongly conflate distinct directories on case-sensitive
 * filesystems (Linux).
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
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
