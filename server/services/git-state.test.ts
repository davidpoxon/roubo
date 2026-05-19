import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeBench } from "../test/fixtures.js";
import type { Bench } from "@roubo/shared";

vi.mock("./exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec.js")>()),
  runCommand: vi.fn(),
}));

// Imported after vi.mock so the mock is in place
const execModule = await import("./exec.js");
const { getDirtyState } = await import("./git-state.js");

const WS = "/home/.roubo/workspaces/test-project/bench-1";

type GitResult = { code: number; stdout: string; stderr: string };

/**
 * Installs a runCommand mock that dispatches on `"args.join(' ')@cwd"`.
 * Falls back to `args.join(' ')` (no cwd), then to a clean default.
 */
function mockGit(responses: Record<string, GitResult>) {
  vi.mocked(execModule.runCommand).mockImplementation((_cmd, args, cwd) => {
    const fullKey = `${args.join(" ")}@${cwd}`;
    const shortKey = args.join(" ");
    return Promise.resolve(
      responses[fullKey] ?? responses[shortKey] ?? { code: 0, stdout: "", stderr: "" },
    );
  });
}

/** A clean response map that makes every location appear fully clean. */
function cleanResponses(cwd = WS): Record<string, GitResult> {
  return {
    [`submodule foreach --recursive --quiet echo $displaypath@${cwd}`]: {
      code: 0,
      stdout: "",
      stderr: "",
    },
    [`status --porcelain@${cwd}`]: { code: 0, stdout: "", stderr: "" },
    [`stash list@${cwd}`]: { code: 0, stdout: "", stderr: "" },
    [`symbolic-ref -q HEAD@${cwd}`]: { code: 0, stdout: "refs/heads/main\n", stderr: "" },
    [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${cwd}`]: {
      code: 0,
      stdout: "origin/main\n",
      stderr: "",
    },
    [`rev-list --count @{upstream}..HEAD@${cwd}`]: { code: 0, stdout: "0\n", stderr: "" },
  };
}

function bench(overrides?: Partial<Bench>): Bench {
  return makeBench(overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDirtyState", () => {
  it("returns clean when worktree is fully clean with no submodules", async () => {
    mockGit(cleanResponses());

    const result = await getDirtyState(bench());

    expect(result).toEqual({ clean: true, reasons: [] });
    // Every runCommand call should be for git
    for (const call of vi.mocked(execModule.runCommand).mock.calls) {
      expect(call[0]).toBe("git");
    }
  });

  it("returns dirty-worktree reason when main worktree has uncommitted changes and untracked files", async () => {
    mockGit({
      ...cleanResponses(),
      [`status --porcelain@${WS}`]: { code: 0, stdout: " M a.ts\n?? b.ts\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      { kind: "dirty-worktree", location: "workspace", detail: "1 modified, 1 untracked" },
    ]);
  });

  it("returns dirty-worktree reason for dirty submodule when main worktree is clean", async () => {
    const subCwd = `${WS}/vendor/lib`;
    mockGit({
      ...cleanResponses(),
      [`submodule foreach --recursive --quiet echo $displaypath@${WS}`]: {
        code: 0,
        stdout: "vendor/lib\n",
        stderr: "",
      },
      [`status --porcelain@${subCwd}`]: { code: 0, stdout: " M x.ts\n", stderr: "" },
      [`stash list@${subCwd}`]: { code: 0, stdout: "", stderr: "" },
      [`symbolic-ref -q HEAD@${subCwd}`]: { code: 0, stdout: "refs/heads/main\n", stderr: "" },
      [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${subCwd}`]: {
        code: 0,
        stdout: "origin/main\n",
        stderr: "",
      },
      [`rev-list --count @{upstream}..HEAD@${subCwd}`]: { code: 0, stdout: "0\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      { kind: "dirty-worktree", location: "vendor/lib", detail: "1 modified" },
    ]);
  });

  it("returns stash reason when a submodule has a stash", async () => {
    const subCwd = `${WS}/vendor/lib`;
    mockGit({
      ...cleanResponses(),
      [`submodule foreach --recursive --quiet echo $displaypath@${WS}`]: {
        code: 0,
        stdout: "vendor/lib\n",
        stderr: "",
      },
      [`status --porcelain@${subCwd}`]: { code: 0, stdout: "", stderr: "" },
      [`stash list@${subCwd}`]: {
        code: 0,
        stdout: "stash@{0}: WIP on main: abc1234 Some commit\n",
        stderr: "",
      },
      [`symbolic-ref -q HEAD@${subCwd}`]: { code: 0, stdout: "refs/heads/main\n", stderr: "" },
      [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${subCwd}`]: {
        code: 0,
        stdout: "origin/main\n",
        stderr: "",
      },
      [`rev-list --count @{upstream}..HEAD@${subCwd}`]: { code: 0, stdout: "0\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([{ kind: "stash", location: "vendor/lib", detail: "1 stash" }]);
  });

  it("returns clean when no upstream is configured but branch has no unique commits", async () => {
    mockGit({
      ...cleanResponses(),
      [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: no upstream configured for branch 'bench-1'",
      },
      [`rev-list --count HEAD --not --remotes@${WS}`]: { code: 0, stdout: "0\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result).toEqual({ clean: true, reasons: [] });
  });

  it("returns no-upstream reason when no upstream is configured and branch has unique commits", async () => {
    mockGit({
      ...cleanResponses(),
      [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: no upstream configured for branch 'bench-1'",
      },
      [`rev-list --count HEAD --not --remotes@${WS}`]: { code: 0, stdout: "3\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      {
        kind: "no-upstream",
        location: "workspace",
        detail: "no upstream configured (3 unpushed commits)",
      },
    ]);
  });

  it("handles singular commit count in no-upstream detail correctly", async () => {
    mockGit({
      ...cleanResponses(),
      [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: no upstream configured for branch 'bench-1'",
      },
      [`rev-list --count HEAD --not --remotes@${WS}`]: { code: 0, stdout: "1\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      {
        kind: "no-upstream",
        location: "workspace",
        detail: "no upstream configured (1 unpushed commit)",
      },
    ]);
  });

  it("returns no-upstream reason when rev-list fallback fails (fail-safe)", async () => {
    mockGit({
      ...cleanResponses(),
      [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: no upstream configured for branch 'bench-1'",
      },
      [`rev-list --count HEAD --not --remotes@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: bad revision",
      },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      { kind: "no-upstream", location: "workspace", detail: "no upstream configured" },
    ]);
  });

  it("returns unpushed-commits reason when commits are ahead of upstream", async () => {
    mockGit({
      ...cleanResponses(),
      [`rev-list --count @{upstream}..HEAD@${WS}`]: { code: 0, stdout: "2\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      { kind: "unpushed-commits", location: "workspace", detail: "2 commits ahead" },
    ]);
  });

  it("does not emit unpushed-commits reason when HEAD is detached", async () => {
    mockGit({
      ...cleanResponses(),
      [`symbolic-ref -q HEAD@${WS}`]: { code: 1, stdout: "", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result).toEqual({ clean: true, reasons: [] });
  });

  it("treats non-zero symbolic-ref exit (non-detached) as dirty to fail safe", async () => {
    mockGit({
      ...cleanResponses(),
      [`symbolic-ref -q HEAD@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      { kind: "unpushed-commits", location: "workspace", detail: "git error (exit 128)" },
    ]);
  });

  it("handles singular stash count correctly", async () => {
    mockGit({
      ...cleanResponses(),
      [`stash list@${WS}`]: {
        code: 0,
        stdout: "stash@{0}: WIP on main: abc1234 Some commit\n",
        stderr: "",
      },
    });

    const result = await getDirtyState(bench());

    expect(result.reasons[0]).toMatchObject({ kind: "stash", detail: "1 stash" });
  });

  it("handles singular commit count correctly", async () => {
    mockGit({
      ...cleanResponses(),
      [`rev-list --count @{upstream}..HEAD@${WS}`]: { code: 0, stdout: "1\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.reasons[0]).toMatchObject({ kind: "unpushed-commits", detail: "1 commit ahead" });
  });

  it("returns multiple reasons when multiple checks fail", async () => {
    mockGit({
      ...cleanResponses(),
      [`status --porcelain@${WS}`]: { code: 0, stdout: " M a.ts\n", stderr: "" },
      [`stash list@${WS}`]: { code: 0, stdout: "stash@{0}: WIP\n", stderr: "" },
      [`rev-list --count @{upstream}..HEAD@${WS}`]: { code: 0, stdout: "3\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toHaveLength(3);
    const kinds = result.reasons.map((r) => r.kind).sort();
    expect(kinds).toEqual(["dirty-worktree", "stash", "unpushed-commits"]);
  });

  it("treats non-zero submodule foreach exit as no submodules", async () => {
    mockGit({
      ...cleanResponses(),
      [`submodule foreach --recursive --quiet echo $displaypath@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      },
    });

    const result = await getDirtyState(bench());

    expect(result).toEqual({ clean: true, reasons: [] });
  });

  it("treats non-zero git status exit as dirty to fail safe", async () => {
    mockGit({
      ...cleanResponses(),
      [`status --porcelain@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      { kind: "dirty-worktree", location: "workspace", detail: "git error (exit 128)" },
    ]);
  });

  it("treats non-zero git stash list exit as dirty to fail safe", async () => {
    mockGit({
      ...cleanResponses(),
      [`stash list@${WS}`]: { code: 128, stdout: "", stderr: "fatal: not a git repository" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      { kind: "stash", location: "workspace", detail: "git error (exit 128)" },
    ]);
  });

  it("treats non-zero rev-list exit as dirty to fail safe", async () => {
    mockGit({
      ...cleanResponses(),
      [`rev-list --count @{upstream}..HEAD@${WS}`]: {
        code: 128,
        stdout: "",
        stderr: "fatal: bad revision",
      },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      { kind: "unpushed-commits", location: "workspace", detail: "git error (exit 128)" },
    ]);
  });

  it("aggregates reasons across multiple submodules", async () => {
    const sub1Cwd = `${WS}/vendor/alpha`;
    const sub2Cwd = `${WS}/vendor/beta`;
    mockGit({
      ...cleanResponses(),
      [`submodule foreach --recursive --quiet echo $displaypath@${WS}`]: {
        code: 0,
        stdout: "vendor/alpha\nvendor/beta\n",
        stderr: "",
      },
      // sub1: dirty worktree
      [`status --porcelain@${sub1Cwd}`]: { code: 0, stdout: " M x.ts\n", stderr: "" },
      [`stash list@${sub1Cwd}`]: { code: 0, stdout: "", stderr: "" },
      [`symbolic-ref -q HEAD@${sub1Cwd}`]: { code: 0, stdout: "refs/heads/main\n", stderr: "" },
      [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${sub1Cwd}`]: {
        code: 0,
        stdout: "origin/main\n",
        stderr: "",
      },
      [`rev-list --count @{upstream}..HEAD@${sub1Cwd}`]: { code: 0, stdout: "0\n", stderr: "" },
      // sub2: stash present
      [`status --porcelain@${sub2Cwd}`]: { code: 0, stdout: "", stderr: "" },
      [`stash list@${sub2Cwd}`]: {
        code: 0,
        stdout: "stash@{0}: WIP on main: abc1234 msg\n",
        stderr: "",
      },
      [`symbolic-ref -q HEAD@${sub2Cwd}`]: { code: 0, stdout: "refs/heads/main\n", stderr: "" },
      [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${sub2Cwd}`]: {
        code: 0,
        stdout: "origin/main\n",
        stderr: "",
      },
      [`rev-list --count @{upstream}..HEAD@${sub2Cwd}`]: { code: 0, stdout: "0\n", stderr: "" },
    });

    const result = await getDirtyState(bench());

    expect(result.clean).toBe(false);
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons).toEqual([
      { kind: "dirty-worktree", location: "vendor/alpha", detail: "1 modified" },
      { kind: "stash", location: "vendor/beta", detail: "1 stash" },
    ]);
  });
});
