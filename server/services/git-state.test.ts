import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeBench } from "../test/fixtures.js";
import type { Bench, BenchWorkUnit } from "@roubo/shared";

vi.mock("./exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec.js")>()),
  runCommand: vi.fn(),
}));

// Imported after vi.mock so the mock is in place
const execModule = await import("./exec.js");
const { getDirtyState, buildKnownMergedLocations } = await import("./git-state.js");

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
  it("returns clean without running git for a blank-workspace-path bench (allowlist-rejected)", async () => {
    // A blank workspacePath would otherwise make execGit run with cwd="" (the server's
    // own repo). The guard must short-circuit before any runCommand call.
    const result = await getDirtyState(bench({ workspacePath: "" }));

    expect(result).toEqual({ clean: true, reasons: [] });
    expect(execModule.runCommand).not.toHaveBeenCalled();
  });

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

  describe("deleted upstream (merged PR with remote branch removed)", () => {
    const trackedConfigOk: GitResult = { code: 0, stdout: "refs/heads/main\n", stderr: "" };
    const upstreamGone: GitResult = {
      code: 128,
      stdout: "",
      stderr: "fatal: no upstream configured for branch 'main'",
    };
    const originHeadMain: GitResult = { code: 0, stdout: "origin/main\n", stderr: "" };

    it("returns clean when all local commits are patch-equivalent on the default branch (squash/rebase merged)", async () => {
      mockGit({
        ...cleanResponses(),
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: upstreamGone,
        [`config --get branch.main.merge@${WS}`]: trackedConfigOk,
        [`symbolic-ref --short refs/remotes/origin/HEAD@${WS}`]: originHeadMain,
        [`cherry origin/main HEAD@${WS}`]: { code: 0, stdout: "- abc\n- def\n", stderr: "" },
      });

      const result = await getDirtyState(bench());

      expect(result).toEqual({ clean: true, reasons: [] });
    });

    it("returns local-only-after-merge with plural count when some commits are not in default branch", async () => {
      mockGit({
        ...cleanResponses(),
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: upstreamGone,
        [`config --get branch.main.merge@${WS}`]: trackedConfigOk,
        [`symbolic-ref --short refs/remotes/origin/HEAD@${WS}`]: originHeadMain,
        [`cherry origin/main HEAD@${WS}`]: {
          code: 0,
          stdout: "- abc\n+ def\n+ ghi\n",
          stderr: "",
        },
      });

      const result = await getDirtyState(bench());

      expect(result.clean).toBe(false);
      expect(result.reasons).toEqual([
        {
          kind: "local-only-after-merge",
          location: "workspace",
          detail: "upstream deleted, 2 commits not in origin/main",
        },
      ]);
    });

    it("uses singular wording when exactly one local-only commit remains", async () => {
      mockGit({
        ...cleanResponses(),
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: upstreamGone,
        [`config --get branch.main.merge@${WS}`]: trackedConfigOk,
        [`symbolic-ref --short refs/remotes/origin/HEAD@${WS}`]: originHeadMain,
        [`cherry origin/main HEAD@${WS}`]: { code: 0, stdout: "+ abc\n", stderr: "" },
      });

      const result = await getDirtyState(bench());

      expect(result.reasons[0]).toMatchObject({
        kind: "local-only-after-merge",
        detail: "upstream deleted, 1 commit not in origin/main",
      });
    });

    it("falls back to origin/main when origin/HEAD is unset", async () => {
      mockGit({
        ...cleanResponses(),
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: upstreamGone,
        [`config --get branch.main.merge@${WS}`]: trackedConfigOk,
        [`symbolic-ref --short refs/remotes/origin/HEAD@${WS}`]: {
          code: 128,
          stdout: "",
          stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref",
        },
        [`show-ref --verify --quiet refs/remotes/origin/main@${WS}`]: {
          code: 0,
          stdout: "",
          stderr: "",
        },
        [`cherry origin/main HEAD@${WS}`]: { code: 0, stdout: "- abc\n", stderr: "" },
      });

      const result = await getDirtyState(bench());

      expect(result).toEqual({ clean: true, reasons: [] });
    });

    it("falls back to origin/master when origin/main also missing", async () => {
      mockGit({
        ...cleanResponses(),
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: upstreamGone,
        [`config --get branch.main.merge@${WS}`]: trackedConfigOk,
        [`symbolic-ref --short refs/remotes/origin/HEAD@${WS}`]: {
          code: 128,
          stdout: "",
          stderr: "fatal",
        },
        [`show-ref --verify --quiet refs/remotes/origin/main@${WS}`]: {
          code: 1,
          stdout: "",
          stderr: "",
        },
        [`show-ref --verify --quiet refs/remotes/origin/master@${WS}`]: {
          code: 0,
          stdout: "",
          stderr: "",
        },
        [`cherry origin/master HEAD@${WS}`]: { code: 0, stdout: "+ abc\n", stderr: "" },
      });

      const result = await getDirtyState(bench());

      expect(result.reasons[0]).toMatchObject({
        kind: "local-only-after-merge",
        detail: "upstream deleted, 1 commit not in origin/master",
      });
    });

    it("falls back to legacy no-upstream reason when no default branch can be resolved", async () => {
      mockGit({
        ...cleanResponses(),
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: upstreamGone,
        [`config --get branch.main.merge@${WS}`]: trackedConfigOk,
        [`symbolic-ref --short refs/remotes/origin/HEAD@${WS}`]: {
          code: 128,
          stdout: "",
          stderr: "fatal",
        },
        [`show-ref --verify --quiet refs/remotes/origin/main@${WS}`]: {
          code: 1,
          stdout: "",
          stderr: "",
        },
        [`show-ref --verify --quiet refs/remotes/origin/master@${WS}`]: {
          code: 1,
          stdout: "",
          stderr: "",
        },
      });

      const result = await getDirtyState(bench());

      expect(result.reasons).toEqual([
        { kind: "no-upstream", location: "workspace", detail: "no upstream configured" },
      ]);
    });

    it("fails safe to local-only-after-merge when git cherry errors", async () => {
      mockGit({
        ...cleanResponses(),
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: upstreamGone,
        [`config --get branch.main.merge@${WS}`]: trackedConfigOk,
        [`symbolic-ref --short refs/remotes/origin/HEAD@${WS}`]: originHeadMain,
        [`cherry origin/main HEAD@${WS}`]: {
          code: 128,
          stdout: "",
          stderr: "fatal: bad revision",
        },
      });

      const result = await getDirtyState(bench());

      expect(result.reasons).toEqual([
        {
          kind: "local-only-after-merge",
          location: "workspace",
          detail: "git error (exit 128)",
        },
      ]);
    });

    it("preserves legacy no-upstream behavior when branch was never tracked", async () => {
      // No `config --get branch.main.merge` mock: defaults to empty stdout,
      // which the implementation treats as "never tracked".
      mockGit({
        ...cleanResponses(),
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${WS}`]: upstreamGone,
        [`rev-list --count HEAD --not --remotes@${WS}`]: { code: 0, stdout: "2\n", stderr: "" },
      });

      const result = await getDirtyState(bench());

      expect(result.reasons).toEqual([
        {
          kind: "no-upstream",
          location: "workspace",
          detail: "no upstream configured (2 unpushed commits)",
        },
      ]);
    });
  });

  describe("knownMergedLocations option", () => {
    it("skips the unpushed check for matching locations but still runs worktree and stash checks", async () => {
      mockGit({
        ...cleanResponses(),
        [`status --porcelain@${WS}`]: { code: 0, stdout: " M edited.ts\n", stderr: "" },
      });

      const result = await getDirtyState(bench(), {
        knownMergedLocations: new Set(["workspace"]),
      });

      const calls = vi.mocked(execModule.runCommand).mock.calls;
      const argLists = calls.map((c) => c[1].join(" "));
      expect(argLists).toContain("status --porcelain");
      expect(argLists).toContain("stash list");
      expect(argLists).not.toContain("symbolic-ref -q HEAD");
      expect(argLists).not.toContain("rev-parse --abbrev-ref --symbolic-full-name @{upstream}");
      expect(argLists.some((a) => a.startsWith("cherry "))).toBe(false);

      // Worktree edits still surface even when merge is confirmed elsewhere.
      expect(result.reasons).toEqual([
        { kind: "dirty-worktree", location: "workspace", detail: "1 modified" },
      ]);
    });

    it("only suppresses the unpushed check for the named location, not siblings", async () => {
      const subCwd = `${WS}/vendor/lib`;
      mockGit({
        ...cleanResponses(),
        [`submodule foreach --recursive --quiet echo $displaypath@${WS}`]: {
          code: 0,
          stdout: "vendor/lib\n",
          stderr: "",
        },
        [`status --porcelain@${subCwd}`]: { code: 0, stdout: "", stderr: "" },
        [`stash list@${subCwd}`]: { code: 0, stdout: "", stderr: "" },
        [`symbolic-ref -q HEAD@${subCwd}`]: { code: 0, stdout: "refs/heads/main\n", stderr: "" },
        // Sibling submodule has a real unpushed commit; it must still surface.
        [`rev-parse --abbrev-ref --symbolic-full-name @{upstream}@${subCwd}`]: {
          code: 0,
          stdout: "origin/main\n",
          stderr: "",
        },
        [`rev-list --count @{upstream}..HEAD@${subCwd}`]: { code: 0, stdout: "1\n", stderr: "" },
      });

      const result = await getDirtyState(bench(), {
        knownMergedLocations: new Set(["workspace"]),
      });

      expect(result.reasons).toEqual([
        { kind: "unpushed-commits", location: "vendor/lib", detail: "1 commit ahead" },
      ]);
    });
  });

  describe("buildKnownMergedLocations", () => {
    function wu(submodule: string, merged: boolean | undefined): BenchWorkUnit {
      return {
        submodule,
        branch: "x",
        workspacePath: `${WS}/${submodule}`,
        pullRequest:
          merged === undefined
            ? undefined
            : {
                repoFullName: "org/repo",
                number: 1,
                title: "t",
                state: merged ? "closed" : "open",
                merged,
                url: "",
                updatedAt: "",
              },
      };
    }

    it("returns an empty set when bench has no work units", () => {
      expect(buildKnownMergedLocations(bench()).size).toBe(0);
    });

    it("includes only submodules whose PR is merged", () => {
      const b = bench({
        workUnits: [wu("a", true), wu("b", false), wu("c", undefined), wu("d", true)],
      });

      const set = buildKnownMergedLocations(b);

      expect([...set].sort()).toEqual(["a", "d"]);
    });

    it("maps the meta-root work unit (submodule '.') to the 'workspace' location key", () => {
      const root: BenchWorkUnit = {
        submodule: ".",
        branch: "main",
        workspacePath: WS,
        pullRequest: {
          repoFullName: "org/meta",
          number: 1,
          title: "t",
          state: "closed",
          merged: true,
          url: "",
          updatedAt: "",
        },
      };
      const set = buildKnownMergedLocations(bench({ workUnits: [root] }));
      expect([...set]).toEqual(["workspace"]);
    });

    it("uses the on-disk relative path (not the roubo.yaml key) when they differ", () => {
      const renamed: BenchWorkUnit = {
        submodule: "api",
        branch: "main",
        workspacePath: `${WS}/services/api`,
        pullRequest: {
          repoFullName: "org/api",
          number: 1,
          title: "t",
          state: "closed",
          merged: true,
          url: "",
          updatedAt: "",
        },
      };
      const set = buildKnownMergedLocations(bench({ workUnits: [renamed] }));
      expect([...set]).toEqual(["services/api"]);
    });
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
