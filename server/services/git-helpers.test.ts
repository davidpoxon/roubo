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
