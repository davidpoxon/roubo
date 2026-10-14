import { runCommand } from "./exec.js";
import { canonicalPath, parseWorktreeList } from "./worktree-registry.js";

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
 * follows a fail-quiet pattern: it never throws.
 *
 * - Both `user.name` and `user.email` resolve to non-empty values: returns
 *   `{ name, email }` with no `isSentinel` flag.
 * - Either value is unset/empty, or a git command fails: returns
 *   `{ name: SENTINEL_AUTHOR_NAME, email: SENTINEL_AUTHOR_EMAIL, isSentinel: true }`.
 *
 * UI-warning contract (AC3): when the returned identity has `isSentinel === true`,
 * the caller MUST surface a UI warning that the git identity could not be
 * resolved and a sentinel author was used to stamp the note/mark. Wiring this
 * into the store (#11) and rendering the notes UI (#56) are out of scope here;
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

/** The fast-forward itself can move a large working tree, so it gets the longer limit. */
const FAST_FORWARD_TIMEOUT_MS = 60_000;
const REF_COMMAND_TIMEOUT_MS = 10_000;

function divergedError(branch: string): Error {
  return new Error(
    `Could not fast-forward '${branch}': your local branch has diverged from origin/${branch}. ` +
      `Resolve manually in the source repo, or disable 'Pull latest' in project settings.`,
  );
}

function refUpdateError(branch: string, stderr: string, fallback: string): Error {
  return new Error(
    `Could not fast-forward '${branch}': ${stderr.trim() || fallback}. ` +
      `Resolve manually in the source repo, or disable 'Pull latest' in project settings.`,
  );
}

/** Whether `ancestor` is reachable from `descendant`. Throws when git cannot tell. */
async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    repoPath,
    undefined,
    REF_COMMAND_TIMEOUT_MS,
  );
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(
    `Could not compare ${ancestor} with ${descendant}: ${result.stderr.trim() || `git merge-base exited ${result.code}`}.`,
  );
}

/**
 * Brings the local `branch` up to `origin/<branch>` for Pull latest, without
 * switching the branch the main checkout at `repoPath` has checked out. The
 * caller fetches `origin/<branch>` first.
 *
 * - Checked out in `repoPath`: `git merge --ff-only`, which also updates the
 *   working tree.
 * - Checked out in another worktree: throws. Moving the ref from here would
 *   leave that worktree's index and files behind its branch.
 * - Not checked out anywhere: the ref alone moves, by compare-and-swap so a
 *   concurrent change to it is not overwritten. A missing local branch is
 *   created to track origin, and one that is already ahead is left alone.
 *
 * Throws the diverged message when neither side contains the other.
 */
export async function fastForwardLocalBranch(repoPath: string, branch: string): Promise<void> {
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;

  const list = await runCommand(
    "git",
    ["worktree", "list", "--porcelain"],
    repoPath,
    undefined,
    REF_COMMAND_TIMEOUT_MS,
  );
  if (list.code !== 0) throw refUpdateError(branch, list.stderr, "git worktree list failed");
  const holder = parseWorktreeList(list.stdout).find((e) => e.branch === branch);

  if (holder) {
    if (canonicalPath(holder.path) !== canonicalPath(repoPath)) {
      throw new Error(
        `Could not fast-forward '${branch}': it is checked out in ${holder.path}. ` +
          `Update it there, or disable 'Pull latest' in project settings.`,
      );
    }
    const ff = await runCommand(
      "git",
      ["merge", "--ff-only", `origin/${branch}`],
      repoPath,
      undefined,
      FAST_FORWARD_TIMEOUT_MS,
    );
    if (ff.code !== 0) throw divergedError(branch);
    return;
  }

  const local = await runCommand(
    "git",
    ["rev-parse", "--verify", "--quiet", localRef],
    repoPath,
    undefined,
    REF_COMMAND_TIMEOUT_MS,
  );
  if (local.code !== 0) {
    const created = await runCommand(
      "git",
      ["branch", "--track", branch, `origin/${branch}`],
      repoPath,
      undefined,
      REF_COMMAND_TIMEOUT_MS,
    );
    if (created.code !== 0) throw refUpdateError(branch, created.stderr, "git branch failed");
    return;
  }

  const oldSha = local.stdout.trim();
  // Up to date, or ahead with commits origin does not have yet.
  if (await isAncestor(repoPath, remoteRef, oldSha)) return;
  if (!(await isAncestor(repoPath, oldSha, remoteRef))) throw divergedError(branch);

  const updated = await runCommand(
    "git",
    ["update-ref", "-m", `roubo: pull latest from origin/${branch}`, localRef, remoteRef, oldSha],
    repoPath,
    undefined,
    REF_COMMAND_TIMEOUT_MS,
  );
  if (updated.code !== 0) throw refUpdateError(branch, updated.stderr, "git update-ref failed");
}
