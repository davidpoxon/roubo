import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec.js")>()),
  runCommand: vi.fn(),
}));

const execModule = await import("./exec.js");
const {
  resolveDefaultBranch,
  resolveHeadBranch,
  DefaultBranchResolutionError,
  DEFAULT_BRANCH_RESOLUTION_ERROR,
  parseGitmodulesWithBranch,
  resolveSubmoduleBranch,
  resolveRepoFullName,
  clearRepoFullNameCache,
  probeHeadBranch,
  probeDirtyCounts,
  probeUnpushedCount,
  probeWorkUnitState,
} = await import("./git-helpers.js");

const REPO = "/home/user/my-project";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveDefaultBranch", () => {
  it("resolves main", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "refs/remotes/origin/main\n",
      stderr: "",
    });

    const result = await resolveDefaultBranch(REPO);

    expect(result).toBe("main");
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      REPO,
      undefined,
      5_000,
    );
  });

  it("resolves develop", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "refs/remotes/origin/develop\n",
      stderr: "",
    });

    const result = await resolveDefaultBranch(REPO);

    expect(result).toBe("develop");
  });

  it("throws DefaultBranchResolutionError with the verbatim R1 message on non-zero exit", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 128,
      stdout: "",
      stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref",
    });

    const rejection = resolveDefaultBranch(REPO);
    await expect(rejection).rejects.toThrow(DefaultBranchResolutionError);
    await expect(rejection).rejects.toThrow(DEFAULT_BRANCH_RESOLUTION_ERROR);
  });

  it("throws DefaultBranchResolutionError when stdout does not start with refs/remotes/origin/", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "refs/heads/main\n",
      stderr: "",
    });

    await expect(resolveDefaultBranch(REPO)).rejects.toThrow(DefaultBranchResolutionError);
  });

  it("throws DefaultBranchResolutionError when branch name is empty after stripping prefix", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "refs/remotes/origin/\n",
      stderr: "",
    });

    await expect(resolveDefaultBranch(REPO)).rejects.toThrow(DefaultBranchResolutionError);
  });
});

describe("parseGitmodulesWithBranch", () => {
  it("parses a single submodule with path and branch", () => {
    const content = `[submodule "api"]
\tpath = services/api
\tbranch = main
`;
    const result = parseGitmodulesWithBranch(content);
    expect(result).toEqual({ api: { path: "services/api", branch: "main" } });
  });

  it("parses a submodule with path but no branch field", () => {
    const content = `[submodule "web"]
\tpath = clients/web
\turl = https://github.com/org/web
`;
    const result = parseGitmodulesWithBranch(content);
    expect(result).toEqual({ web: { path: "clients/web", branch: undefined } });
  });

  it("parses multiple submodules", () => {
    const content = `[submodule "api"]
\tpath = services/api
\tbranch = develop
[submodule "web"]
\tpath = clients/web
`;
    const result = parseGitmodulesWithBranch(content);
    expect(result).toEqual({
      api: { path: "services/api", branch: "develop" },
      web: { path: "clients/web", branch: undefined },
    });
  });

  it("returns empty object for empty content", () => {
    expect(parseGitmodulesWithBranch("")).toEqual({});
  });

  it("ignores lines before any section header", () => {
    const content = `path = orphan
[submodule "api"]
\tpath = services/api
`;
    const result = parseGitmodulesWithBranch(content);
    expect(result).toEqual({ api: { path: "services/api", branch: undefined } });
  });
});

describe("resolveSubmoduleBranch", () => {
  const SUB_PATH = "/workspace/bench-1/services/api";

  it("returns HEAD branch when symbolic-ref succeeds", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "feature/my-branch\n",
      stderr: "",
    });

    const result = await resolveSubmoduleBranch(SUB_PATH, "main");

    expect(result).toBe("feature/my-branch");
  });

  it("falls back to gitmodulesBranch when HEAD is detached", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "fatal: ref HEAD is not a symbolic ref",
    });

    const result = await resolveSubmoduleBranch(SUB_PATH, "develop");

    expect(result).toBe("develop");
  });

  it("falls back to resolveDefaultBranch when HEAD detached and no gitmodulesBranch", async () => {
    vi.mocked(execModule.runCommand)
      // First call: symbolic-ref HEAD (fails — detached)
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "fatal: not a symbolic ref" })
      // Second call: symbolic-ref refs/remotes/origin/HEAD (succeeds)
      .mockResolvedValueOnce({ code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" });

    const result = await resolveSubmoduleBranch(SUB_PATH, undefined);

    expect(result).toBe("main");
  });

  it('returns "unknown" when all three methods fail', async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });

    const result = await resolveSubmoduleBranch(SUB_PATH, undefined);

    expect(result).toBe("unknown");
  });

  it("prefers HEAD branch over gitmodulesBranch even when both available", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "feature/override\n",
      stderr: "",
    });

    const result = await resolveSubmoduleBranch(SUB_PATH, "main");

    expect(result).toBe("feature/override");
  });
});

describe("resolveRepoFullName", () => {
  const WORKSPACE = "/workspace/bench-1/services/api";

  beforeEach(() => {
    clearRepoFullNameCache();
  });

  it("parses an SSH remote URL into owner/repo", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "git@github.com:acme/api.git\n",
      stderr: "",
    });

    const result = await resolveRepoFullName(WORKSPACE);

    expect(result).toBe("acme/api");
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["remote", "get-url", "origin"],
      WORKSPACE,
      undefined,
      5_000,
    );
  });

  it("parses an HTTPS remote URL into owner/repo", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "https://github.com/acme/web.git\n",
      stderr: "",
    });

    const result = await resolveRepoFullName(WORKSPACE);

    expect(result).toBe("acme/web");
  });

  it("returns null when the git command fails", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });

    const result = await resolveRepoFullName(WORKSPACE);

    expect(result).toBeNull();
  });

  it("returns null when stdout is empty", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const result = await resolveRepoFullName(WORKSPACE);

    expect(result).toBeNull();
  });

  it("caches the result and does not call runCommand again", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "git@github.com:acme/api.git\n",
      stderr: "",
    });

    const first = await resolveRepoFullName(WORKSPACE);
    const second = await resolveRepoFullName(WORKSPACE);

    expect(first).toBe("acme/api");
    expect(second).toBe("acme/api");
    expect(execModule.runCommand).toHaveBeenCalledTimes(1);
  });

  it("parses a port-qualified SSH remote URL into owner/repo", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "git@ssh.github.com:443/acme/api.git\n",
      stderr: "",
    });

    const result = await resolveRepoFullName(WORKSPACE);

    expect(result).toBe("acme/api");
  });

  it("clearRepoFullNameCache resets the cache so the next call re-runs git", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "git@github.com:acme/api.git\n",
      stderr: "",
    });

    await resolveRepoFullName(WORKSPACE);
    clearRepoFullNameCache();
    await resolveRepoFullName(WORKSPACE);

    expect(execModule.runCommand).toHaveBeenCalledTimes(2);
  });
});

describe("resolveHeadBranch", () => {
  it("resolves the current branch", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "my-branch\n",
      stderr: "",
    });

    const result = await resolveHeadBranch(REPO);

    expect(result).toBe("my-branch");
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      REPO,
      undefined,
      5_000,
    );
  });

  it("throws when in detached HEAD state", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "fatal: ref HEAD is not a symbolic ref",
    });

    await expect(resolveHeadBranch(REPO)).rejects.toThrow("detached HEAD");
  });
});

describe("probeHeadBranch", () => {
  it("returns the branch name when HEAD is on a branch", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "feat/my-feature\n",
      stderr: "",
    });
    const result = await probeHeadBranch(REPO);
    expect(result).toBe("feat/my-feature");
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      REPO,
      undefined,
      5_000,
    );
  });

  it("returns null for detached HEAD (non-zero exit)", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "fatal: ref HEAD is not a symbolic ref",
    });
    const result = await probeHeadBranch(REPO);
    expect(result).toBeNull();
  });

  it("returns null when stdout is empty", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "\n", stderr: "" });
    const result = await probeHeadBranch(REPO);
    expect(result).toBeNull();
  });

  it("returns null on git error", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });
    const result = await probeHeadBranch(REPO);
    expect(result).toBeNull();
  });
});

describe("probeDirtyCounts", () => {
  it("returns zeroes when working tree is clean", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const result = await probeDirtyCounts(REPO);
    expect(result).toEqual({ modifiedCount: 0, untrackedCount: 0 });
  });

  it("counts modified and untracked files separately", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: " M src/foo.ts\n M src/bar.ts\n?? src/new.ts\n?? src/another.ts\n",
      stderr: "",
    });
    const result = await probeDirtyCounts(REPO);
    expect(result).toEqual({ modifiedCount: 2, untrackedCount: 2 });
  });

  it("counts only modified when no untracked files", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: " M src/foo.ts\nM  src/staged.ts\n",
      stderr: "",
    });
    const result = await probeDirtyCounts(REPO);
    expect(result).toEqual({ modifiedCount: 2, untrackedCount: 0 });
  });

  it("counts only untracked when no modified files", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "?? src/new.ts\n",
      stderr: "",
    });
    const result = await probeDirtyCounts(REPO);
    expect(result).toEqual({ modifiedCount: 0, untrackedCount: 1 });
  });

  it("returns zeroes on git error", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });
    const result = await probeDirtyCounts(REPO);
    expect(result).toEqual({ modifiedCount: 0, untrackedCount: 0 });
  });
});

describe("probeUnpushedCount", () => {
  it("returns 0 when HEAD is detached (symbolic-ref exits 1)", async () => {
    vi.mocked(execModule.runCommand).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" }); // symbolic-ref -q HEAD
    const result = await probeUnpushedCount(REPO);
    expect(result).toBe(0);
  });

  it("returns ahead count when upstream is configured", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "refs/heads/feat\n", stderr: "" }) // symbolic-ref -q HEAD
      .mockResolvedValueOnce({ code: 0, stdout: "origin/main\n", stderr: "" }) // rev-parse @{upstream}
      .mockResolvedValueOnce({ code: 0, stdout: "3\n", stderr: "" }); // rev-list --count @{upstream}..HEAD
    const result = await probeUnpushedCount(REPO);
    expect(result).toBe(3);
  });

  it("returns 0 when on a branch with an up-to-date upstream", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "refs/heads/feat\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "origin/feat\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "0\n", stderr: "" });
    const result = await probeUnpushedCount(REPO);
    expect(result).toBe(0);
  });

  it("counts unique commits vs all remotes when no upstream configured", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "refs/heads/feat\n", stderr: "" }) // symbolic-ref -q HEAD
      .mockResolvedValueOnce({ code: 128, stdout: "", stderr: "fatal: no upstream" }) // rev-parse @{upstream} fails
      .mockResolvedValueOnce({ code: 0, stdout: "2\n", stderr: "" }); // rev-list --count HEAD --not --remotes
    const result = await probeUnpushedCount(REPO);
    expect(result).toBe(2);
  });

  it("returns 0 when no upstream and no unique commits vs remotes", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "refs/heads/feat\n", stderr: "" })
      .mockResolvedValueOnce({ code: 128, stdout: "", stderr: "fatal: no upstream" })
      .mockResolvedValueOnce({ code: 0, stdout: "0\n", stderr: "" });
    const result = await probeUnpushedCount(REPO);
    expect(result).toBe(0);
  });

  it("returns 0 on git error in ahead check", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "refs/heads/feat\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "origin/main\n", stderr: "" })
      .mockResolvedValueOnce({ code: 128, stdout: "", stderr: "fatal: error" });
    const result = await probeUnpushedCount(REPO);
    expect(result).toBe(0);
  });
});

describe("probeWorkUnitState", () => {
  it("returns branch and dirty counts by running all three probes in parallel", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "feat/my-feature\n", stderr: "" }) // probeHeadBranch (symbolic-ref --short)
      .mockResolvedValueOnce({ code: 0, stdout: " M foo.ts\n?? bar.ts\n", stderr: "" }) // probeDirtyCounts (status --porcelain)
      .mockResolvedValueOnce({ code: 0, stdout: "refs/heads/feat\n", stderr: "" }) // probeUnpushedCount (symbolic-ref -q)
      .mockResolvedValueOnce({ code: 0, stdout: "origin/feat\n", stderr: "" }) // probeUnpushedCount (rev-parse @{upstream})
      .mockResolvedValueOnce({ code: 0, stdout: "1\n", stderr: "" }); // probeUnpushedCount (rev-list --count)

    const result = await probeWorkUnitState(REPO);

    expect(result.branch).toBe("feat/my-feature");
    expect(result.dirty.modifiedCount).toBe(1);
    expect(result.dirty.untrackedCount).toBe(1);
    expect(result.dirty.unpushedCommits).toBe(1);
  });

  it("returns null branch for detached HEAD with dirty counts still probed", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" }) // probeHeadBranch — detached
      .mockResolvedValueOnce({ code: 0, stdout: " M foo.ts\n", stderr: "" }) // probeDirtyCounts
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" }); // probeUnpushedCount symbolic-ref — detached

    const result = await probeWorkUnitState(REPO);

    expect(result.branch).toBeNull();
    expect(result.dirty.modifiedCount).toBe(1);
    expect(result.dirty.unpushedCommits).toBe(0);
  });

  it("returns clean dirty counts when working tree is clean", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "main\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "refs/heads/main\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "origin/main\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "0\n", stderr: "" });

    const result = await probeWorkUnitState(REPO);

    expect(result.dirty).toEqual({ modifiedCount: 0, untrackedCount: 0, unpushedCommits: 0 });
  });
});
