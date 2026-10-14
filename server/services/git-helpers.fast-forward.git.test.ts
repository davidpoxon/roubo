// Pull latest against real git: the defect is that the fast-forward merged into
// whatever branch the main checkout had checked out, not the branch it named.
// Only a real repository shows which ref, HEAD, and working tree actually move.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fastForwardLocalBranch } from "./git-helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const DIVERGED =
  "Could not fast-forward 'main': your local branch has diverged from origin/main. " +
  "Resolve manually in the source repo, or disable 'Pull latest' in project settings.";

let tmp: string;
let upstream: string;
let repo: string;

/** Pushes one new commit to origin/main from a separate clone, then fetches it into `repo`. */
function advanceOrigin(): string {
  git(upstream, "commit", "-q", "--allow-empty", "-m", "upstream");
  git(upstream, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin", "main");
  return git(repo, "rev-parse", "origin/main");
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-ff-")));
  const origin = path.join(tmp, "origin.git");
  upstream = path.join(tmp, "upstream");
  repo = path.join(tmp, "repo");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "clone", "-q", origin, upstream);
  git(upstream, "commit", "-q", "--allow-empty", "-m", "init");
  git(upstream, "push", "-q", "origin", "main");
  git(tmp, "clone", "-q", origin, repo);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("fastForwardLocalBranch", () => {
  it("moves local main while the main checkout stays on a dirty feature branch", async () => {
    git(repo, "switch", "-q", "-c", "feature");
    git(repo, "commit", "-q", "--allow-empty", "-m", "feature work");
    fs.writeFileSync(path.join(repo, "uncommitted.txt"), "work in progress");
    const featureBefore = git(repo, "rev-parse", "feature");
    const target = advanceOrigin();

    await fastForwardLocalBranch(repo, "main");

    expect(git(repo, "rev-parse", "main")).toBe(target);
    expect(git(repo, "branch", "--show-current")).toBe("feature");
    expect(git(repo, "rev-parse", "feature")).toBe(featureBefore);
    expect(fs.readFileSync(path.join(repo, "uncommitted.txt"), "utf8")).toBe("work in progress");
  });

  it("leaves a feature branch that is behind origin/main where it was", async () => {
    git(repo, "switch", "-q", "-c", "feature");
    const featureBefore = git(repo, "rev-parse", "feature");
    const target = advanceOrigin();

    await fastForwardLocalBranch(repo, "main");

    expect(git(repo, "rev-parse", "feature")).toBe(featureBefore);
    expect(git(repo, "rev-parse", "main")).toBe(target);
  });

  it("fast-forwards the checked-out branch and its working tree when the main checkout is on it", async () => {
    const target = advanceOrigin();

    await fastForwardLocalBranch(repo, "main");

    expect(git(repo, "rev-parse", "HEAD")).toBe(target);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("recognises the main checkout through a symlinked repo path", async () => {
    const link = path.join(tmp, "link");
    fs.symlinkSync(repo, link);
    const target = advanceOrigin();

    await fastForwardLocalBranch(link, "main");

    expect(git(repo, "rev-parse", "HEAD")).toBe(target);
  });

  it("recognises the main checkout when the project is a subdirectory of the repository", async () => {
    const sub = path.join(repo, "app");
    fs.mkdirSync(sub);
    const target = advanceOrigin();

    await fastForwardLocalBranch(sub, "main");

    expect(git(repo, "rev-parse", "HEAD")).toBe(target);
  });

  it("creates the local branch from origin when it does not exist", async () => {
    git(repo, "switch", "-q", "-c", "feature");
    git(repo, "branch", "-q", "-D", "main");
    const target = advanceOrigin();

    await fastForwardLocalBranch(repo, "main");

    expect(git(repo, "rev-parse", "main")).toBe(target);
    expect(git(repo, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
  });

  it("is a no-op when local main is ahead of origin/main", async () => {
    git(repo, "switch", "-q", "-c", "feature");
    git(repo, "branch", "-q", "-f", "main", "origin/main");
    const ahead = git(repo, "commit-tree", "-p", "main", "-m", "local", "main^{tree}");
    git(repo, "update-ref", "refs/heads/main", ahead);

    await fastForwardLocalBranch(repo, "main");

    expect(git(repo, "rev-parse", "main")).toBe(ahead);
  });

  it("throws the diverged error and leaves main alone when it has diverged", async () => {
    git(repo, "switch", "-q", "-c", "feature");
    const local = git(repo, "commit-tree", "-p", "main", "-m", "local", "main^{tree}");
    git(repo, "update-ref", "refs/heads/main", local);
    advanceOrigin();

    await expect(fastForwardLocalBranch(repo, "main")).rejects.toThrow(DIVERGED);
    expect(git(repo, "rev-parse", "main")).toBe(local);
  });

  it("throws the diverged error when the checked-out branch cannot fast-forward", async () => {
    git(repo, "commit", "-q", "--allow-empty", "-m", "local");
    const local = git(repo, "rev-parse", "main");
    advanceOrigin();

    await expect(fastForwardLocalBranch(repo, "main")).rejects.toThrow(DIVERGED);
    expect(git(repo, "rev-parse", "main")).toBe(local);
  });

  it("refuses to move a branch that is checked out in another worktree", async () => {
    git(repo, "switch", "-q", "-c", "feature");
    const other = path.join(tmp, "other");
    git(repo, "worktree", "add", "-q", other, "main");
    const before = git(repo, "rev-parse", "main");
    advanceOrigin();

    await expect(fastForwardLocalBranch(repo, "main")).rejects.toThrow(
      `Could not fast-forward 'main': it is checked out in ${other}.`,
    );
    expect(git(repo, "rev-parse", "main")).toBe(before);
  });
});
