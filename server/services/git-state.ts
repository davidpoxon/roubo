import path from "node:path";
import type { Bench, BenchWorkUnit, DirtyReason, DirtyState } from "@roubo/shared";
import { runCommand } from "./exec.js";
import { isBenchOperable } from "./bench-operability.js";

export interface DirtyStateOptions {
  /**
   * Locations (workspace or submodule `$displaypath`) whose branch is
   * known-merged via an external signal (e.g. a tracked PR with `merged: true`).
   * For these locations we skip the unpushed/no-upstream checks entirely. The
   * worktree and stash checks still run, since post-merge edits or stashes are
   * still real reasons to warn the user.
   */
  knownMergedLocations?: Set<string>;
}

function execGit(args: string[], cwd: string) {
  return runCommand("git", args, cwd);
}

/**
 * Builds the per-location merge hint set for a bench from its work units.
 * A work unit is treated as known-merged when its tracked PR is merged.
 *
 * The returned keys must match the `location` strings used by `getDirtyState`:
 * `"workspace"` for the meta-repo root, and the submodule's on-disk
 * `$displaypath` (forward-slash relative path) for each submodule. The
 * `wu.submodule` field is the roubo.yaml LayoutConfig key, which may differ
 * from the displaypath, so we derive the location from `workspacePath` instead.
 */
export function buildKnownMergedLocations(bench: Bench): Set<string> {
  const set = new Set<string>();
  for (const wu of bench.workUnits ?? ([] as BenchWorkUnit[])) {
    if (wu.pullRequest?.merged !== true) continue;
    if (wu.submodule === ".") {
      set.add("workspace");
      continue;
    }
    const rel = path.relative(bench.workspacePath, wu.workspacePath).split(path.sep).join("/");
    if (rel) set.add(rel);
  }
  return set;
}

async function enumerateSubmodules(
  workspacePath: string,
): Promise<{ location: string; cwd: string }[]> {
  const result = await execGit(
    ["submodule", "foreach", "--recursive", "--quiet", "echo $displaypath"],
    workspacePath,
  );
  // Non-zero exit is treated as no submodules. `git submodule foreach` exits 0
  // on repos with no submodules, so a non-zero result indicates a real git error.
  // We prefer skipping submodule checks over blocking teardown in that case —
  // unlike the worktree/stash/rev-list checks which fail-safe to dirty.
  if (result.code !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((displaypath) => ({
      location: displaypath,
      cwd: path.join(workspacePath, displaypath),
    }));
}

async function checkDirtyWorktree(location: string, cwd: string): Promise<DirtyReason | null> {
  const result = await execGit(["status", "--porcelain"], cwd);
  if (result.code !== 0) {
    return { kind: "dirty-worktree", location, detail: `git error (exit ${result.code})` };
  }
  if (!result.stdout.trim()) return null;
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith("??")).length;
  const modified = lines.length - untracked;
  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} modified`);
  if (untracked > 0) parts.push(`${untracked} untracked`);
  return { kind: "dirty-worktree", location, detail: parts.join(", ") };
}

async function checkStashes(location: string, cwd: string): Promise<DirtyReason | null> {
  const result = await execGit(["stash", "list"], cwd);
  if (result.code !== 0) {
    return { kind: "stash", location, detail: `git error (exit ${result.code})` };
  }
  if (!result.stdout.trim()) return null;
  const count = result.stdout.trim().split("\n").filter(Boolean).length;
  return { kind: "stash", location, detail: `${count} ${count === 1 ? "stash" : "stashes"}` };
}

/**
 * Resolves the default branch's remote-tracking ref (e.g. `origin/main`).
 * Tries `origin/HEAD` first; falls back to probing `origin/main` then
 * `origin/master`. Returns null when none is available (offline mirror, weird
 * remote layout). Callers should treat null as "give up and use the legacy
 * no-upstream path".
 */
async function resolveDefaultBranch(cwd: string): Promise<string | null> {
  const head = await execGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const candidate of ["origin/main", "origin/master"]) {
    const probe = await execGit(
      ["show-ref", "--verify", "--quiet", `refs/remotes/${candidate}`],
      cwd,
    );
    if (probe.code === 0) return candidate;
  }
  return null;
}

/**
 * Handles the "branch was tracking an upstream that no longer exists on the
 * remote" case (typical after a PR is merged and the remote branch is
 * auto-deleted). Uses `git cherry` against the default branch to detect
 * patch-equivalent commits (handles squash, rebase, and fast-forward merges)
 * and only flags commits that have no equivalent on the default branch.
 */
async function classifyDeletedUpstream(location: string, cwd: string): Promise<DirtyReason | null> {
  const defaultBranch = await resolveDefaultBranch(cwd);
  if (!defaultBranch) {
    return { kind: "no-upstream", location, detail: "no upstream configured" };
  }
  const cherry = await execGit(["cherry", defaultBranch, "HEAD"], cwd);
  if (cherry.code !== 0) {
    return {
      kind: "local-only-after-merge",
      location,
      detail: `git error (exit ${cherry.code})`,
    };
  }
  const lines = cherry.stdout.split("\n").filter((l) => l.trim().length > 0);
  const localOnly = lines.filter((l) => l.startsWith("+")).length;
  if (localOnly === 0) return null;
  return {
    kind: "local-only-after-merge",
    location,
    detail: `upstream deleted, ${localOnly} ${localOnly === 1 ? "commit" : "commits"} not in ${defaultBranch}`,
  };
}

async function checkUnpushed(location: string, cwd: string): Promise<DirtyReason | null> {
  // Exit code 1 = detached HEAD (expected — skip unpushed check).
  // Any other non-zero = real git error — fail safe to dirty.
  const symref = await execGit(["symbolic-ref", "-q", "HEAD"], cwd);
  if (symref.code === 1) return null;
  if (symref.code !== 0) {
    return { kind: "unpushed-commits", location, detail: `git error (exit ${symref.code})` };
  }
  const branchName = symref.stdout.trim().replace(/^refs\/heads\//, "");

  const upstream = await execGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    cwd,
  );
  if (upstream.code !== 0) {
    // `@{upstream}` failed: either the branch never had upstream tracking, or
    // it had tracking that has since been deleted from the remote (typical
    // after a merged PR with auto-delete enabled). The two cases need
    // different treatment, and git's per-branch config is the source of truth.
    const trackingConfig = branchName
      ? await execGit(["config", "--get", `branch.${branchName}.merge`], cwd)
      : { code: 1, stdout: "", stderr: "" };
    const wasTracked =
      branchName.length > 0 && trackingConfig.code === 0 && trackingConfig.stdout.trim().length > 0;

    if (wasTracked) {
      return await classifyDeletedUpstream(location, cwd);
    }

    // No upstream tracking configured. This is expected for freshly created bench
    // branches that were never pushed. Check if HEAD has any commits that don't
    // exist on any remote branch — if not, the branch is effectively clean and
    // safe to tear down (nothing would be lost).
    const unique = await execGit(["rev-list", "--count", "HEAD", "--not", "--remotes"], cwd);
    if (unique.code !== 0) {
      return { kind: "no-upstream", location, detail: "no upstream configured" };
    }
    const uniqueCount = parseInt(unique.stdout.trim(), 10);
    if (isNaN(uniqueCount) || uniqueCount === 0) return null;
    return {
      kind: "no-upstream",
      location,
      detail: `no upstream configured (${uniqueCount} unpushed ${uniqueCount === 1 ? "commit" : "commits"})`,
    };
  }

  const ahead = await execGit(["rev-list", "--count", "@{upstream}..HEAD"], cwd);
  if (ahead.code !== 0) {
    return { kind: "unpushed-commits", location, detail: `git error (exit ${ahead.code})` };
  }
  const count = parseInt(ahead.stdout.trim(), 10);
  if (isNaN(count) || count === 0) return null;
  return {
    kind: "unpushed-commits",
    location,
    detail: `${count} ${count === 1 ? "commit" : "commits"} ahead`,
  };
}

async function checkLocation({
  location,
  cwd,
  skipUnpushed,
}: {
  location: string;
  cwd: string;
  skipUnpushed: boolean;
}): Promise<DirtyReason[]> {
  const checks: Promise<DirtyReason | null>[] = [
    checkDirtyWorktree(location, cwd),
    checkStashes(location, cwd),
  ];
  if (!skipUnpushed) checks.push(checkUnpushed(location, cwd));
  const results = await Promise.all(checks);
  return results.filter((r): r is DirtyReason => r !== null);
}

export async function getDirtyState(
  bench: Bench,
  options?: DirtyStateOptions,
): Promise<DirtyState> {
  // A non-operable bench (blank workspacePath, see bench-operability.ts) was never
  // provisioned, so it has no worktree to probe and no uncommitted work to protect.
  // Treat it as clean here — the single chokepoint for every caller (the DELETE route,
  // auto-clear) — so none of them runs git with cwd="" (the server's own repo) via
  // enumerateSubmodules/checkLocation.
  if (!isBenchOperable(bench)) {
    return { clean: true, reasons: [] };
  }

  const knownMerged = options?.knownMergedLocations ?? new Set<string>();
  const submodules = await enumerateSubmodules(bench.workspacePath);
  const locations = [{ location: "workspace", cwd: bench.workspacePath }, ...submodules];
  const perLocation = await Promise.all(
    locations.map(({ location, cwd }) =>
      checkLocation({ location, cwd, skipUnpushed: knownMerged.has(location) }),
    ),
  );
  const reasons = perLocation.flat();
  reasons.sort((a, b) => a.location.localeCompare(b.location) || a.kind.localeCompare(b.kind));
  return { clean: reasons.length === 0, reasons };
}
