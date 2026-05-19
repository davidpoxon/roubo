import { runCommand } from "./exec.js";

export interface GitmoduleEntry {
  path: string;
  branch?: string;
}

// Cache remote URLs for the process lifetime — they don't change once a worktree is created.
const repoFullNameCache = new Map<string, string | null>();

/**
 * Resolves the GitHub `owner/repo` identifier from the `origin` remote URL
 * of the git repo at the given path. Supports SSH and HTTPS remote formats.
 * Returns `null` if the remote URL cannot be resolved or parsed.
 *
 * Results are cached indefinitely — remote URLs don't change for the lifetime
 * of a worktree, so calling this repeatedly within or across ticks is free.
 */
export async function resolveRepoFullName(repoPath: string): Promise<string | null> {
  const cached = repoFullNameCache.get(repoPath);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  try {
    const result = await runCommand(
      "git",
      ["remote", "get-url", "origin"],
      repoPath,
      undefined,
      5_000,
    );
    if (result.code === 0 && result.stdout.trim()) {
      const url = result.stdout.trim();
      // SSH: git@github.com:owner/repo.git
      const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
      // Port-qualified SSH: git@ssh.github.com:443/owner/repo.git
      const sshPortMatch = url.match(/:\d+\/([^/]+\/[^/]+?)(?:\.git)?$/);
      if (sshMatch) {
        resolved = sshMatch[1];
      } else if (sshPortMatch) {
        resolved = sshPortMatch[1];
      } else {
        // HTTPS: https://github.com/owner/repo.git
        try {
          const parsed = new URL(url);
          const parts = parsed.pathname.replace(/\.git$/, "").replace(/^\//, "");
          if (parts.includes("/")) resolved = parts;
        } catch {
          // not a valid URL
        }
      }
    }
  } catch {
    // command failed — leave resolved as null
  }

  repoFullNameCache.set(repoPath, resolved);
  return resolved;
}

/** Clears the resolveRepoFullName cache. Only call this in tests. */
export function clearRepoFullNameCache(): void {
  repoFullNameCache.clear();
}

// ── Work-unit activity probes ──
// These fail-quiet (return zero / null on any git error) because they gate a
// visual hint, not a safety check. Contrast with resolveHeadBranch (throws)
// and git-state.ts (fails-safe to dirty to gate teardown).

/**
 * Returns the currently checked-out branch name, or `null` if the repo is in
 * a detached HEAD state or the command fails.
 */
export async function probeHeadBranch(repoPath: string): Promise<string | null> {
  const result = await runCommand(
    "git",
    ["symbolic-ref", "--short", "HEAD"],
    repoPath,
    undefined,
    5_000,
  );
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

/**
 * Returns counts of modified (staged + unstaged, non-untracked) and untracked
 * files in the working tree. Returns `{ modifiedCount: 0, untrackedCount: 0 }`
 * on any git error.
 */
export async function probeDirtyCounts(
  repoPath: string,
): Promise<{ modifiedCount: number; untrackedCount: number }> {
  const result = await runCommand("git", ["status", "--porcelain"], repoPath, undefined, 5_000);
  if (result.code !== 0 || !result.stdout.trim()) return { modifiedCount: 0, untrackedCount: 0 };
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const untrackedCount = lines.filter((l) => l.startsWith("??")).length;
  const modifiedCount = lines.length - untrackedCount;
  return { modifiedCount, untrackedCount };
}

/**
 * Returns the number of commits ahead of upstream, or the number of unique
 * commits not on any remote when there is no upstream configured. Returns `0`
 * if the HEAD is detached, there is no upstream, or on any git error.
 */
export async function probeUnpushedCount(repoPath: string): Promise<number> {
  // Exit code 1 from symbolic-ref = detached HEAD (expected — return 0).
  const symref = await runCommand(
    "git",
    ["symbolic-ref", "-q", "HEAD"],
    repoPath,
    undefined,
    5_000,
  );
  if (symref.code !== 0) return 0;

  const upstream = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    repoPath,
    undefined,
    5_000,
  );
  if (upstream.code !== 0) {
    // No upstream configured — count commits not present on any remote.
    const unique = await runCommand(
      "git",
      ["rev-list", "--count", "HEAD", "--not", "--remotes"],
      repoPath,
      undefined,
      5_000,
    );
    if (unique.code !== 0) return 0;
    const n = parseInt(unique.stdout.trim(), 10);
    return isNaN(n) ? 0 : n;
  }

  const ahead = await runCommand(
    "git",
    ["rev-list", "--count", "@{upstream}..HEAD"],
    repoPath,
    undefined,
    5_000,
  );
  if (ahead.code !== 0) return 0;
  const n = parseInt(ahead.stdout.trim(), 10);
  return isNaN(n) ? 0 : n;
}

export interface WorkUnitProbeResult {
  /** Checked-out branch, or null when HEAD is detached. */
  branch: string | null;
  dirty: {
    modifiedCount: number;
    untrackedCount: number;
    unpushedCommits: number;
  };
}

/**
 * Probes the current HEAD branch and filesystem activity for a single work-unit
 * worktree. All three git calls run in parallel. Fails-quiet on any error.
 */
export async function probeWorkUnitState(repoPath: string): Promise<WorkUnitProbeResult> {
  const [branch, dirtyCounts, unpushedCommits] = await Promise.all([
    probeHeadBranch(repoPath),
    probeDirtyCounts(repoPath),
    probeUnpushedCount(repoPath),
  ]);
  return {
    branch,
    dirty: {
      modifiedCount: dirtyCounts.modifiedCount,
      untrackedCount: dirtyCounts.untrackedCount,
      unpushedCommits,
    },
  };
}

/**
 * Parses a .gitmodules file content and returns a map from submodule name to
 * its path and optional branch field.
 */
export function parseGitmodulesWithBranch(content: string): Record<string, GitmoduleEntry> {
  const submodules: Record<string, GitmoduleEntry> = {};
  let currentName: string | null = null;
  let currentEntry: Partial<GitmoduleEntry> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[submodule\s+"(.+)"\]$/);
    if (sectionMatch) {
      if (currentName && currentEntry.path) {
        submodules[currentName] = { path: currentEntry.path, branch: currentEntry.branch };
      }
      currentName = sectionMatch[1];
      currentEntry = {};
      continue;
    }
    if (currentName) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key === "path") currentEntry.path = value;
        else if (key === "branch") currentEntry.branch = value;
      }
    }
  }
  if (currentName && currentEntry.path) {
    submodules[currentName] = { path: currentEntry.path, branch: currentEntry.branch };
  }

  return submodules;
}

/**
 * Resolves the branch for a submodule worktree using a three-step cascade per spec §5.2:
 * 1. git symbolic-ref --short HEAD (the checked-out branch)
 * 2. The `branch` field from .gitmodules (fallback for detached HEAD)
 * 3. resolveDefaultBranch (origin/HEAD) in the submodule dir
 *
 * Returns 'unknown' if all three fail.
 */
export async function resolveSubmoduleBranch(
  submodulePath: string,
  gitmodulesBranch?: string,
): Promise<string> {
  try {
    return await resolveHeadBranch(submodulePath);
  } catch {
    // detached HEAD or error — continue to fallbacks
  }

  if (gitmodulesBranch) {
    return gitmodulesBranch;
  }

  try {
    return await resolveDefaultBranch(submodulePath);
  } catch {
    // all methods exhausted
  }

  return "unknown";
}

export const DEFAULT_BRANCH_RESOLUTION_ERROR =
  "Could not determine the default branch for this project. Fetch from origin or disable 'Branch from default branch' in project settings.";

export class DefaultBranchResolutionError extends Error {
  constructor() {
    super(DEFAULT_BRANCH_RESOLUTION_ERROR);
    this.name = "DefaultBranchResolutionError";
  }
}

/**
 * Resolves the currently checked-out branch in the given repo by running
 * `git symbolic-ref --short HEAD`.
 *
 * Throws if the repo is in a detached HEAD state or the command fails.
 */
export async function resolveHeadBranch(repoPath: string): Promise<string> {
  const result = await runCommand(
    "git",
    ["symbolic-ref", "--short", "HEAD"],
    repoPath,
    undefined,
    5_000,
  );
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(
      "Could not determine the current branch in the source repo — it may be in a detached HEAD state.",
    );
  }
  return result.stdout.trim();
}

/**
 * Resolves the project's default branch by reading `refs/remotes/origin/HEAD`
 * and stripping the `refs/remotes/origin/` prefix to return the short branch
 * name (e.g. `main`, `master`, `develop`).
 *
 * Throws {@link DefaultBranchResolutionError} if the ref is missing, the exit
 * code is non-zero, or the output is in an unexpected format.
 */
export async function resolveDefaultBranch(repoPath: string): Promise<string> {
  const result = await runCommand(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    repoPath,
    undefined,
    5_000,
  );
  if (result.code !== 0) throw new DefaultBranchResolutionError();

  const ref = result.stdout.trim();
  const prefix = "refs/remotes/origin/";
  if (!ref.startsWith(prefix)) throw new DefaultBranchResolutionError();

  const branch = ref.slice(prefix.length);
  if (!branch) throw new DefaultBranchResolutionError();
  return branch;
}
