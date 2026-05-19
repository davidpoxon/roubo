import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:os", () => ({ default: { homedir: () => "/mock-home" } }));
vi.mock("node:url", () => ({
  fileURLToPath: () => "/projects/my-checkout/server/services/state.ts",
}));

let mkdirSync: ReturnType<typeof vi.fn>;
let existsSync: ReturnType<typeof vi.fn>;
let readFileSync: ReturnType<typeof vi.fn>;
let writeFileSync: ReturnType<typeof vi.fn>;
let renameSync: ReturnType<typeof vi.fn>;

const fsMocks = {
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
};

vi.mock("node:fs", () => ({ default: fsMocks }));

let stateModule: typeof import("./state.js");

beforeEach(async () => {
  mkdirSync = vi.fn();
  existsSync = vi.fn();
  readFileSync = vi.fn();
  writeFileSync = vi.fn();
  renameSync = vi.fn();
  fsMocks.mkdirSync = mkdirSync;
  fsMocks.existsSync = existsSync;
  fsMocks.readFileSync = readFileSync;
  fsMocks.writeFileSync = writeFileSync;
  fsMocks.renameSync = renameSync;

  process.env.ROUBO_PRODUCTION = "1";
  vi.resetModules();
  stateModule = await import("./state.js");
});

afterEach(() => {
  delete process.env.ROUBO_PRODUCTION;
});

describe("getRouboDir", () => {
  it("returns ~/.roubo in production mode", () => {
    // ROUBO_PRODUCTION is set in beforeEach
    expect(stateModule.getRouboDir()).toBe("/mock-home/.roubo");
  });

  describe("dev mode", () => {
    let devState: typeof import("./state.js");

    beforeEach(async () => {
      delete process.env.ROUBO_PRODUCTION;
      vi.resetModules();
      devState = await import("./state.js");
    });

    afterEach(() => {
      vi.resetModules();
      process.env.ROUBO_PRODUCTION = "1";
    });

    it("returns ~/.roubo-dev/<checkout-dirname>", () => {
      // node:url is mocked to return '/projects/my-checkout/server/services/state.ts'
      // so project root is '/projects/my-checkout', dirname is 'my-checkout'
      expect(devState.getRouboDir()).toBe("/mock-home/.roubo-dev/my-checkout");
    });
  });
});

describe("sanitizeBranchForPath", () => {
  it("replaces slashes with hyphens", () => {
    expect(stateModule.sanitizeBranchForPath("feature/my-branch")).toBe("feature-my-branch");
  });

  it("handles multiple slashes", () => {
    expect(stateModule.sanitizeBranchForPath("a/b/c")).toBe("a-b-c");
  });

  it("strips leading and trailing dots", () => {
    expect(stateModule.sanitizeBranchForPath(".hidden")).toBe("hidden");
    expect(stateModule.sanitizeBranchForPath("branch.")).toBe("branch");
  });

  it("passes through simple names unchanged", () => {
    expect(stateModule.sanitizeBranchForPath("simple-branch")).toBe("simple-branch");
  });

  it("strips leading and trailing hyphens after slash replacement", () => {
    expect(stateModule.sanitizeBranchForPath("/leading")).toBe("leading");
    expect(stateModule.sanitizeBranchForPath("trailing/")).toBe("trailing");
  });

  it('falls back to "branch" when result would be empty', () => {
    expect(stateModule.sanitizeBranchForPath("..")).toBe("branch");
    expect(stateModule.sanitizeBranchForPath("...")).toBe("branch");
    expect(stateModule.sanitizeBranchForPath("-")).toBe("branch");
    expect(stateModule.sanitizeBranchForPath(".-.")).toBe("branch");
  });
});

describe("getWorkspacePath", () => {
  it("returns correct path without branch", () => {
    expect(stateModule.getWorkspacePath("project", 3)).toBe(
      "/mock-home/.roubo/workspaces/project/bench-3",
    );
  });

  it("includes sanitized branch name when provided", () => {
    expect(stateModule.getWorkspacePath("project", 1, "feature/my-branch")).toBe(
      "/mock-home/.roubo/workspaces/project/bench-1-feature-my-branch",
    );
  });

  it("returns default format when branch is undefined", () => {
    expect(stateModule.getWorkspacePath("project", 2, undefined)).toBe(
      "/mock-home/.roubo/workspaces/project/bench-2",
    );
  });
});

describe("atomicWrite", () => {
  it("writes to .tmp then renames", () => {
    stateModule.atomicWrite("/some/file.json", '{"data":1}');
    expect(writeFileSync).toHaveBeenCalledWith("/some/file.json.tmp", '{"data":1}', {
      encoding: "utf-8",
      mode: 0o666,
    });
    expect(renameSync).toHaveBeenCalledWith("/some/file.json.tmp", "/some/file.json");
  });
});

const DEFAULT_BLUEPRINT_SETTINGS = { autoInject: true, autoExecute: true };
const DEFAULT_BENCH_SETTINGS = {
  autoClear: true,
  enforceIssueDependencies: false,
  workUnitAutoClear: true,
  autoStartComponents: false,
};
const DEFAULT_CLAUDE_CODE_SETTINGS = {
  enableAutoMode: false,
  startInPlanMode: false,
};
const DEFAULT_GITHUB_SETTINGS = { issueTypesCacheTtlSeconds: 300 };

describe("loadSettings", () => {
  it("returns default settings with blueprint defaults when file does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("returns parsed JSON merged with blueprint defaults when file exists", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ theme: "light" }));
    expect(stateModule.loadSettings()).toEqual({
      theme: "light",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("returns default settings with blueprint defaults when file contains malformed JSON", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("not valid json{{{");
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("preserves custom blueprint settings from file", () => {
    existsSync.mockReturnValue(true);
    const customBlueprints = {
      autoInject: false,
      autoExecute: false,
      defaultBlueprintId: "cleanup",
    };
    readFileSync.mockReturnValue(JSON.stringify({ theme: "light", blueprints: customBlueprints }));
    expect(stateModule.loadSettings()).toEqual({
      theme: "light",
      blueprints: customBlueprints,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("preserves custom bench settings from file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ theme: "dark", benches: { autoClear: false } }));
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: {
        autoClear: false,
        enforceIssueDependencies: false,
        workUnitAutoClear: true,
        autoStartComponents: false,
      },
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("preserves custom claudeCode settings from file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        theme: "dark",
        claudeCode: { enableAutoMode: true, startInPlanMode: true },
      }),
    );
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: { enableAutoMode: true, startInPlanMode: true },
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("merges partial claudeCode settings with defaults", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({ theme: "dark", claudeCode: { enableAutoMode: true } }),
    );
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: { enableAutoMode: true, startInPlanMode: false },
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("preserves autoStartComponents true from file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        theme: "dark",
        benches: { autoStartComponents: true },
      }),
    );
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: {
        autoClear: true,
        enforceIssueDependencies: false,
        workUnitAutoClear: true,
        autoStartComponents: true,
      },
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("preserves enforceIssueDependencies true from file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        theme: "dark",
        benches: { autoClear: false, enforceIssueDependencies: true },
      }),
    );
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: {
        autoClear: false,
        enforceIssueDependencies: true,
        workUnitAutoClear: true,
        autoStartComponents: false,
      },
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });

  it("preserves custom github settings from file", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        theme: "dark",
        github: { issueTypesCacheTtlSeconds: 60 },
      }),
    );
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: { issueTypesCacheTtlSeconds: 60 },
    });
  });

  it("merges partial github settings with defaults", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ theme: "dark", github: {} }));
    expect(stateModule.loadSettings()).toEqual({
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    });
  });
});

describe("saveSettings", () => {
  it("calls atomicWrite with JSON", () => {
    const data = { theme: "light" as const };
    stateModule.saveSettings(data);
    expect(writeFileSync).toHaveBeenCalledWith(
      "/mock-home/.roubo/settings.json.tmp",
      JSON.stringify(data, null, 2),
      { encoding: "utf-8", mode: 0o666 },
    );
    expect(renameSync).toHaveBeenCalledWith(
      "/mock-home/.roubo/settings.json.tmp",
      "/mock-home/.roubo/settings.json",
    );
  });
});

describe("loadProjects", () => {
  it("returns { projects: [] } when file does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(stateModule.loadProjects()).toEqual({ projects: [] });
  });

  it("returns parsed JSON when file exists", () => {
    existsSync.mockReturnValue(true);
    const data = {
      projects: [{ id: "project1", repoPath: "/repos/project1" }],
    };
    readFileSync.mockReturnValue(JSON.stringify(data));
    expect(stateModule.loadProjects()).toEqual(data);
  });
});

describe("saveProjects", () => {
  it("calls atomicWrite with JSON", () => {
    const data = {
      projects: [{ id: "project1", repoPath: "/repos/project1" }],
    };
    stateModule.saveProjects(data);
    expect(writeFileSync).toHaveBeenCalledWith(
      "/mock-home/.roubo/projects.json.tmp",
      JSON.stringify(data, null, 2),
      { encoding: "utf-8", mode: 0o666 },
    );
    expect(renameSync).toHaveBeenCalledWith(
      "/mock-home/.roubo/projects.json.tmp",
      "/mock-home/.roubo/projects.json",
    );
  });
});

describe("loadState", () => {
  it("returns { benches: [] } when file does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(stateModule.loadState()).toEqual({ benches: [] });
  });
});

describe("addProject", () => {
  it("deduplicates by id", () => {
    const existing = { projects: [{ id: "project1", repoPath: "/old" }] };
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(existing));

    stateModule.addProject({ id: "project1", repoPath: "/new" });

    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.projects).toEqual([{ id: "project1", repoPath: "/new" }]);
  });
});

describe("removeProject", () => {
  it("filters out matching project", () => {
    const existing = {
      projects: [
        { id: "project1", repoPath: "/repos/project1" },
        { id: "project2", repoPath: "/repos/project2" },
      ],
    };
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(existing));

    stateModule.removeProject("project1");

    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.projects).toEqual([{ id: "project2", repoPath: "/repos/project2" }]);
  });
});

describe("addBench", () => {
  it("deduplicates by projectId + id", () => {
    const existing = {
      benches: [
        {
          id: 1,
          projectId: "project1",
          branch: "old",
          workspacePath: "/old",
          ports: {},
          createdAt: "old",
        },
      ],
    };
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(existing));

    stateModule.addBench({
      id: 1,
      projectId: "project1",
      branch: "new",
      workspacePath: "/new",
      ports: {},
      createdAt: "new",
    });

    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.benches).toHaveLength(1);
    expect(written.benches[0].branch).toBe("new");
  });
});

describe("removeBench", () => {
  it("filters correctly", () => {
    const existing = {
      benches: [
        {
          id: 1,
          projectId: "project1",
          branch: "a",
          workspacePath: "/a",
          ports: {},
          createdAt: "t1",
        },
        {
          id: 2,
          projectId: "project1",
          branch: "b",
          workspacePath: "/b",
          ports: {},
          createdAt: "t2",
        },
        {
          id: 1,
          projectId: "project2",
          branch: "c",
          workspacePath: "/c",
          ports: {},
          createdAt: "t3",
        },
      ],
    };
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(existing));

    stateModule.removeBench("project1", 1);

    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.benches).toHaveLength(2);
    expect(
      written.benches.map((s: { id: number; projectId: string }) => `${s.projectId}:${s.id}`),
    ).toEqual(["project1:2", "project2:1"]);
  });
});

describe("getProjectPermissions", () => {
  it("returns empty allow/deny when file does not exist", () => {
    existsSync.mockReturnValue(false);
    expect(stateModule.getProjectPermissions("project1")).toEqual({
      allow: [],
      deny: [],
      ask: [],
    });
  });

  it("returns allow and deny arrays when file exists", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        allow: ["tool:Bash", "tool:Read"],
        deny: ["Bash(rm:*)"],
      }),
    );
    expect(stateModule.getProjectPermissions("project1")).toEqual({
      allow: ["tool:Bash", "tool:Read"],
      deny: ["Bash(rm:*)"],
      ask: [],
    });
  });

  it("defaults deny to [] when file has no deny key (legacy file)", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ allow: ["tool:Bash"] }));
    expect(stateModule.getProjectPermissions("project1")).toEqual({
      allow: ["tool:Bash"],
      deny: [],
      ask: [],
    });
  });

  it("defaults ask to [] when file has no ask key (legacy file)", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ allow: ["tool:Bash"], deny: [] }));
    expect(stateModule.getProjectPermissions("project1")).toEqual({
      allow: ["tool:Bash"],
      deny: [],
      ask: [],
    });
  });

  it("reads from the correct per-project file path", () => {
    existsSync.mockReturnValue(false);
    stateModule.getProjectPermissions("my-project");
    expect(existsSync).toHaveBeenCalledWith("/mock-home/.roubo/permissions/my-project.json");
  });

  it("returns empty allow/deny when file contains malformed JSON", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("not valid json{{{");
    expect(stateModule.getProjectPermissions("project1")).toEqual({
      allow: [],
      deny: [],
      ask: [],
    });
  });

  it("returns empty allow/deny when file exists but has no permission keys", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({}));
    expect(stateModule.getProjectPermissions("project1")).toEqual({
      allow: [],
      deny: [],
      ask: [],
    });
  });

  it("throws on path traversal attempt", () => {
    expect(() => stateModule.getProjectPermissions("../../etc/passwd")).toThrow(
      "Invalid projectId",
    );
  });
});

describe("setProjectPermissions", () => {
  it("creates permissions directory and writes file atomically", () => {
    stateModule.setProjectPermissions("project1", {
      allow: ["tool:Bash"],
      deny: [],
    });
    expect(mkdirSync).toHaveBeenCalledWith("/mock-home/.roubo/permissions", {
      recursive: true,
    });
    expect(writeFileSync).toHaveBeenCalledWith(
      "/mock-home/.roubo/permissions/project1.json.tmp",
      JSON.stringify({ allow: ["tool:Bash"], deny: [] }, null, 2),
      { encoding: "utf-8", mode: 0o666 },
    );
    expect(renameSync).toHaveBeenCalledWith(
      "/mock-home/.roubo/permissions/project1.json.tmp",
      "/mock-home/.roubo/permissions/project1.json",
    );
  });

  it("persists deny rules", () => {
    stateModule.setProjectPermissions("project1", {
      allow: [],
      deny: ["Bash(rm:*)"],
    });
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written).toEqual({ allow: [], deny: ["Bash(rm:*)"] });
  });

  it("throws on path traversal attempt", () => {
    expect(() =>
      stateModule.setProjectPermissions("../../etc/passwd", {
        allow: [],
        deny: [],
      }),
    ).toThrow("Invalid projectId");
  });

  it("is idempotent — second write succeeds with same content", () => {
    stateModule.setProjectPermissions("project1", {
      allow: ["tool:Bash"],
      deny: [],
    });
    stateModule.setProjectPermissions("project1", {
      allow: ["tool:Bash"],
      deny: [],
    });
    expect(writeFileSync).toHaveBeenCalledTimes(2);
    const firstWrite = writeFileSync.mock.calls[0][1] as string;
    const secondWrite = writeFileSync.mock.calls[1][1] as string;
    expect(firstWrite).toBe(secondWrite);
  });

  it("writes empty arrays when permissions are empty", () => {
    stateModule.setProjectPermissions("project1", { allow: [], deny: [] });
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written).toEqual({ allow: [], deny: [] });
  });
});

describe("getPersistedBenches", () => {
  it("returns all benches when no projectId filter", () => {
    const existing = {
      benches: [
        {
          id: 1,
          projectId: "project1",
          branch: "a",
          workspacePath: "/a",
          ports: {},
          createdAt: "t1",
        },
        {
          id: 1,
          projectId: "project2",
          branch: "b",
          workspacePath: "/b",
          ports: {},
          createdAt: "t2",
        },
      ],
    };
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(existing));

    expect(stateModule.getPersistedBenches()).toHaveLength(2);
  });

  it("filters by projectId when provided", () => {
    const existing = {
      benches: [
        {
          id: 1,
          projectId: "project1",
          branch: "a",
          workspacePath: "/a",
          ports: {},
          createdAt: "t1",
        },
        {
          id: 1,
          projectId: "project2",
          branch: "b",
          workspacePath: "/b",
          ports: {},
          createdAt: "t2",
        },
      ],
    };
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(existing));

    const result = stateModule.getPersistedBenches("project1");
    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe("project1");
  });
});

describe("toPersistedBench", () => {
  it("extracts only the persisted fields from a Bench, dropping runtime-only fields", () => {
    const bench = {
      id: 3,
      projectId: "proj-1",
      branch: "feat/my-branch",
      workspacePath: "/workspace",
      status: "idle" as const,
      ports: { frontend: 3000 },
      components: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      error: undefined,
      provisioningSteps: [],
      teardownSteps: [],
      assignedContainers: undefined,
      assignedIssue: undefined,
      notifications: [],
      workUnits: undefined,
      baseBranch: "main",
      baseCommit: "abc1234",
    };
    const persisted = stateModule.toPersistedBench(bench);
    expect(persisted).toEqual({
      id: 3,
      projectId: "proj-1",
      branch: "feat/my-branch",
      workspacePath: "/workspace",
      ports: { frontend: 3000 },
      createdAt: "2026-01-01T00:00:00.000Z",
      assignedContainers: undefined,
      assignedIssue: undefined,
      notifications: [],
      workUnits: undefined,
      baseBranch: "main",
      baseCommit: "abc1234",
      componentSetupState: {},
    });
    // Runtime-only fields must not be present on the returned object
    const keys = Object.keys(persisted);
    expect(keys).not.toContain("status");
    expect(keys).not.toContain("components");
    expect(keys).not.toContain("provisioningSteps");
    expect(keys).not.toContain("teardownSteps");
  });

  it("derives componentSetupState from each component's setupComplete flag", () => {
    const persisted = stateModule.toPersistedBench({
      id: 1,
      projectId: "p",
      branch: "b",
      workspacePath: "/w",
      status: "idle",
      ports: {},
      components: {
        db: { name: "db", status: "stopped", setupComplete: true },
        web: { name: "web", status: "stopped", setupComplete: false },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      provisioningSteps: [],
      teardownSteps: [],
      notifications: [],
    });
    expect(persisted.componentSetupState).toEqual({ db: true, web: false });
  });

  it("round-trips componentSetupState through addBench → saveState", () => {
    existsSync.mockReturnValue(false);
    stateModule.addBench({
      id: 7,
      projectId: "project1",
      branch: "main",
      workspacePath: "/workspace",
      ports: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      componentSetupState: { backend: false, db: true },
    });
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.benches[0].componentSetupState).toEqual({ backend: false, db: true });
  });

  it("loads a legacy PersistedBench (no componentSetupState) without error", () => {
    const legacy = {
      benches: [
        {
          id: 1,
          projectId: "project1",
          branch: "main",
          workspacePath: "/workspace",
          ports: {},
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(legacy));

    const state = stateModule.loadState();
    expect(state.benches).toHaveLength(1);
    expect(state.benches[0].componentSetupState).toBeUndefined();
  });
});

describe("workUnits round-trip", () => {
  it("preserves workUnits through addBench → saveState", () => {
    existsSync.mockReturnValue(false);

    stateModule.addBench({
      id: 1,
      projectId: "project1",
      branch: "main",
      workspacePath: "/workspace",
      ports: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      workUnits: [
        {
          submodule: "api",
          branch: "feat/my-feature",
          workspacePath: "/workspace/api",
          pullRequest: {
            repoFullName: "acme/api",
            number: 42,
            title: "My feature",
            state: "open",
            merged: false,
            url: "https://github.com/acme/api/pull/42",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          lastSyncedAt: "2026-01-01T01:00:00.000Z",
        },
      ],
    });

    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.benches[0].workUnits).toHaveLength(1);
    expect(written.benches[0].workUnits[0].submodule).toBe("api");
    expect(written.benches[0].workUnits[0].pullRequest.number).toBe(42);
    expect(written.benches[0].workUnits[0].lastSyncedAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("loads a legacy PersistedBench (no workUnits) without error", () => {
    const legacy = {
      benches: [
        {
          id: 1,
          projectId: "project1",
          branch: "main",
          workspacePath: "/workspace",
          ports: {},
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(legacy));

    const state = stateModule.loadState();
    expect(state.benches).toHaveLength(1);
    expect(state.benches[0].workUnits).toBeUndefined();
  });
});
