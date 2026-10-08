import fs from "node:fs";
import path from "node:path";

/** One worktree as `git worktree list --porcelain` reports it. */
export interface WorktreeEntry {
  /** The path git recorded, which is the real path when the worktree was added. */
  path: string;
  /** Git marks a worktree prunable when its directory is gone but its admin dir remains. */
  prunable: boolean;
}

/**
 * Resolves symlinks in `p` so it compares equal to the path git records (#1433).
 * Git stores the real path of a worktree, while Roubo stores the path it built
 * from the state dir, so a symlink anywhere above the workspace makes the two
 * strings differ. A missing leaf resolves against its real parent, which is
 * what lets a worktree whose directory is already gone still match.
 */
export function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), prunable: false };
      entries.push(current);
    } else if (current && (line === "prunable" || line.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  return entries;
}

/** The registered worktree at `workspacePath`, compared by canonical path. */
export function findWorktreeEntry(
  entries: WorktreeEntry[],
  workspacePath: string,
): WorktreeEntry | undefined {
  const target = canonicalPath(workspacePath);
  return entries.find((e) => e.path === workspacePath || canonicalPath(e.path) === target);
}
