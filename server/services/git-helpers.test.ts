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
  resolveGitIdentity,
  fastForwardLocalBranch,
  SENTINEL_AUTHOR_NAME,
  SENTINEL_AUTHOR_EMAIL,
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
      // First call: symbolic-ref HEAD (fails: detached)
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

describe("resolveGitIdentity", () => {
  it("returns { name, email } with no isSentinel when both values are set", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "Ada Lovelace\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "ada@example.com\n", stderr: "" });

    const result = await resolveGitIdentity(REPO);

    expect(result).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(result.isSentinel).toBeUndefined();
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["config", "user.name"],
      REPO,
      undefined,
      5_000,
    );
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["config", "user.email"],
      REPO,
      undefined,
      5_000,
    );
  });

  it("returns the sentinel author with isSentinel when user.name is unset/empty", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "ada@example.com\n", stderr: "" });

    const result = await resolveGitIdentity(REPO);

    expect(result).toEqual({
      name: SENTINEL_AUTHOR_NAME,
      email: SENTINEL_AUTHOR_EMAIL,
      isSentinel: true,
    });
  });

  it("returns the sentinel author with isSentinel when user.email is unset/empty", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "Ada Lovelace\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const result = await resolveGitIdentity(REPO);

    expect(result).toEqual({
      name: SENTINEL_AUTHOR_NAME,
      email: SENTINEL_AUTHOR_EMAIL,
      isSentinel: true,
    });
  });

  it("returns the sentinel author without throwing when a git command exits non-zero", async () => {
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "ada@example.com\n", stderr: "" });

    const result = await resolveGitIdentity(REPO);

    expect(result).toEqual({
      name: SENTINEL_AUTHOR_NAME,
      email: SENTINEL_AUTHOR_EMAIL,
      isSentinel: true,
    });
  });

  it("returns the sentinel author without throwing when runCommand rejects", async () => {
    vi.mocked(execModule.runCommand).mockRejectedValue(new Error("spawn failed"));

    const result = await resolveGitIdentity(REPO);

    expect(result).toEqual({
      name: SENTINEL_AUTHOR_NAME,
      email: SENTINEL_AUTHOR_EMAIL,
      isSentinel: true,
    });
  });
});

// The real-git cases live in git-helpers.fast-forward.git.test.ts. These cover
// a second bench moving the branch between the read and the write, which a
// real repository cannot be made to interleave on demand.
describe("fastForwardLocalBranch: a concurrent write to the branch", () => {
  const OLD = "1111111";
  const REMOTE = "2222222";

  /**
   * Scripts git for a main checkout on `feature` with `main` behind origin.
   * The branch reads as `first` (default OLD), then as `after` once the write has failed;
   * `contains` lists the [ancestor, descendant] pairs merge-base accepts.
   */
  function scriptGit(opts: {
    first?: string | null;
    after: string | null;
    contains: [string, string][];
  }) {
    let reads = 0;
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd, args) => {
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (args[0] === "worktree")
        return ok(`worktree ${REPO}\nHEAD ${OLD}\nbranch refs/heads/feature\n`);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${REPO}\n`);
      if (args[0] === "rev-parse") {
        reads += 1;
        const value = reads === 1 ? (opts.first === undefined ? OLD : opts.first) : opts.after;
        return value === null ? { code: 1, stdout: "", stderr: "" } : ok(`${value}\n`);
      }
      if (args[0] === "merge-base") {
        const [anc, desc] = [args[2], args[3]].map((r) =>
          r === "refs/remotes/origin/main" ? REMOTE : r,
        );
        return {
          code: opts.contains.some(([a, d]) => a === anc && d === desc) ? 0 : 1,
          stdout: "",
          stderr: "",
        };
      }
      if (args[0] === "update-ref" || args[0] === "branch") {
        return { code: 128, stdout: "", stderr: "fatal: cannot lock ref 'refs/heads/main'" };
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    });
  }

  it("writes by compare-and-swap, and succeeds when the failed write finds the branch caught up", async () => {
    scriptGit({
      after: REMOTE,
      contains: [
        [OLD, REMOTE],
        [REMOTE, REMOTE],
      ],
    });

    await expect(fastForwardLocalBranch(REPO, "main")).resolves.toBeUndefined();
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      [
        "update-ref",
        "-m",
        "roubo: pull latest from origin/main",
        "refs/heads/main",
        "refs/remotes/origin/main",
        OLD,
      ],
      REPO,
      undefined,
      10_000,
    );
  });

  it("fails when the failed write finds the branch moved somewhere origin is not", async () => {
    scriptGit({ after: "3333333", contains: [[OLD, REMOTE]] });

    await expect(fastForwardLocalBranch(REPO, "main")).rejects.toThrow(
      "Could not fast-forward 'main': fatal: cannot lock ref 'refs/heads/main'.",
    );
  });

  it("succeeds when another bench created the missing branch first", async () => {
    // The first read finds no branch, the second finds the one the other bench made.
    scriptGit({ first: null, after: REMOTE, contains: [[REMOTE, REMOTE]] });

    await expect(fastForwardLocalBranch(REPO, "main")).resolves.toBeUndefined();
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["branch", "--track", "main", "origin/main"],
      REPO,
      undefined,
      10_000,
    );
  });
});
