import path from "node:path";
import type { Bench, DirtyReason, DirtyState } from "@roubo/shared";
import { runCommand } from "./exec.js";

function execGit(args: string[], cwd: string) {
  return runCommand("git", args, cwd);
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

async function checkUnpushed(location: string, cwd: string): Promise<DirtyReason | null> {
  // Exit code 1 = detached HEAD (expected — skip unpushed check).
  // Any other non-zero = real git error — fail safe to dirty.
  const symref = await execGit(["symbolic-ref", "-q", "HEAD"], cwd);
  if (symref.code === 1) return null;
  if (symref.code !== 0) {
    return { kind: "unpushed-commits", location, detail: `git error (exit ${symref.code})` };
  }

  const upstream = await execGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    cwd,
  );
  if (upstream.code !== 0) {
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
}: {
  location: string;
  cwd: string;
}): Promise<DirtyReason[]> {
  const [worktree, stash, unpushed] = await Promise.all([
    checkDirtyWorktree(location, cwd),
    checkStashes(location, cwd),
    checkUnpushed(location, cwd),
  ]);
  return [worktree, stash, unpushed].filter((r): r is DirtyReason => r !== null);
}

export async function getDirtyState(bench: Bench): Promise<DirtyState> {
  const submodules = await enumerateSubmodules(bench.workspacePath);
  const locations = [{ location: "workspace", cwd: bench.workspacePath }, ...submodules];
  const perLocation = await Promise.all(locations.map(checkLocation));
  const reasons = perLocation.flat();
  reasons.sort((a, b) => a.location.localeCompare(b.location) || a.kind.localeCompare(b.kind));
  return { clean: reasons.length === 0, reasons };
}
