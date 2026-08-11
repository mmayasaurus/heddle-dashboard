//! Lightweight Git branch/worktree information for pane-header and status-bar branch chips.
//! Cache by path and deduplicate same-path requests so multiple panes do not probe one repository repeatedly.

import { useEffect, useState } from "react";
import { getGitStatus } from "../ipc/info";

/** Git branch and worktree information resolved for a directory. */
export interface GitBranchInfo {
  /** Whether the directory is inside a Git repository; false on probe failure. */
  isRepo: boolean;
  /** Branch name; null outside a repository or under detached HEAD. */
  branch: string | null;
  /** Whether this is a linked Git worktree rather than the main worktree. */
  isWorktree: boolean;
  /** Top-level worktree path, present only for isWorktree and used in directory-name tooltips. */
  worktreePath: string | null;
}

const EMPTY: GitBranchInfo = {
  isRepo: false,
  branch: null,
  isWorktree: false,
  worktreePath: null,
};

const cache = new Map<string, GitBranchInfo>();
const inflight = new Map<string, Promise<GitBranchInfo>>();

/** Start or reuse an in-flight probe and populate the cache. */
function probe(path: string): Promise<GitBranchInfo> {
  let p = inflight.get(path);
  if (!p) {
    p = getGitStatus(path)
      .then((s) => ({
        isRepo: !!s.isRepo,
        branch: s.isRepo ? (s.branch ?? null) : null,
        isWorktree: !!s.isWorktree,
        worktreePath: s.worktreePath ?? null,
      }))
      .catch(() => EMPTY);
    inflight.set(path, p);
    void p.finally(() => inflight.delete(path));
  }
  void p.then((i) => cache.set(path, i));
  return p;
}

/** Read cached branch information synchronously; return undefined without requesting if never probed. Used to build session context menus. */
export function peekGitBranchInfo(path?: string | null): GitBranchInfo | undefined {
  return path ? cache.get(path) : undefined;
}

/** Trigger a cache-filling probe unless cached/in flight; menus warm it on open so the next open has a result. */
export function prefetchGitBranchInfo(path?: string | null): void {
  if (!path || cache.has(path)) return;
  void probe(path);
}

/** Invalidate a path after deleting a worktree. The next peek returns undefined and triggers a probe, which sees
 *  the missing directory as isRepo:false and enables the Convert to Regular Session/Group menu. */
export function invalidateGitBranch(path?: string | null): void {
  if (path) cache.delete(path);
}

/** Whether a worktree path has been deleted, inferred from branch cache: probed and not a repository means the
 *  directory is gone. If unprobed, warm the cache and temporarily return false. Convert to Regular Session/Group
 *  uses this gate and is allowed only when the node's bound worktree directory truly no longer exists. */
export function isWorktreeGone(worktreePath?: string | null): boolean {
  if (!worktreePath) return false;
  const info = peekGitBranchInfo(worktreePath);
  if (info === undefined) {
    prefetchGitBranchInfo(worktreePath);
    return false;
  }
  return !info.isRepo;
}

/** Get cached/deduplicated branch and worktree information for a directory. */
export function useGitBranchInfo(path?: string | null): GitBranchInfo {
  const [info, setInfo] = useState<GitBranchInfo>(() =>
    path && cache.has(path) ? cache.get(path)! : EMPTY,
  );

  useEffect(() => {
    if (!path) {
      setInfo(EMPTY);
      return;
    }
    if (cache.has(path)) {
      setInfo(cache.get(path)!);
      return;
    }
    let cancelled = false;
    void probe(path).then((i) => {
      if (!cancelled) setInfo(i);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return info;
}

/** Get only the branch name for compatibility with legacy callers. */
export function useGitBranch(path?: string | null): string | null {
  return useGitBranchInfo(path).branch;
}
