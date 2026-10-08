import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalPath,
  findAdminDir,
  findWorktreeEntry,
  listAdminDirs,
  parseWorktreeList,
} from "./worktree-registry.js";

// Real git and a real filesystem: the defect (#1433) is the gap between the path
// Roubo stores and the path git records, which only a real symlink shows.
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("worktree-registry", () => {
  let root: string;
  let realRoot: string;
  let repo: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "roubo-wt-"));
    realRoot = fs.realpathSync(root);
    repo = path.join(realRoot, "repo");
    fs.mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
    git(
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"],
      repo,
    );
  });

  afterEach(() => {
    fs.rmSync(realRoot, { recursive: true, force: true });
  });

  it("matches a worktree added through a symlinked parent to git's recorded path", () => {
    fs.mkdirSync(path.join(realRoot, "real"));
    fs.symlinkSync(path.join(realRoot, "real"), path.join(realRoot, "link"));
    const workspacePath = path.join(realRoot, "link", "bench-1");
    git(["worktree", "add", "-q", workspacePath, "-b", "bench-1"], repo);

    const entries = parseWorktreeList(git(["worktree", "list", "--porcelain"], repo));

    // Git records the real path, so an exact string match misses the bench.
    expect(entries.map((e) => e.path)).not.toContain(workspacePath);
    const entry = findWorktreeEntry(entries, workspacePath);
    expect(entry?.path).toBe(path.join(realRoot, "real", "bench-1"));
    expect(entry?.prunable).toBe(false);
  });

  it("still matches through the symlink after the workspace directory is gone", () => {
    fs.mkdirSync(path.join(realRoot, "real"));
    fs.symlinkSync(path.join(realRoot, "real"), path.join(realRoot, "link"));
    const workspacePath = path.join(realRoot, "link", "bench-1");
    git(["worktree", "add", "-q", workspacePath, "-b", "bench-1"], repo);
    fs.rmSync(workspacePath, { recursive: true, force: true });

    const entries = parseWorktreeList(git(["worktree", "list", "--porcelain"], repo));
    const entry = findWorktreeEntry(entries, workspacePath);

    expect(entry?.path).toBe(path.join(realRoot, "real", "bench-1"));
    expect(entry?.prunable).toBe(true);
  });

  it("does not match a sibling whose path shares a prefix", () => {
    const entries = parseWorktreeList(
      `worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n\n` +
        `worktree ${path.join(realRoot, "bench-10")}\nHEAD abc\nbranch refs/heads/bench-10\n`,
    );

    expect(findWorktreeEntry(entries, path.join(realRoot, "bench-1"))).toBeUndefined();
  });

  it("canonicalPath resolves a missing leaf against its real parent", () => {
    fs.mkdirSync(path.join(realRoot, "real"));
    fs.symlinkSync(path.join(realRoot, "real"), path.join(realRoot, "link"));

    expect(canonicalPath(path.join(realRoot, "link", "missing"))).toBe(
      path.join(realRoot, "real", "missing"),
    );
  });

  it("finds the admin dir from the worktree's .git file, and by scan once the directory is gone", () => {
    const workspacePath = path.join(realRoot, "bench-1");
    git(["worktree", "add", "-q", workspacePath, "-b", "bench-1"], repo);
    const adminDir = path.join(repo, ".git", "worktrees", "bench-1");

    expect(findAdminDir(path.join(repo, ".git"), workspacePath)).toBe(adminDir);
    fs.rmSync(workspacePath, { recursive: true, force: true });
    expect(findAdminDir(path.join(repo, ".git"), workspacePath)).toBe(adminDir);
  });

  it("never returns another worktree's admin dir that a .git file names", () => {
    const benchPath = path.join(realRoot, "bench-1");
    const userPath = path.join(realRoot, "user-wt");
    git(["worktree", "add", "-q", benchPath, "-b", "bench-1"], repo);
    git(["worktree", "add", "-q", userPath, "-b", "user-wt"], repo);
    // The bench's .git file now names the user's admin dir, so git refuses
    // `remove --force --force` ("does not point back").
    fs.copyFileSync(path.join(userPath, ".git"), path.join(benchPath, ".git"));

    expect(findAdminDir(path.join(repo, ".git"), benchPath)).toBe(
      path.join(repo, ".git", "worktrees", "bench-1"),
    );
  });

  it("ignores a .git file that points outside the worktrees dir", () => {
    const workspacePath = path.join(realRoot, "forged");
    fs.mkdirSync(workspacePath);
    fs.writeFileSync(path.join(workspacePath, ".git"), `gitdir: ${path.join(repo, ".git")}\n`);

    expect(findAdminDir(path.join(repo, ".git"), workspacePath)).toBeUndefined();
  });

  it("lists an admin dir whose gitdir file is missing, which git worktree list omits", () => {
    const workspacePath = path.join(realRoot, "bench-2");
    git(["worktree", "add", "-q", workspacePath, "-b", "bench-2"], repo);
    const adminDir = path.join(repo, ".git", "worktrees", "bench-2");
    fs.rmSync(path.join(adminDir, "gitdir"));

    expect(git(["worktree", "list", "--porcelain"], repo)).not.toContain("bench-2");
    expect(listAdminDirs(path.join(repo, ".git"))).toEqual([{ dir: adminDir }]);
  });
});
