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

/** Git's admin dir for one linked worktree, under `<common-dir>/worktrees/`. */
export interface AdminDir {
  dir: string;
  /** The worktree path its `gitdir` file records, or undefined when the file is unreadable. */
  worktreePath?: string;
}

/**
 * Every admin dir under `<common-dir>/worktrees/`, read from disk rather than
 * from `git worktree list`, which omits one whose `gitdir` file is missing.
 */
export function listAdminDirs(commonDir: string): AdminDir[] {
  const worktreesDir = path.join(commonDir, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(worktreesDir);
  } catch {
    return [];
  }
  return names.map((name) => {
    const dir = path.join(worktreesDir, name);
    try {
      // `gitdir` names `<worktree>/.git`, relative to the admin dir when
      // worktree.useRelativePaths is set.
      const recorded = fs.readFileSync(path.join(dir, "gitdir"), "utf-8").trim();
      return recorded ? { dir, worktreePath: path.dirname(path.resolve(dir, recorded)) } : { dir };
    } catch {
      return { dir };
    }
  });
}

/**
 * The admin dir of the worktree at `workspacePath`, for removing it by hand when
 * git cannot. Read from the worktree's own `.git` file while the directory
 * exists, else found by a scan of the recorded paths. An admin dir is returned
 * only when it sits directly under `<common-dir>/worktrees/` and its own
 * `gitdir` records `workspacePath`. A `.git` file that names another worktree's
 * admin dir (the one state in which git refuses `remove --force --force` with
 * a readable gitfile) must never lead the caller to delete that other dir.
 */
export function findAdminDir(commonDir: string, workspacePath: string): string | undefined {
  const worktreesDir = canonicalPath(path.join(commonDir, "worktrees"));
  const target = canonicalPath(workspacePath);
  const recordsTarget = (admin: AdminDir) =>
    admin.worktreePath !== undefined && canonicalPath(admin.worktreePath) === target;
  try {
    const gitfile = fs.readFileSync(path.join(workspacePath, ".git"), "utf-8");
    const match = /^gitdir: (.+)$/m.exec(gitfile);
    if (match) {
      const dir = canonicalPath(path.resolve(workspacePath, match[1].trim()));
      if (path.dirname(dir) === worktreesDir) {
        const candidate = listAdminDirs(commonDir).find((a) => canonicalPath(a.dir) === dir);
        if (candidate && recordsTarget(candidate)) return candidate.dir;
      }
    }
  } catch {
    // No readable gitfile: the directory is gone, or it is not a linked worktree.
  }
  return listAdminDirs(commonDir).find(recordsTarget)?.dir;
}
