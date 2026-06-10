import { runCommand } from "./exec.js";

export interface GitmoduleEntry {
  path: string;
  branch?: string;
}

/**
 * A resolved git author identity for stamping notes and marks (FR-012).
 *
 * When {@link GitIdentity.isSentinel} is `true`, the real git identity could
 * not be resolved (unset, empty, or the git command failed) and the sentinel
 * values {@link SENTINEL_AUTHOR_NAME} / {@link SENTINEL_AUTHOR_EMAIL} are used.
 */
export interface GitIdentity {
  name: string;
  email: string;
  /** Present and `true` only when the sentinel author was substituted. */
  isSentinel?: boolean;
}

/** Sentinel author name used when the real git `user.name` cannot be resolved. */
export const SENTINEL_AUTHOR_NAME = "Unknown Author";

/** Sentinel author email used when the real git `user.email` cannot be resolved. */
export const SENTINEL_AUTHOR_EMAIL = "unknown@roubo.local";

/**
 * Resolves the git author identity (`user.name` / `user.email`) scoped to the
 * bench workspace at `repoPath`, with a graceful sentinel fallback.
 *
 * Author stamping (FR-012) must never fail a note/mark write, so this probe
 * follows the fail-quiet pattern of {@link probeHeadBranch} /
 * {@link probeDirtyCounts}: it never throws.
 *
 * - Both `user.name` and `user.email` resolve to non-empty values: returns
 *   `{ name, email }` with no `isSentinel` flag.
 * - Either value is unset/empty, or a git command fails: returns
 *   `{ name: SENTINEL_AUTHOR_NAME, email: SENTINEL_AUTHOR_EMAIL, isSentinel: true }`.
 *
 * UI-warning contract (AC3): when the returned identity has `isSentinel === true`,
 * the caller MUST surface a UI warning that the git identity could not be
 * resolved and a sentinel author was used to stamp the note/mark. Wiring this
 * into the store (#11) and rendering the notes UI (#17) are out of scope here;
 * this function only resolves the identity and defines the contract.
 */
export async function resolveGitIdentity(repoPath: string): Promise<GitIdentity> {
  const sentinel: GitIdentity = {
    name: SENTINEL_AUTHOR_NAME,
    email: SENTINEL_AUTHOR_EMAIL,
    isSentinel: true,
  };

  try {
    const [nameResult, emailResult] = await Promise.all([
      runCommand("git", ["config", "user.name"], repoPath, undefined, 5_000),
      runCommand("git", ["config", "user.email"], repoPath, undefined, 5_000),
    ]);

    if (nameResult.code !== 0 || emailResult.code !== 0) return sentinel;

    const name = nameResult.stdout.trim();
    const email = emailResult.stdout.trim();
    if (!name || !email) return sentinel;

    return { name, email };
  } catch {
    // Any unexpected failure falls back to the sentinel; never throw.
    return sentinel;
  }
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
    // detached HEAD or error: continue to fallbacks
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
      "Could not determine the current branch in the source repo: it may be in a detached HEAD state.",
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
