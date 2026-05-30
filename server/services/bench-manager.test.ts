import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BenchNotification } from "@roubo/shared";
import { COMPONENT_STEP_PREFIX } from "@roubo/shared";
import { makeConfig, makeProject, makePersistedBench } from "../test/fixtures.js";
import { DEFAULT_BRANCH_RESOLUTION_ERROR } from "./git-helpers.js";
import { RESOLVE_DEFAULT_BRANCH_PHASE } from "./bench-manager.js";

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return {
    loadState: vi.fn(() => ({ benches: [] })),
    addBench: vi.fn(),
    removeBench: vi.fn(),
    getWorkspacePath: vi.fn(),
    updateBench: vi.fn(),
    getProjectPermissions: vi.fn(() => ({ allow: [], deny: [] })),
    setProjectPermissions: vi.fn(),
    loadSettings: vi.fn(() => ({
      theme: "dark",
      benches: {
        autoClear: true,
        enforceIssueDependencies: false,
        workUnitAutoClear: true,
        autoStartComponents: false,
      },
    })),
    toPersistedBench: actual.toPersistedBench,
  };
});

vi.mock("./docker.js", () => ({
  composeUp: vi.fn(),
  composeRunInit: vi.fn(),
  composeStop: vi.fn(),
  composeDown: vi.fn(),
  waitForHealthy: vi.fn(),
  getContainerStatus: vi.fn(),
  getContainerStatuses: vi.fn(),
  getComposeProjectName: vi.fn(),
  listDatabaseContainers: vi.fn(),
}));

vi.mock("./process-manager.js", () => ({
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  getProcessStatus: vi.fn(() => ({ alive: false, exitCode: null })),
  getProcessLogs: vi.fn(() => []),
  getProcessPid: vi.fn(),
  stopAllProcesses: vi.fn(),
  storeCommandLogs: vi.fn(),
  clearProcessLogs: vi.fn(),
}));

vi.mock("./port-allocator.js", () => ({
  allocatePorts: vi.fn(),
}));

vi.mock("./config-parser.js", () => ({
  buildTemplateContext: vi.fn(),
  resolveTemplate: vi.fn((s: string) => s),
  resolveServiceEnv: vi.fn((env: Record<string, string>) => env),
  stripSurroundingQuotes: vi.fn((s: string) => {
    if (
      s.length >= 2 &&
      ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    ) {
      return s.slice(1, -1);
    }
    return s;
  }),
  parseConfig: vi.fn(),
  validateConfigObject: vi.fn(),
}));

vi.mock("./exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec.js")>()),
  runCommand: vi.fn(),
}));

vi.mock("./terminal.js", () => ({
  destroyBenchSessions: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  getSession: vi.fn(),
  getSessions: vi.fn(() => []),
}));

vi.mock("./notification.js", () => ({
  createNotification: vi.fn(),
  dismissBenchLevelForBench: vi.fn(),
  dismissOne: vi.fn(),
  dismissBySession: vi.fn(),
  getNotifications: vi.fn(() => []),
}));

vi.mock("./sse.js", () => ({
  broadcast: vi.fn(),
  broadcastBenchStatus: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    promises: {
      writeFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => ""),
    },
  },
  promises: {
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
  },
}));

vi.mock("./claude-settings-local.js", () => ({
  injectPermissions: vi.fn(),
}));

vi.mock("./git-helpers.js", () => ({
  resolveHeadBranch: vi.fn(),
  resolveDefaultBranch: vi.fn(),
  parseGitmodulesWithBranch: vi.fn(),
  resolveSubmoduleBranch: vi.fn(),
  DefaultBranchResolutionError: class DefaultBranchResolutionError extends Error {},
  DEFAULT_BRANCH_RESOLUTION_ERROR: "Could not determine the default branch",
}));

let benchManager: typeof import("./bench-manager.js");
let projectRegistry: typeof import("./project-registry.js");
let stateService: typeof import("./state.js");
let dockerService: typeof import("./docker.js");
let processManager: typeof import("./process-manager.js");
let portAllocator: typeof import("./port-allocator.js");
let configParser: typeof import("./config-parser.js");
let execModule: typeof import("./exec.js");
let terminalService: typeof import("./terminal.js");
let notificationService: typeof import("./notification.js");
let sseService: typeof import("./sse.js");
let claudeSettingsLocal: typeof import("./claude-settings-local.js");
let gitHelpers: typeof import("./git-helpers.js");
let fs: typeof import("node:fs");

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  // bench-manager logs intentional warn/error for failed git ops, worktree
  // removes, permission injection, etc. All paths these tests deliberately
  // exercise via mocks. Tests assert on the resulting bench state / retry
  // behavior; the log text itself is not the contract.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});

  benchManager = await import("./bench-manager.js");
  projectRegistry = await import("./project-registry.js");
  stateService = await import("./state.js");
  dockerService = await import("./docker.js");
  processManager = await import("./process-manager.js");
  portAllocator = await import("./port-allocator.js");
  configParser = await import("./config-parser.js");
  execModule = await import("./exec.js");
  terminalService = await import("./terminal.js");
  notificationService = await import("./notification.js");
  sseService = await import("./sse.js");
  claudeSettingsLocal = await import("./claude-settings-local.js");
  gitHelpers = await import("./git-helpers.js");
  fs = await import("node:fs");
});

function setupCreateBenchMocks(overrides?: { project?: ReturnType<typeof makeProject> }) {
  const project =
    overrides?.project ??
    makeProject({
      settings: {
        worktreeSource: { branchFromDefault: false, pullLatest: false },
      },
    });
  vi.mocked(projectRegistry.getProject).mockReturnValue(project);
  vi.mocked(portAllocator.allocatePorts).mockReturnValue({ backend: 5001 });
  vi.mocked(stateService.getWorkspacePath).mockReturnValue(
    "/home/.roubo/workspaces/test-project/bench-1",
  );
  vi.mocked(execModule.runCommand).mockResolvedValue({
    code: 0,
    stdout: "",
    stderr: "",
  });
  // resolveHeadBranch and resolveDefaultBranch are mocked at module level (git-helpers.js);
  // provide sensible defaults so tests that don't care about the base branch just work.
  vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("main");
  vi.mocked(gitHelpers.resolveDefaultBranch).mockResolvedValue("main");
  vi.mocked(fs.default.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.default.existsSync).mockReturnValue(false);
  vi.mocked(stateService.addBench).mockReturnValue(undefined);
  vi.mocked(configParser.buildTemplateContext).mockReturnValue({
    ports: { backend: 5001 },
    portHttps: {},
    workspace: "/home/.roubo/workspaces/test-project/bench-1",
    components: {},
  });
  vi.mocked(configParser.resolveTemplate).mockImplementation((s) => s);
  vi.mocked(configParser.resolveServiceEnv).mockImplementation((env) => env);
  return project;
}

function setupDockerServiceMocks() {
  vi.mocked(dockerService.composeUp).mockResolvedValue({
    success: true,
    stdout: "",
    stderr: "",
  });
  vi.mocked(dockerService.composeRunInit).mockResolvedValue({
    success: true,
    stdout: "",
    stderr: "",
  });
  vi.mocked(dockerService.waitForHealthy).mockResolvedValue(true);
  vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");
}

function setupProcessMocks() {
  vi.mocked(processManager.startProcess).mockReturnValue({ pid: 123 });
  vi.mocked(processManager.stopProcess).mockResolvedValue(undefined);
  vi.mocked(processManager.getProcessStatus).mockReturnValue({
    alive: false,
    exitCode: null,
  });
  vi.mocked(processManager.getProcessLogs).mockReturnValue([]);
  vi.mocked(processManager.getProcessPid).mockReturnValue(undefined);
}

/**
 * Configures fs and git-helper mocks so that meta-repo provisioning can pass
 * the .gitmodules validation and resolve submodule branches.
 *
 * Call after setupCreateBenchMocks() for any test that exercises a meta-repo
 * bench through background provisioning.
 *
 * @param submodules - the same Record<name, relativePath> used in the config's
 *   layout.submodules, so the parser mock returns a matching map.
 */
function setupMetaRepoGitmodulesMocks(submodules: Record<string, string>) {
  // Make existsSync return true for .gitmodules paths, false for everything else
  vi.mocked(fs.default.existsSync).mockImplementation(
    (p: unknown) => typeof p === "string" && p.endsWith(".gitmodules"),
  );
  vi.mocked(fs.default.promises.readFile).mockResolvedValue("[submodule]" as any);
  const gitmodulesMap = Object.fromEntries(
    Object.entries(submodules).map(([name, relativePath]) => [name, { path: relativePath }]),
  );
  vi.mocked(gitHelpers.parseGitmodulesWithBranch).mockReturnValue(gitmodulesMap);
  vi.mocked(gitHelpers.resolveSubmoduleBranch).mockResolvedValue("feature/sub-branch");
}

/** Set up a pre-existing bench via initialize() for tests that don't need to test creation */
function setupExistingBench(overrides?: {
  config?: ReturnType<typeof makeConfig>;
  ports?: Record<string, number>;
}) {
  const config = overrides?.config ?? makeConfig();
  const project = makeProject({ config });
  const ports = overrides?.ports ?? { backend: 5001 };
  vi.mocked(stateService.loadState).mockReturnValue({
    benches: [makePersistedBench({ ports })],
  });
  vi.mocked(projectRegistry.getProject).mockReturnValue(project);
  vi.mocked(portAllocator.allocatePorts).mockReturnValue(ports);
  vi.mocked(stateService.getWorkspacePath).mockReturnValue(
    "/home/.roubo/workspaces/test-project/bench-1",
  );
  vi.mocked(configParser.buildTemplateContext).mockReturnValue({
    ports,
    portHttps: {},
    workspace: "/home/.roubo/workspaces/test-project/bench-1",
    components: {},
  });
  vi.mocked(configParser.resolveTemplate).mockImplementation((s) => s);
  vi.mocked(configParser.resolveServiceEnv).mockImplementation((env) => env);
  benchManager.initialize();
  return project;
}

describe("initialize", () => {
  it("populates benches from persisted state with component statuses set to stopped", () => {
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench();

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.id).toBe(1);
    expect(bench.projectId).toBe("test-project");
    expect(bench.branch).toBe("bench-1");
    expect(bench.status).toBe("idle");
    expect(bench.components.backend.status).toBe("stopped");
    expect(bench.provisioningSteps).toEqual([]);
  });

  it("handles missing project config gracefully", () => {
    const persisted = makePersistedBench();
    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as any);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components).toEqual({});
  });

  it("loads a persisted bench whose workspace path fails the safe-path allowlist in an error state", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig();
    const project = makeProject({ config });
    const safe = makePersistedBench({ id: 1 });
    const unsafe = makePersistedBench({
      id: 2,
      workspacePath: "/home/.roubo/workspaces/test-project/bench-2; rm -rf x",
    });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [safe, unsafe] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    expect(benchManager.getBench("test-project", 1)?.status).toBe("idle");

    // The unsafe bench stays visible (so it can be cleared from the UI) but is
    // marked errored, and the tainted path never enters the live bench model.
    const errored = benchManager.getBench("test-project", 2);
    expect(errored).toBeDefined();
    expect(errored?.status).toBe("error");
    expect(errored?.workspacePath).toBe("");
    expect(errored?.error).toMatch(/safe-path allowlist/);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsafe persisted workspace path"),
    );

    warnSpy.mockRestore();
  });

  it("restores notifications from persisted state", () => {
    const notification: BenchNotification = {
      id: "n1",
      type: "bench-ready",
      priority: "info",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench({ notifications: [notification] });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.notifications).toEqual([notification]);
  });

  it("restores injectedJigId from persisted state", () => {
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench({
      injectedJigId: "my-jig",
    });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.injectedJigId).toBe("my-jig");
  });

  it("restores injectedJigSource from persisted state", () => {
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench({
      injectedJigId: "my-jig",
      injectedJigSource: "issue-type-mapping",
    });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.injectedJigSource).toBe("issue-type-mapping");
  });

  it("preserves assignedIssue.issueType even when the category is no longer enabled (TC-097, frozen snapshot)", () => {
    // The snapshot-read path must not validate issueType against the current
    // listIssueTypes catalog: an alert-backed bench whose source has since
    // toggled its category off should still render with its original frozen
    // metadata. The initialize loop simply copies assignedIssue through, so
    // any value the user persisted (including the security-* alert types)
    // survives intact.
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench({
      assignedIssue: {
        number: 42,
        integrationId: "github-com",
        externalId: "42",
        title: "Bump lodash from 4.17.20 to 4.17.21",
        issueType: "security-dependabot",
      },
    });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.assignedIssue).toEqual({
      number: 42,
      integrationId: "github-com",
      externalId: "42",
      title: "Bump lodash from 4.17.20 to 4.17.21",
      issueType: "security-dependabot",
    });
  });

  it("coerces missing componentSetupState to true (legacy migration)", () => {
    // Even though backend defines a setup command, a bench persisted before
    // setupComplete existed is treated as already-setup-complete because it
    // was created under the old full-provisioning flow.
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start", setup: "npm ci" },
      },
    });
    const project = makeProject({ config });
    const persisted = makePersistedBench(); // no componentSetupState

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.backend.setupComplete).toBe(true);
  });

  it("preserves setupComplete=false from persisted componentSetupState", () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start", setup: "npm ci" },
      },
    });
    const project = makeProject({ config });
    const persisted = makePersistedBench({
      componentSetupState: { backend: false },
    });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.backend.setupComplete).toBe(false);
  });

  it("falls back to !setup default for components new to roubo.yaml after bench creation", () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start" }, // no setup
        worker: { type: "process", command: "npm run worker", setup: "npm ci" },
      },
    });
    const project = makeProject({ config });
    // Persisted state mentions only backend — worker was added to roubo.yaml later.
    const persisted = makePersistedBench({
      componentSetupState: { backend: true },
    });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.backend.setupComplete).toBe(true);
    expect(bench.components.worker.setupComplete).toBe(false);
  });
});

describe("reconcile", () => {
  it("uses batched getContainerStatuses for docker services", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
        },
      },
    });
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench({ ports: { db: 5432, backend: 5001 } })],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    vi.mocked(fs.default.existsSync).mockReturnValue(true);
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: `workspace /home/.roubo/workspaces/test-project/bench-1\nHEAD abc123\nbranch refs/heads/bench-1\n\n`,
      stderr: "",
    });
    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");
    vi.mocked(dockerService.getContainerStatuses).mockResolvedValue(
      new Map([["roubo-test-project-bench-1/db", "running"]]),
    );
    vi.mocked(processManager.getProcessStatus).mockReturnValue({
      alive: false,
      exitCode: null,
    });

    benchManager.initialize();
    await benchManager.reconcile();

    expect(dockerService.getContainerStatuses).toHaveBeenCalledWith([
      { projectName: "roubo-test-project-bench-1", service: "db" },
    ]);
    expect(dockerService.getContainerStatus).not.toHaveBeenCalled();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("running");
  });

  it("marks bench as error when workspace directory is missing", async () => {
    const config = makeConfig();
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench()],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    vi.mocked(fs.default.existsSync).mockReturnValue(false);

    benchManager.initialize();
    await benchManager.reconcile();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.status).toBe("error");
    expect(bench.error).toBe("Workspace directory not found");
    expect(dockerService.getContainerStatuses).not.toHaveBeenCalled();
  });
});

describe("createBench", () => {
  it("returns bench with correct properties and provisioning steps", () => {
    setupCreateBenchMocks();
    setupProcessMocks();

    const bench = benchManager.createBench("test-project", "feature-branch");

    expect(bench.id).toBe(1);
    expect(bench.projectId).toBe("test-project");
    expect(bench.branch).toBe("feature-branch");
    expect(bench.workspacePath).toBe("/home/.roubo/workspaces/test-project/bench-1");
    expect(bench.ports).toEqual({ backend: 5001 });
    expect(bench.components.backend).toBeDefined();
    // Worktree-only create: provisioningSteps contains only the workspace step.
    // Component steps are populated when Start runs (issue #3).
    expect(bench.provisioningSteps).toHaveLength(1);
    expect(bench.provisioningSteps[0].id).toBe("workspace");
  });

  it("includes submodules as a phase of the workspace step for meta-repo", () => {
    const config = makeConfig({
      layout: { type: "meta-repo", submodules: { sub1: "path/to/sub1" } },
    });
    setupCreateBenchMocks({
      project: makeProject({
        config,
        settings: {
          worktreeSource: { branchFromDefault: false, pullLatest: false },
        },
      }),
    });
    setupProcessMocks();

    const bench = benchManager.createBench("test-project");

    expect(bench.provisioningSteps).toHaveLength(1);
    expect(bench.provisioningSteps[0].id).toBe("workspace");
    expect(bench.provisioningSteps[0].phases).toEqual([
      { label: "Initializing submodules", status: "pending" },
    ]);
  });

  it("passes branch to getWorkspacePath when provided", () => {
    setupCreateBenchMocks();
    setupProcessMocks();

    benchManager.createBench("test-project", "feature/x");

    expect(stateService.getWorkspacePath).toHaveBeenCalledWith("test-project", 1, "feature/x");
  });

  it("passes undefined branch to getWorkspacePath when not provided", () => {
    setupCreateBenchMocks();
    setupProcessMocks();

    benchManager.createBench("test-project");

    expect(stateService.getWorkspacePath).toHaveBeenCalledWith("test-project", 1, undefined);
  });

  it("throws PROJECT_NOT_FOUND when project not found", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as any);

    expect(() => benchManager.createBench("nonexistent")).toThrow();
    try {
      benchManager.createBench("nonexistent");
    } catch (err) {
      expect((err as any).code).toBe("PROJECT_NOT_FOUND");
    }
  });

  it("throws NO_BENCHES when all benches used", () => {
    setupCreateBenchMocks();
    setupProcessMocks();
    for (let i = 0; i < 5; i++) {
      vi.mocked(portAllocator.allocatePorts).mockReturnValue({
        backend: 5000 + i,
      });
      vi.mocked(stateService.getWorkspacePath).mockReturnValue(
        `/home/.roubo/workspaces/test-project/bench-${i + 1}`,
      );
      benchManager.createBench("test-project");
    }

    expect(() => benchManager.createBench("test-project")).toThrow();
    try {
      benchManager.createBench("test-project");
    } catch (err) {
      expect((err as any).code).toBe("NO_BENCHES");
    }
  });

  it("assigns different bench IDs when called concurrently", () => {
    setupCreateBenchMocks();
    setupProcessMocks();
    vi.mocked(stateService.getWorkspacePath).mockImplementation(
      (_appName: string, benchNum: number, _branch?: string) =>
        `/home/.roubo/workspaces/test-project/bench-${benchNum}`,
    );

    const bench1 = benchManager.createBench("test-project");
    const bench2 = benchManager.createBench("test-project");

    expect(bench1.id).not.toBe(bench2.id);
    expect(new Set([bench1.id, bench2.id])).toEqual(new Set([1, 2]));
  });

  it("initialises setupComplete=true for components without a setup command", () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start" },
      },
      ports: { backend: { base: 5000 } },
    });
    setupCreateBenchMocks({
      project: makeProject({
        config,
        settings: { worktreeSource: { branchFromDefault: false, pullLatest: false } },
      }),
    });
    setupProcessMocks();

    const bench = benchManager.createBench("test-project");
    expect(bench.components.backend.setupComplete).toBe(true);
  });

  it("initialises setupComplete=false for components with a setup command", () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          setup: "npm ci",
        },
      },
      ports: { frontend: { base: 3000 } },
    });
    setupCreateBenchMocks({
      project: makeProject({
        config,
        settings: { worktreeSource: { branchFromDefault: false, pullLatest: false } },
      }),
    });
    setupProcessMocks();

    const bench = benchManager.createBench("test-project");
    expect(bench.components.frontend.setupComplete).toBe(false);
  });
});

describe("background provisioning", () => {
  it("completes the workspace step and persists bench on success", async () => {
    setupCreateBenchMocks();
    setupProcessMocks();

    benchManager.createBench("test-project", "my-branch");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          projectId: "test-project",
          branch: "my-branch",
          workspacePath: "/home/.roubo/workspaces/test-project/bench-1",
          ports: { backend: 5001 },
        }),
      );
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps).toHaveLength(1);
    expect(bench.provisioningSteps[0].id).toBe("workspace");
    expect(bench.provisioningSteps[0].status).toBe("done");
  });

  it("broadcasts a bench-status event with status idle once provisioning completes", async () => {
    setupCreateBenchMocks();
    setupProcessMocks();

    benchManager.createBench("test-project", "feature-branch");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("idle");
    });

    expect(sseService.broadcastBenchStatus).toHaveBeenCalledTimes(1);
    const broadcastedBench = vi.mocked(sseService.broadcastBenchStatus).mock.calls[0][0];
    expect(broadcastedBench.id).toBe(1);
    expect(broadcastedBench.projectId).toBe("test-project");
    expect(broadcastedBench.status).toBe("idle");
  });

  it("does not broadcast a bench-status event when provisioning fails", async () => {
    setupCreateBenchMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "git error",
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("error");
    });

    expect(sseService.broadcastBenchStatus).not.toHaveBeenCalled();
  });

  it("transitions bench to idle with all components stopped and runs no setup at create time", async () => {
    const config = makeConfig({
      components: {
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
          setup: "dotnet restore",
        },
      },
      ports: { backend: { base: 5000 } },
      benches: { max: 5, setup: "npm ci" },
    });
    setupCreateBenchMocks({
      project: makeProject({
        config,
        settings: {
          worktreeSource: { branchFromDefault: false, pullLatest: false },
        },
      }),
    });
    setupProcessMocks();
    vi.mocked(portAllocator.allocatePorts).mockReturnValue({ backend: 5000 });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("idle");
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.backend.status).toBe("stopped");
    expect(bench.components.backend.setupComplete).toBe(false); // setup hasn't run yet
    expect(processManager.startProcess).not.toHaveBeenCalled();
    expect(dockerService.composeUp).not.toHaveBeenCalled();
    // Neither the component setup ("dotnet restore") nor the bench-level setup
    // ("npm ci") should have been invoked at create time.
    const runCommandCalls = vi.mocked(execModule.runCommand).mock.calls;
    expect(runCommandCalls.some((c) => c[0] === "dotnet")).toBe(false);
    expect(runCommandCalls.some((c) => c[0] === "npm")).toBe(false);
  });

  it("retries without -b flag when branch already exists", async () => {
    setupCreateBenchMocks();
    setupProcessMocks();
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "branch already exists",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    benchManager.createBench("test-project", "existing-branch");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const calls = vi.mocked(execModule.runCommand).mock.calls;
    expect(calls[0]).toEqual([
      "git",
      ["worktree", "add", "/home/.roubo/workspaces/test-project/bench-1", "-b", "existing-branch"],
      "/repos/test-project",
    ]);
    expect(calls[1]).toEqual([
      "git",
      ["worktree", "add", "/home/.roubo/workspaces/test-project/bench-1", "existing-branch"],
      "/repos/test-project",
    ]);
  });

  it("initializes submodules for meta-repo structure", async () => {
    const config = makeConfig({
      layout: { type: "meta-repo", submodules: { sub1: "path/to/sub1" } },
    });
    setupCreateBenchMocks({
      project: makeProject({
        config,
        settings: {
          worktreeSource: { branchFromDefault: false, pullLatest: false },
        },
      }),
    });
    setupProcessMocks();
    setupMetaRepoGitmodulesMocks({ sub1: "path/to/sub1" });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(execModule.runCommand).toHaveBeenCalledWith(
        "git",
        ["submodule", "update", "--init", "--recursive"],
        "/home/.roubo/workspaces/test-project/bench-1",
      );
    });
  });

  it("sets error status when workspace creation fails", async () => {
    setupCreateBenchMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "git error",
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("error");
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("error");
    expect(stateService.addBench).not.toHaveBeenCalled();
  });

  it("cleans up workspace on failure when path exists", async () => {
    setupCreateBenchMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "fail",
    });
    vi.mocked(fs.default.existsSync).mockReturnValue(true);

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("error");
    });

    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const cleanupCall = calls.find((c) => c[1][0] === "worktree" && c[1][1] === "remove");
    if (!cleanupCall) throw new Error("expected cleanup call");
    expect(cleanupCall[1]).toEqual([
      "worktree",
      "remove",
      "--force",
      "/home/.roubo/workspaces/test-project/bench-1",
    ]);
  });

  it("cleans up stale worktree directory before creation when path already exists", async () => {
    setupCreateBenchMocks();
    setupProcessMocks();
    // Only the pre-flight existsSync call should return true; subsequent calls
    // (e.g. error-cleanup path) use the default false from setupCreateBenchMocks.
    vi.mocked(fs.default.existsSync).mockReturnValueOnce(true);

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const calls = vi.mocked(execModule.runCommand).mock.calls;
    // Pre-flight cleanup: worktree remove --force (no prune — prune is project-wide
    // and can race against concurrent bench creation)
    expect(calls[0]).toEqual([
      "git",
      ["worktree", "remove", "--force", "/home/.roubo/workspaces/test-project/bench-1"],
      "/repos/test-project",
    ]);
    expect(fs.default.rmSync).toHaveBeenCalledWith("/home/.roubo/workspaces/test-project/bench-1", {
      recursive: true,
      force: true,
    });
    // Bench should end up idle after cleanup (worktree-only create)
    const bench = benchManager.getBench("test-project", 1);
    expect(bench?.status).toBe("idle");
  });

  it("continues pre-flight cleanup via rmSync when worktree remove fails (orphaned directory)", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    setupCreateBenchMocks();
    setupProcessMocks();
    vi.mocked(fs.default.existsSync).mockReturnValueOnce(true);
    // First runCommand call: worktree remove --force fails (path not registered as a worktree)
    vi.mocked(execModule.runCommand).mockResolvedValueOnce({
      code: 128,
      stdout: "",
      stderr: "fatal: '/home/.roubo/workspaces/test-project/bench-1' is not a working tree",
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    // rmSync must still be called to remove the orphaned directory
    expect(fs.default.rmSync).toHaveBeenCalledWith("/home/.roubo/workspaces/test-project/bench-1", {
      recursive: true,
      force: true,
    });
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pre-flight worktree remove failed"),
    );
    // Bench should end up idle despite the failed remove (worktree-only create)
    const bench = benchManager.getBench("test-project", 1);
    expect(bench?.status).toBe("idle");
    debugSpy.mockRestore();
  });

  it("continues after submodule failure with error phase", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig({
      layout: { type: "meta-repo", submodules: { sub1: "path/to/sub1" } },
    });
    setupCreateBenchMocks({
      project: makeProject({
        config,
        settings: {
          worktreeSource: { branchFromDefault: false, pullLatest: false },
        },
      }),
    });
    setupProcessMocks();
    setupMetaRepoGitmodulesMocks({ sub1: "path/to/sub1" });
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // worktree add
      .mockResolvedValueOnce({ code: 0, stdout: "abc1234567890\n", stderr: "" }) // rev-parse HEAD
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "submodule error",
      }); // submodule update

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("done"); // worktree
    expect(bench.provisioningSteps[0].phases).toContainEqual({
      label: "Initializing submodules",
      status: "error",
    });
    // Submodule init error is non-fatal — bench still reaches idle (worktree-only create)
    expect(bench.status).toBe("idle");
  });

  describe("workUnits population", () => {
    it("populates workUnits with root + submodule entries for meta-repo bench", async () => {
      const config = makeConfig({
        layout: {
          type: "meta-repo",
          submodules: { api: "services/api", web: "clients/web" },
        },
      });
      setupCreateBenchMocks({
        project: makeProject({
          config,
          settings: {
            worktreeSource: { branchFromDefault: false, pullLatest: false },
          },
        }),
      });
      setupProcessMocks();
      setupMetaRepoGitmodulesMocks({ api: "services/api", web: "clients/web" });
      vi.mocked(gitHelpers.resolveSubmoduleBranch)
        .mockResolvedValueOnce("feature/api-branch")
        .mockResolvedValueOnce("feature/web-branch");

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        expect(stateService.addBench).toHaveBeenCalled();
      });

      const call = vi.mocked(stateService.addBench).mock.calls[0][0];
      expect(call.workUnits).toHaveLength(3);
      expect(call.workUnits).toContainEqual({
        submodule: ".",
        branch: "bench-1",
        workspacePath: "/home/.roubo/workspaces/test-project/bench-1",
      });
      expect(call.workUnits).toContainEqual({
        submodule: "api",
        branch: "feature/api-branch",
        workspacePath: "/home/.roubo/workspaces/test-project/bench-1/services/api",
      });
      expect(call.workUnits).toContainEqual({
        submodule: "web",
        branch: "feature/web-branch",
        workspacePath: "/home/.roubo/workspaces/test-project/bench-1/clients/web",
      });
    });

    it("workUnits have undefined lastSyncedAt and no pullRequest", async () => {
      const config = makeConfig({
        layout: { type: "meta-repo", submodules: { api: "services/api" } },
      });
      setupCreateBenchMocks({
        project: makeProject({
          config,
          settings: {
            worktreeSource: { branchFromDefault: false, pullLatest: false },
          },
        }),
      });
      setupProcessMocks();
      setupMetaRepoGitmodulesMocks({ api: "services/api" });

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        expect(stateService.addBench).toHaveBeenCalled();
      });

      const call = vi.mocked(stateService.addBench).mock.calls[0][0];
      for (const wu of call.workUnits ?? []) {
        expect(wu.lastSyncedAt).toBeUndefined();
        expect(wu.pullRequest).toBeUndefined();
      }
    });

    it("does NOT set workUnits for single-repo bench", async () => {
      setupCreateBenchMocks();
      setupProcessMocks();

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        expect(stateService.addBench).toHaveBeenCalled();
      });

      const call = vi.mocked(stateService.addBench).mock.calls[0][0];
      expect(call.workUnits).toBeUndefined();
    });

    it("does NOT set workUnits for monorepo bench", async () => {
      const config = makeConfig({ layout: { type: "monorepo" } });
      setupCreateBenchMocks({
        project: makeProject({
          config,
          settings: {
            worktreeSource: { branchFromDefault: false, pullLatest: false },
          },
        }),
      });
      setupProcessMocks();

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        expect(stateService.addBench).toHaveBeenCalled();
      });

      const call = vi.mocked(stateService.addBench).mock.calls[0][0];
      expect(call.workUnits).toBeUndefined();
    });

    it("raises fatal provisioning error when .gitmodules file does not exist", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const config = makeConfig({
        layout: { type: "meta-repo", submodules: { api: "services/api" } },
      });
      setupCreateBenchMocks({
        project: makeProject({
          config,
          settings: {
            worktreeSource: { branchFromDefault: false, pullLatest: false },
          },
        }),
      });
      // existsSync returns false (default from setupCreateBenchMocks) — .gitmodules absent

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        const bench = benchManager.getBench("test-project", 1);
        expect(bench?.status).toBe("error");
      });

      expect(stateService.addBench).not.toHaveBeenCalled();
    });

    it("raises fatal provisioning error when declared submodule missing from .gitmodules", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const config = makeConfig({
        layout: { type: "meta-repo", submodules: { api: "services/api" } },
      });
      setupCreateBenchMocks({
        project: makeProject({
          config,
          settings: {
            worktreeSource: { branchFromDefault: false, pullLatest: false },
          },
        }),
      });
      // .gitmodules exists but contains no matching entry for "api"
      vi.mocked(fs.default.existsSync).mockImplementation(
        (p: unknown) => typeof p === "string" && p.endsWith(".gitmodules"),
      );
      vi.mocked(fs.default.promises.readFile).mockResolvedValue("[submodule]" as any);
      vi.mocked(gitHelpers.parseGitmodulesWithBranch).mockReturnValue({
        other: { path: "other/path" },
      });

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        const bench = benchManager.getBench("test-project", 1);
        expect(bench?.status).toBe("error");
      });

      expect(stateService.addBench).not.toHaveBeenCalled();
    });

    it("raises fatal provisioning error when submodule path in .gitmodules mismatches roubo.yaml", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const config = makeConfig({
        layout: { type: "meta-repo", submodules: { api: "services/api" } },
      });
      setupCreateBenchMocks({
        project: makeProject({
          config,
          settings: {
            worktreeSource: { branchFromDefault: false, pullLatest: false },
          },
        }),
      });
      vi.mocked(fs.default.existsSync).mockImplementation(
        (p: unknown) => typeof p === "string" && p.endsWith(".gitmodules"),
      );
      vi.mocked(fs.default.promises.readFile).mockResolvedValue("[submodule]" as any);
      // "api" is present but has a different path than declared in roubo.yaml
      vi.mocked(gitHelpers.parseGitmodulesWithBranch).mockReturnValue({
        api: { path: "vendor/api" },
      });

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        const bench = benchManager.getBench("test-project", 1);
        expect(bench?.status).toBe("error");
      });

      expect(stateService.addBench).not.toHaveBeenCalled();
    });
  });

  it("emits only the workspace step at create time even when components define setup", () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "apps/web",
          setup: "npm ci",
        },
      },
      ports: { frontend: { base: 3000 } },
    });
    setupCreateBenchMocks({
      project: makeProject({
        config,
        settings: {
          worktreeSource: { branchFromDefault: false, pullLatest: false },
        },
      }),
    });
    setupProcessMocks();
    vi.mocked(portAllocator.allocatePorts).mockReturnValue({ frontend: 3001 });

    const bench = benchManager.createBench("test-project");

    expect(bench.provisioningSteps).toHaveLength(1);
    expect(bench.provisioningSteps[0].id).toBe("workspace");
  });

  describe("permission injection during provisioning", () => {
    it("calls injectPermissions with workspace path and project permissions after bench is persisted", async () => {
      setupCreateBenchMocks();
      setupProcessMocks();
      vi.mocked(stateService.getProjectPermissions).mockReturnValue({
        allow: ["Bash(*)", "Read(*)"],
        deny: [],
      });

      benchManager.createBench("test-project", "my-branch");

      await vi.waitFor(() => {
        expect(stateService.addBench).toHaveBeenCalled();
      });

      expect(vi.mocked(claudeSettingsLocal.injectPermissions)).toHaveBeenCalledWith(
        "/home/.roubo/workspaces/test-project/bench-1",
        {
          allow: ["Bash(*)", "Read(*)"],
          deny: [],
        },
      );
    });

    it("calls injectPermissions with empty allow/deny when project has no permissions", async () => {
      setupCreateBenchMocks();
      setupProcessMocks();
      vi.mocked(stateService.getProjectPermissions).mockReturnValue({
        allow: [],
        deny: [],
      });

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        expect(stateService.addBench).toHaveBeenCalled();
      });

      expect(vi.mocked(claudeSettingsLocal.injectPermissions)).toHaveBeenCalledWith(
        "/home/.roubo/workspaces/test-project/bench-1",
        {
          allow: [],
          deny: [],
        },
      );
    });

    it("continues provisioning and logs a warning when injectPermissions throws", async () => {
      setupCreateBenchMocks();
      setupProcessMocks();
      vi.mocked(stateService.getProjectPermissions).mockReturnValue({
        allow: ["Bash(*)"],
        deny: [],
      });
      vi.mocked(claudeSettingsLocal.injectPermissions).mockImplementation(() => {
        throw new Error("ENOSPC");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        const bench = benchManager.getBench("test-project", 1);
        expect(bench?.status).toBe("idle");
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to inject permissions"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });

  describe("provisioning notifications", () => {
    it("does not emit bench-ready when worktree-only create succeeds (deferred to Start)", async () => {
      setupCreateBenchMocks();
      setupProcessMocks();

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        expect(stateService.addBench).toHaveBeenCalled();
      });

      const calls = vi.mocked(notificationService.createNotification).mock.calls;
      expect(calls.find((c) => c[1] === "bench-ready")).toBeUndefined();
    });

    it("emits bench-error notification when provisioning fails", async () => {
      setupCreateBenchMocks();
      vi.mocked(execModule.runCommand).mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "git error",
      });

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        expect(vi.mocked(notificationService.createNotification)).toHaveBeenCalledWith(
          expect.objectContaining({ id: 1, projectId: "test-project" }),
          "bench-error",
        );
      });
    });

    it("does not emit a notification when startAllComponents runs (non-provisioning)", async () => {
      setupExistingBench();
      setupProcessMocks();

      benchManager.startAllComponents("test-project", 1);

      await vi.waitFor(() => {
        expect(processManager.startProcess).toHaveBeenCalled();
      });

      expect(vi.mocked(notificationService.createNotification)).not.toHaveBeenCalled();
    });
  });

  describe("autoStartComponents global setting", () => {
    beforeEach(() => {
      // Defensively reset injectPermissions in case the
      // "continues provisioning and logs a warning when injectPermissions throws"
      // test (in another describe) leaked a throwing implementation. CI has been
      // observed to run these tests in an order where the leak surfaces, even
      // though restoreMocks/clearAllMocks should otherwise prevent it.
      vi.mocked(claudeSettingsLocal.injectPermissions).mockReset();
    });

    afterEach(() => {
      // Restore the default loadSettings mock so autoStartComponents=true does
      // not leak into later tests. vi.clearAllMocks in the global beforeEach
      // only clears call data, not mockReturnValue.
      vi.mocked(stateService.loadSettings).mockReturnValue({
        theme: "dark",
        benches: {
          autoClear: true,
          enforceIssueDependencies: false,
          workUnitAutoClear: true,
          autoStartComponents: false,
        },
      });
    });

    function autoStartConfig() {
      return makeConfig({
        components: {
          backend: {
            type: "process",
            command: "node server.js",
            setup: "npm install",
          },
        },
        ports: { backend: { base: 5000 } },
        benches: { max: 5, setup: "npm ci" },
      });
    }

    function withAutoStart(value: boolean) {
      vi.mocked(stateService.loadSettings).mockReturnValue({
        theme: "dark",
        benches: {
          autoClear: true,
          enforceIssueDependencies: false,
          workUnitAutoClear: true,
          autoStartComponents: value,
        },
      });
    }

    it("does not run component setup or launch when setting is off (default)", async () => {
      withAutoStart(false);
      setupCreateBenchMocks({
        project: makeProject({
          config: autoStartConfig(),
          settings: { worktreeSource: { branchFromDefault: false, pullLatest: false } },
        }),
      });
      setupProcessMocks();
      vi.mocked(portAllocator.allocatePorts).mockReturnValue({ backend: 5000 });

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        const bench = benchManager.getBench("test-project", 1);
        expect(bench?.status).toBe("idle");
      });

      const bench = benchManager.getBench("test-project", 1);
      if (!bench) throw new Error("expected bench");
      expect(bench.components.backend.setupComplete).toBe(false);
      expect(processManager.startProcess).not.toHaveBeenCalled();
      const runCommandCalls = vi.mocked(execModule.runCommand).mock.calls;
      expect(runCommandCalls.some((c) => c[0] === "npm")).toBe(false);
      expect(bench.provisioningSteps).toHaveLength(1);
    });

    it("runs full provisioning and ends at active when setting is on", async () => {
      withAutoStart(true);
      setupCreateBenchMocks({
        project: makeProject({
          config: autoStartConfig(),
          settings: { worktreeSource: { branchFromDefault: false, pullLatest: false } },
        }),
      });
      setupProcessMocks();
      vi.mocked(portAllocator.allocatePorts).mockReturnValue({ backend: 5000 });
      vi.mocked(processManager.getProcessStatus).mockReturnValue({ alive: true, exitCode: null });
      vi.mocked(processManager.getProcessPid).mockReturnValue(123);

      benchManager.createBench("test-project");

      // Wait for bench to reach "active" AND for both bench-setup ("npm ci") and
      // component-setup ("npm install") commands to have been issued. CI was
      // observed to occasionally see "active" before the for-loop's await
      // boundaries had settled — waiting on the runCommand mock directly is a
      // stronger sync point than just bench.status.
      await vi.waitFor(() => {
        const bench = benchManager.getBench("test-project", 1);
        expect(bench?.status).toBe("active");
        const calls = vi.mocked(execModule.runCommand).mock.calls;
        expect(calls.some((c) => c[0] === "npm" && c[1]?.[0] === "ci")).toBe(true);
        expect(calls.some((c) => c[0] === "npm" && c[1]?.[0] === "install")).toBe(true);
      });

      const bench = benchManager.getBench("test-project", 1);
      if (!bench) throw new Error("expected bench");
      expect(bench.components.backend.setupComplete).toBe(true);
      expect(processManager.startProcess).toHaveBeenCalled();
      const runCommandCalls = vi.mocked(execModule.runCommand).mock.calls;
      expect(runCommandCalls.some((c) => c[0] === "npm" && c[1]?.[0] === "ci")).toBe(true);
      expect(runCommandCalls.some((c) => c[0] === "npm" && c[1]?.[0] === "install")).toBe(true);
      expect(bench.provisioningSteps.length).toBeGreaterThan(1);
      expect(bench.provisioningSteps.some((s) => s.id.startsWith("component:"))).toBe(true);
    });

    it("does not chain into component startup when bench is torn down during worktree provisioning", async () => {
      withAutoStart(true);
      setupCreateBenchMocks({
        project: makeProject({
          config: autoStartConfig(),
          settings: { worktreeSource: { branchFromDefault: false, pullLatest: false } },
        }),
      });
      setupProcessMocks();
      vi.mocked(portAllocator.allocatePorts).mockReturnValue({ backend: 5000 });
      // Make the very first runCommand hang so worktree provisioning sits on
      // its first await while we trigger teardown from the test.
      vi.mocked(execModule.runCommand).mockImplementation(() => new Promise(() => {}));

      benchManager.createBench("test-project");

      // Reset runCommand so teardown's git cleanup calls can complete.
      vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      benchManager.teardownBench("test-project", 1);

      // Flush microtasks so runCreateBenchBackground sees the "clearing" status
      // and bails before chaining into runComponentsInOrder.
      await new Promise((r) => setTimeout(r, 0));

      expect(processManager.startProcess).not.toHaveBeenCalled();
      const runCommandCalls = vi.mocked(execModule.runCommand).mock.calls;
      // The component-setup ("npm install") and bench-setup ("npm ci") commands
      // must not have run, even though autoStartComponents is on, because
      // teardown took precedence.
      expect(runCommandCalls.some((c) => c[0] === "npm" && c[1]?.[0] === "install")).toBe(false);
      expect(runCommandCalls.some((c) => c[0] === "npm" && c[1]?.[0] === "ci")).toBe(false);
    });

    it("does not run component setup when worktree provisioning fails, even if setting is on", async () => {
      withAutoStart(true);
      setupCreateBenchMocks({
        project: makeProject({
          config: autoStartConfig(),
          settings: { worktreeSource: { branchFromDefault: false, pullLatest: false } },
        }),
      });
      setupProcessMocks();
      vi.mocked(portAllocator.allocatePorts).mockReturnValue({ backend: 5000 });
      vi.mocked(execModule.runCommand).mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "git error",
      });

      benchManager.createBench("test-project");

      await vi.waitFor(() => {
        const bench = benchManager.getBench("test-project", 1);
        expect(bench?.status).toBe("error");
      });

      expect(processManager.startProcess).not.toHaveBeenCalled();
      const runCommandCalls = vi.mocked(execModule.runCommand).mock.calls;
      expect(runCommandCalls.some((c) => c[0] === "npm")).toBe(false);
    });
  });
});

describe("background provisioning — worktreeSource R3 combinations", () => {
  const SETTINGS_R1_OFF_R2_OFF = {
    worktreeSource: { branchFromDefault: false, pullLatest: false },
  };
  const SETTINGS_R1_ON_R2_OFF = {
    worktreeSource: { branchFromDefault: true, pullLatest: false },
  };
  const SETTINGS_R1_OFF_R2_ON = {
    worktreeSource: { branchFromDefault: false, pullLatest: true },
  };
  const SETTINGS_R1_ON_R2_ON = {
    worktreeSource: { branchFromDefault: true, pullLatest: true },
  };

  it("R1=off R2=off: branches from current HEAD with no fetch/ff sub-phases", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_OFF_R2_OFF }),
    });
    setupProcessMocks();

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("done");
    // No sub-phases at all when both R1 and R2 are off
    const phases = bench.provisioningSteps[0].phases;
    expect(phases).toBeFalsy();

    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const fetchCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "fetch");
    const mergeCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "merge");
    expect(fetchCall).toBeUndefined();
    expect(mergeCall).toBeUndefined();

    // Worktree add must NOT pass a base branch arg
    const worktreeCall = calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add",
    );
    expect(worktreeCall).toEqual([
      "git",
      ["worktree", "add", "/home/.roubo/workspaces/test-project/bench-1", "-b", "bench-1"],
      "/repos/test-project",
    ]);
  });

  it("R1=on R2=off: branches from resolved default with no fetch/ff sub-phases", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_ON_R2_OFF }),
    });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (
        Array.isArray(args) &&
        args[0] === "symbolic-ref" &&
        args[1] === "refs/remotes/origin/HEAD"
      ) {
        return Promise.resolve({
          code: 0,
          stdout: "refs/remotes/origin/main\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("done");

    // "Resolving default branch" sub-phase is present and done; no fetch/ff phases
    const phases = bench.provisioningSteps[0].phases;
    if (!phases) throw new Error("expected phases");
    expect(phases).toContainEqual({
      label: RESOLVE_DEFAULT_BRANCH_PHASE,
      status: "done",
    });
    const fetchPhase = phases.find((p) => p.label.startsWith("Fetching"));
    expect(fetchPhase).toBeUndefined();

    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const fetchCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "fetch");
    const mergeCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "merge");
    expect(fetchCall).toBeUndefined();
    expect(mergeCall).toBeUndefined();

    // Worktree add must pass the resolved default branch as the base arg
    const worktreeCall = calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add",
    );
    expect(worktreeCall).toEqual([
      "git",
      ["worktree", "add", "/home/.roubo/workspaces/test-project/bench-1", "-b", "bench-1", "main"],
      "/repos/test-project",
    ]);
  });

  it("R1=off R2=on: fetches and fast-forwards current HEAD branch", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_OFF_R2_ON }),
    });
    setupProcessMocks();
    // Ensure no ENOSPC throw leaks in from the "injectPermissions throws" test in another describe.
    vi.mocked(claudeSettingsLocal.injectPermissions).mockReturnValue(undefined);
    vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("feature/x");

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("done");

    const phases = bench.provisioningSteps[0].phases;
    if (!phases) throw new Error("expected phases");
    expect(phases).toContainEqual({
      label: "Fetching origin/feature/x",
      status: "done",
    });
    expect(phases).toContainEqual({
      label: "Fast-forwarding feature/x",
      status: "done",
    });
    // Fetch phase comes before ff phase
    const fetchIdx = phases.findIndex((p) => p.label === "Fetching origin/feature/x");
    const ffIdx = phases.findIndex((p) => p.label === "Fast-forwarding feature/x");
    expect(fetchIdx).toBeLessThan(ffIdx);

    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const fetchCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "fetch");
    expect(fetchCall).toEqual([
      "git",
      ["fetch", "origin", "feature/x"],
      "/repos/test-project",
      undefined,
      60_000,
    ]);
    const mergeCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "merge");
    expect(mergeCall).toEqual([
      "git",
      ["merge", "--ff-only", "origin/feature/x"],
      "/repos/test-project",
      undefined,
      60_000,
    ]);
  });

  it("R1=on R2=on: fetches and fast-forwards resolved default branch", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_ON_R2_ON }),
    });
    setupProcessMocks();
    // Ensure no ENOSPC throw leaks in from the "injectPermissions throws" test in another describe.
    vi.mocked(claudeSettingsLocal.injectPermissions).mockReturnValue(undefined);
    vi.mocked(gitHelpers.resolveDefaultBranch).mockResolvedValue("main");

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("done");

    const phases = bench.provisioningSteps[0].phases;
    if (!phases) throw new Error("expected phases");
    expect(phases).toContainEqual({
      label: RESOLVE_DEFAULT_BRANCH_PHASE,
      status: "done",
    });
    expect(phases).toContainEqual({
      label: "Fetching origin/main",
      status: "done",
    });
    expect(phases).toContainEqual({
      label: "Fast-forwarding main",
      status: "done",
    });
    // Phase order: resolve → fetch → ff
    const resolveIdx = phases.findIndex((p) => p.label === RESOLVE_DEFAULT_BRANCH_PHASE);
    const fetchIdx = phases.findIndex((p) => p.label === "Fetching origin/main");
    const ffIdx = phases.findIndex((p) => p.label === "Fast-forwarding main");
    expect(resolveIdx).toBeLessThan(fetchIdx);
    expect(fetchIdx).toBeLessThan(ffIdx);

    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const fetchCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "fetch");
    expect(fetchCall).toEqual([
      "git",
      ["fetch", "origin", "main"],
      "/repos/test-project",
      undefined,
      60_000,
    ]);
    const mergeCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "merge");
    expect(mergeCall).toEqual([
      "git",
      ["merge", "--ff-only", "origin/main"],
      "/repos/test-project",
      undefined,
      60_000,
    ]);

    // Worktree add must pass the resolved default branch as the base arg
    const worktreeCall = calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add",
    );
    expect(worktreeCall).toEqual([
      "git",
      ["worktree", "add", "/home/.roubo/workspaces/test-project/bench-1", "-b", "bench-1", "main"],
      "/repos/test-project",
    ]);
  });

  it("fetch failure: sets bench error naming the branch, no worktree created", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_ON_R2_ON }),
    });
    vi.mocked(gitHelpers.resolveDefaultBranch).mockResolvedValue("main");
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === "fetch") {
        return Promise.resolve({ code: 1, stdout: "", stderr: "network down" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("error");
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("error");
    expect(bench.error).toContain("main");
    expect(bench.error).toContain("network down");

    // Fetch phase is error; ff phase still pending
    const phases = bench.provisioningSteps[0].phases;
    if (!phases) throw new Error("expected phases");
    expect(phases).toContainEqual({
      label: "Fetching origin/main",
      status: "error",
    });
    expect(phases).toContainEqual({
      label: "Fast-forwarding main",
      status: "pending",
    });

    // No worktree created and no merge attempted
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const worktreeCall = calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add",
    );
    expect(worktreeCall).toBeUndefined();
    const mergeCall = calls.find((c) => Array.isArray(c[1]) && c[1][0] === "merge");
    expect(mergeCall).toBeUndefined();

    // workspace was never persisted
    expect(stateService.addBench).not.toHaveBeenCalled();
  });

  it("non-ff merge: sets exact PRD error message naming the branch", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_ON_R2_ON }),
    });
    vi.mocked(gitHelpers.resolveDefaultBranch).mockResolvedValue("main");
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === "merge") {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "Not possible to fast-forward",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("error");
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("error");
    expect(bench.error).toBe(
      "Could not fast-forward 'main' — your local branch has diverged from origin/main. " +
        "Resolve manually in the source repo, or disable 'Pull latest' in project settings.",
    );

    // Fetch phase done, ff phase error
    const phases = bench.provisioningSteps[0].phases;
    if (!phases) throw new Error("expected phases");
    expect(phases).toContainEqual({
      label: "Fetching origin/main",
      status: "done",
    });
    expect(phases).toContainEqual({
      label: "Fast-forwarding main",
      status: "error",
    });

    // No worktree created
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const worktreeCall = calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add",
    );
    expect(worktreeCall).toBeUndefined();
    expect(stateService.addBench).not.toHaveBeenCalled();
  });

  it("fetch failure before worktree add: no workspace directory created", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_ON_R2_ON }),
    });
    vi.mocked(gitHelpers.resolveDefaultBranch).mockResolvedValue("main");
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === "fetch") {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "fatal: remote not found",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("error");
    });

    // mkdirSync was never called — workspace parent was never created
    expect(vi.mocked(fs.default.mkdirSync)).not.toHaveBeenCalled();

    // worktree add was never called
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const worktreeCall = calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add",
    );
    expect(worktreeCall).toBeUndefined();
  });

  it("meta-repo + R2=on: fetch/ff phases appear before submodules phase", async () => {
    const config = makeConfig({
      layout: { type: "meta-repo", submodules: { sub1: "path/to/sub1" } },
    });
    setupCreateBenchMocks({
      project: makeProject({ config, settings: SETTINGS_R1_ON_R2_ON }),
    });
    setupProcessMocks();
    setupMetaRepoGitmodulesMocks({ sub1: "path/to/sub1" });
    vi.mocked(gitHelpers.resolveDefaultBranch).mockResolvedValue("main");

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("done");

    const phases = bench.provisioningSteps[0].phases;
    if (!phases) throw new Error("expected phases");

    const resolveIdx = phases.findIndex((p) => p.label === RESOLVE_DEFAULT_BRANCH_PHASE);
    const fetchIdx = phases.findIndex((p) => p.label === "Fetching origin/main");
    const ffIdx = phases.findIndex((p) => p.label === "Fast-forwarding main");
    const subIdx = phases.findIndex((p) => p.label === "Initializing submodules");

    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(ffIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeGreaterThanOrEqual(0);

    // Phase order: resolve → fetch → ff → submodules
    expect(resolveIdx).toBeLessThan(fetchIdx);
    expect(fetchIdx).toBeLessThan(ffIdx);
    expect(ffIdx).toBeLessThan(subIdx);
  });

  it("meta-repo + R2=on: runs git submodule update --init --remote --recursive in source repo", async () => {
    const config = makeConfig({
      layout: { type: "meta-repo", submodules: { sub1: "path/to/sub1" } },
    });
    setupCreateBenchMocks({
      project: makeProject({ config, settings: SETTINGS_R1_ON_R2_ON }),
    });
    setupProcessMocks();
    setupMetaRepoGitmodulesMocks({ sub1: "path/to/sub1" });
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (
        Array.isArray(args) &&
        args[0] === "symbolic-ref" &&
        args[1] === "refs/remotes/origin/HEAD"
      ) {
        return Promise.resolve({
          code: 0,
          stdout: "refs/remotes/origin/main\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    // The --remote submodule update must be called in the source repo with the correct args and timeout
    expect(vi.mocked(execModule.runCommand)).toHaveBeenCalledWith(
      "git",
      ["submodule", "update", "--init", "--remote", "--recursive"],
      "/repos/test-project",
      undefined,
      300_000,
    );

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.provisioningSteps[0].status).toBe("done");

    const phases = bench.provisioningSteps[0].phases;
    if (!phases) throw new Error("expected phases");

    // New phase is present and done
    expect(phases).toContainEqual({
      label: "Updating submodules to latest",
      status: "done",
    });

    // Phase ordering: ff < new remote phase < existing in-worktree init
    const ffIdx = phases.findIndex((p) => p.label === "Fast-forwarding main");
    const newRemoteIdx = phases.findIndex((p) => p.label === "Updating submodules to latest");
    const subInitIdx = phases.findIndex((p) => p.label === "Initializing submodules");

    expect(ffIdx).toBeGreaterThanOrEqual(0);
    expect(newRemoteIdx).toBeGreaterThanOrEqual(0);
    expect(subInitIdx).toBeGreaterThanOrEqual(0);
    expect(ffIdx).toBeLessThan(newRemoteIdx);
    expect(newRemoteIdx).toBeLessThan(subInitIdx);

    // Ordering of actual calls: merge --ff-only before submodule update --remote before worktree add
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const mergeCallIdx = calls.findIndex((c) => Array.isArray(c[1]) && c[1][0] === "merge");
    const subRemoteCallIdx = calls.findIndex(
      (c) => Array.isArray(c[1]) && c[1].includes("--remote"),
    );
    const worktreeCallIdx = calls.findIndex(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add",
    );

    expect(mergeCallIdx).toBeLessThan(subRemoteCallIdx);
    expect(subRemoteCallIdx).toBeLessThan(worktreeCallIdx);
  });

  it("meta-repo + R2=off: skips submodule remote update even for meta-repo", async () => {
    const config = makeConfig({
      layout: { type: "meta-repo", submodules: { sub1: "path/to/sub1" } },
    });
    setupCreateBenchMocks({
      project: makeProject({ config, settings: SETTINGS_R1_OFF_R2_OFF }),
    });
    setupProcessMocks();
    setupMetaRepoGitmodulesMocks({ sub1: "path/to/sub1" });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const calls = vi.mocked(execModule.runCommand).mock.calls;

    // --remote flag must NOT appear in any call
    const subRemoteCall = calls.find((c) => Array.isArray(c[1]) && c[1].includes("--remote"));
    expect(subRemoteCall).toBeUndefined();

    // The in-worktree submodule init (no --remote) should still run
    const subInitCall = calls.find(
      (c) =>
        Array.isArray(c[1]) &&
        c[1][0] === "submodule" &&
        c[1].includes("--init") &&
        !c[1].includes("--remote"),
    );
    expect(subInitCall).toBeDefined();
  });

  it("non-meta-repo + R2=on: skips submodule remote update", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_ON_R2_ON }),
    });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (
        Array.isArray(args) &&
        args[0] === "symbolic-ref" &&
        args[1] === "refs/remotes/origin/HEAD"
      ) {
        return Promise.resolve({
          code: 0,
          stdout: "refs/remotes/origin/main\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    // Fetch and ff did run
    expect(vi.mocked(execModule.runCommand)).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["fetch"]),
      "/repos/test-project",
      undefined,
      60_000,
    );

    // --remote flag must NOT appear in any call
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const subRemoteCall = calls.find((c) => Array.isArray(c[1]) && c[1].includes("--remote"));
    expect(subRemoteCall).toBeUndefined();
  });

  it("meta-repo + R2=on: submodule remote update failure is fatal, no worktree created", async () => {
    const config = makeConfig({
      layout: { type: "meta-repo", submodules: { sub1: "path/to/sub1" } },
    });
    setupCreateBenchMocks({
      project: makeProject({ config, settings: SETTINGS_R1_ON_R2_ON }),
    });
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (
        Array.isArray(args) &&
        args[0] === "symbolic-ref" &&
        args[1] === "refs/remotes/origin/HEAD"
      ) {
        return Promise.resolve({
          code: 0,
          stdout: "refs/remotes/origin/main\n",
          stderr: "",
        });
      }
      if (Array.isArray(args) && args.includes("--remote")) {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "fatal: Unable to fetch in submodule path 'libs/foo'\nfatal: could not fetch",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("error");
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");

    // bench.error names the failing submodule and is actionable
    expect(bench.error).toContain("libs/foo");
    expect(bench.error).toContain("Pull latest");

    // workspace step is error
    expect(bench.provisioningSteps[0].status).toBe("error");

    const phases = bench.provisioningSteps[0].phases;
    if (!phases) throw new Error("expected phases");

    // New phase is error; fetch/ff are done
    expect(phases).toContainEqual({
      label: "Updating submodules to latest",
      status: "error",
    });
    expect(phases).toContainEqual({
      label: "Fetching origin/main",
      status: "done",
    });
    expect(phases).toContainEqual({
      label: "Fast-forwarding main",
      status: "done",
    });

    // In-worktree init phase never ran — still pending
    expect(phases).toContainEqual({
      label: "Initializing submodules",
      status: "pending",
    });

    // No worktree created and bench never persisted
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const worktreeCall = calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add",
    );
    expect(worktreeCall).toBeUndefined();
    expect(stateService.addBench).not.toHaveBeenCalled();

    // Workspace directory was never created
    expect(vi.mocked(fs.default.mkdirSync)).not.toHaveBeenCalled();
  });

  it("symbolic-ref failure when R1=on: marks sub-phase + workspace step error, no worktree left behind", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_ON_R2_OFF }),
    });
    vi.mocked(gitHelpers.resolveDefaultBranch).mockRejectedValue(
      new Error(DEFAULT_BRANCH_RESOLUTION_ERROR),
    );

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(benchManager.getBench("test-project", 1)?.status).toBe("error");
    });

    const bench2 = benchManager.getBench("test-project", 1);
    if (!bench2) throw new Error("expected bench");
    expect(bench2.provisioningSteps[0].status).toBe("error");
    expect(bench2.error).toBe(DEFAULT_BRANCH_RESOLUTION_ERROR);

    // "Resolving default branch" sub-phase is marked error
    const phases2 = bench2.provisioningSteps[0].phases;
    if (!phases2) throw new Error("expected phases");
    expect(phases2).toContainEqual({
      label: RESOLVE_DEFAULT_BRANCH_PHASE,
      status: "error",
    });

    // No workspace directory created, no worktree add, no persist
    expect(vi.mocked(fs.default.mkdirSync)).not.toHaveBeenCalled();
    const calls2 = vi.mocked(execModule.runCommand).mock.calls;
    expect(
      calls2.find((c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "add"),
    ).toBeUndefined();
    expect(stateService.addBench).not.toHaveBeenCalled();
  });

  it("R1=on: sets baseBranch to the resolved default branch and captures baseCommit", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_ON_R2_OFF }),
    });
    setupProcessMocks();
    vi.mocked(claudeSettingsLocal.injectPermissions).mockReturnValue(undefined);
    vi.mocked(gitHelpers.resolveDefaultBranch).mockResolvedValue("main");
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "abc1234567890\n",
      stderr: "",
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.baseBranch).toBe("main");
    expect(bench.baseCommit).toBe("abc1234");
  });

  it("captures baseBranch and baseCommit on bench after worktree creation (R1=off R2=off)", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_OFF_R2_OFF }),
    });
    setupProcessMocks();
    vi.mocked(claudeSettingsLocal.injectPermissions).mockReturnValue(undefined);
    vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("main");
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === "rev-parse" && args[1] === "HEAD") {
        return Promise.resolve({
          code: 0,
          stdout: "abc1234567890\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.baseBranch).toBe("main");
    expect(bench.baseCommit).toBe("abc1234");

    expect(stateService.addBench).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "main", baseCommit: "abc1234" }),
    );
  });

  it("R1=off: leaves baseBranch undefined and warns when resolveHeadBranch throws (detached HEAD)", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_OFF_R2_OFF }),
    });
    setupProcessMocks();
    vi.mocked(claudeSettingsLocal.injectPermissions).mockReturnValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(gitHelpers.resolveHeadBranch).mockRejectedValue(new Error("HEAD is detached"));

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.baseBranch).toBeUndefined();
    expect(bench.provisioningSteps[0].status).toBe("done");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve base branch for bench 1"),
    );

    warnSpy.mockRestore();
  });

  it("leaves baseCommit undefined and warns when rev-parse fails", async () => {
    setupCreateBenchMocks({
      project: makeProject({ settings: SETTINGS_R1_OFF_R2_OFF }),
    });
    setupProcessMocks();
    vi.mocked(claudeSettingsLocal.injectPermissions).mockReturnValue(undefined);
    vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("main");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execModule.runCommand).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === "rev-parse" && args[1] === "HEAD") {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "not a git repo",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    benchManager.createBench("test-project");

    await vi.waitFor(() => {
      expect(stateService.addBench).toHaveBeenCalled();
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.baseBranch).toBe("main");
    expect(bench.baseCommit).toBeUndefined();
    expect(bench.provisioningSteps[0].status).toBe("done");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve base commit for bench 1"),
    );

    warnSpy.mockRestore();
  });
});

describe("teardownBench", () => {
  // Helper to flush the background teardown promise chain
  const flushBackground = () => new Promise((r) => setTimeout(r, 0));

  it("returns bench with teardownSteps and status stopping", () => {
    setupExistingBench();
    setupProcessMocks();

    const bench = benchManager.teardownBench("test-project", 1);

    expect(bench.status).toBe("clearing");
    expect(bench.teardownSteps.length).toBeGreaterThan(0);
    expect(bench.teardownSteps.every((s) => s.status === "pending")).toBe(true);
  });

  it("stops all processes and docker services", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
        },
      },
    });
    setupExistingBench({ config, ports: { db: 5432, backend: 5001 } });
    setupProcessMocks();
    setupDockerServiceMocks();

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(processManager.stopProcess).not.toHaveBeenCalledWith("test-project-bench-1-db");
    expect(processManager.stopProcess).toHaveBeenCalledWith("test-project-bench-1-backend");
    expect(dockerService.composeDown).toHaveBeenCalled();
  });

  it("removes worktree and branch when removeWorktree=true", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(fs.default.existsSync).mockReturnValue(true);
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: "worktree /home/.roubo/workspaces/test-project/bench-1\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    benchManager.teardownBench("test-project", 1, true);
    await flushBackground();

    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/home/.roubo/workspaces/test-project/bench-1"],
      "/repos/test-project",
    );
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["branch", "-D", "bench-1"],
      "/repos/test-project",
    );
  });

  it("keeps workspace when removeWorkspace=false", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    benchManager.teardownBench("test-project", 1, false);
    await flushBackground();

    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const workspaceRemoveCalls = calls.filter(
      (c) => c[1].includes("workspace") && c[1].includes("remove"),
    );
    expect(workspaceRemoveCalls).toHaveLength(0);
  });

  it("removes bench from state and memory after background completes", async () => {
    setupExistingBench();
    setupProcessMocks();

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
    expect(benchManager.getBench("test-project", 1)).toBeUndefined();
  });

  it("marks all teardown steps as done after successful teardown", async () => {
    setupExistingBench();
    setupProcessMocks();

    const bench = benchManager.teardownBench("test-project", 1);
    await flushBackground();

    // Bench is removed from memory but we still hold a reference
    for (const step of bench.teardownSteps) {
      expect(step.status).toBe("done");
    }
  });

  it("throws NOT_FOUND for unknown bench", () => {
    expect(() => benchManager.teardownBench("test-project", 99)).toThrow();
    try {
      benchManager.teardownBench("test-project", 99);
    } catch (err) {
      expect((err as any).code).toBe("NOT_FOUND");
    }
  });

  it("returns existing bench when teardown already in progress", async () => {
    setupExistingBench();
    setupProcessMocks();
    // Make stopProcess hang so teardown stays in progress
    vi.mocked(processManager.stopProcess).mockImplementation(() => new Promise(() => {}));

    const first = benchManager.teardownBench("test-project", 1);
    const second = benchManager.teardownBench("test-project", 1);

    expect(second).toBe(first);
  });

  it("marks provisioning steps as cancelled when tearing down during provisioning", async () => {
    setupCreateBenchMocks();
    setupProcessMocks();
    // Make workspace creation hang so we can teardown mid-provisioning
    vi.mocked(execModule.runCommand).mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    const bench = benchManager.createBench("test-project");
    expect(bench.status).toBe("preparing");

    // Reset runCommand so teardown's git cleanup calls can complete
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    // Bench should be removed
    expect(benchManager.getBench("test-project", 1)).toBeUndefined();
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);

    // Steps should have been marked cancelled before removal
    // (We verify via the bench object we still hold a reference to)
    for (const step of bench.provisioningSteps) {
      expect(step.status).toBe("cancelled");
    }
  });

  it("removes workspace when tearing down during provisioning", async () => {
    setupCreateBenchMocks();
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockImplementation(() => new Promise(() => {}));

    benchManager.createBench("test-project");

    // Override runCommand for teardown to resolve; report workspace as registered
    vi.mocked(fs.default.existsSync).mockReturnValue(true);
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: "worktree /home/.roubo/workspaces/test-project/bench-1\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    benchManager.teardownBench("test-project", 1, true);
    await flushBackground();

    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/home/.roubo/workspaces/test-project/bench-1"],
      "/repos/test-project",
    );
  });

  it("populates correct teardown steps based on config", () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
        },
      },
    });
    setupExistingBench({ config, ports: { db: 5432, backend: 5001 } });
    setupProcessMocks();
    setupDockerServiceMocks();

    const bench = benchManager.teardownBench("test-project", 1, true);

    const stepIds = bench.teardownSteps.map((s) => s.id);
    expect(stepIds).toContain("terminals");
    expect(stepIds).toContain("stop-components");
    expect(stepIds).toContain("docker-down");
    expect(stepIds).toContain("save-permissions");
    expect(stepIds).toContain("remove-workspace");
    expect(stepIds).toContain("cleanup");
  });

  it("omits docker-down step when no docker services", () => {
    setupExistingBench();
    setupProcessMocks();

    const bench = benchManager.teardownBench("test-project", 1);

    const stepIds = bench.teardownSteps.map((s) => s.id);
    expect(stepIds).not.toContain("docker-down");
  });

  it("omits remove-workspace step when removeWorkspace=false", () => {
    setupExistingBench();
    setupProcessMocks();

    const bench = benchManager.teardownBench("test-project", 1, false);

    const stepIds = bench.teardownSteps.map((s) => s.id);
    expect(stepIds).not.toContain("remove-workspace");
  });

  it("always includes save-permissions step", () => {
    setupExistingBench();
    setupProcessMocks();

    const bench = benchManager.teardownBench("test-project", 1);

    const stepIds = bench.teardownSteps.map((s) => s.id);
    expect(stepIds).toContain("save-permissions");
  });

  it("save-permissions step appears before remove-workspace", () => {
    setupExistingBench();
    setupProcessMocks();

    const bench = benchManager.teardownBench("test-project", 1, true);

    const stepIds = bench.teardownSteps.map((s) => s.id);
    const saveIdx = stepIds.indexOf("save-permissions");
    const removeIdx = stepIds.indexOf("remove-workspace");
    expect(saveIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(removeIdx);
  });

  it("transitions bench to error state when worktree remove fails", async () => {
    setupExistingBench();
    setupProcessMocks();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Directory exists on disk and worktree is registered, but remove fails (e.g. locked)
    vi.mocked(fs.default.existsSync).mockReturnValue(true);
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: "worktree /home/.roubo/workspaces/test-project/bench-1\n",
          stderr: "",
        };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return { code: 128, stdout: "", stderr: "fatal: worktree is locked" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const bench = benchManager.teardownBench("test-project", 1, true);
    await flushBackground();

    expect(bench.status).toBe("error");
    expect(bench.error).toMatch(/Teardown failed/);
    expect(bench.error).toMatch(/worktree remove/);
    const removeStep = bench.teardownSteps.find((s) => s.id === "remove-workspace");
    expect(removeStep?.status).toBe("error");
    expect(removeStep?.error).toMatch(/worktree remove/);
    expect(errorSpy.mock.calls[0][0]).toContain("bench 1");
    expect(errorSpy.mock.calls[0][0]).toContain("/home/.roubo/workspaces/test-project/bench-1");
    expect(errorSpy.mock.calls[0][0]).toContain("worktree remove");
    expect(stateService.removeBench).not.toHaveBeenCalled();
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      "bench-error",
    );
    expect(benchManager.getBench("test-project", 1)).toBeDefined();
    errorSpy.mockRestore();
  });

  it("transitions bench to error state when branch delete fails", async () => {
    setupExistingBench();
    setupProcessMocks();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Directory exists on disk and worktree is registered; remove succeeds but branch is checked out elsewhere
    vi.mocked(fs.default.existsSync).mockReturnValue(true);
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: "worktree /home/.roubo/workspaces/test-project/bench-1\n",
          stderr: "",
        };
      }
      if (args[0] === "branch" && args[1] === "-D") {
        return {
          code: 1,
          stdout: "",
          stderr: "error: Cannot delete branch 'bench-1' checked out at '/repos/test-project'",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const bench = benchManager.teardownBench("test-project", 1, true);
    await flushBackground();

    expect(bench.status).toBe("error");
    expect(bench.error).toMatch(/Teardown failed/);
    expect(bench.error).toMatch(/branch -D/);
    const removeStep = bench.teardownSteps.find((s) => s.id === "remove-workspace");
    expect(removeStep?.status).toBe("error");
    expect(removeStep?.error).toMatch(/branch -D/);
    expect(errorSpy.mock.calls[0][0]).toContain("branch -D");
    expect(stateService.removeBench).not.toHaveBeenCalled();
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      "bench-error",
    );
    expect(benchManager.getBench("test-project", 1)).toBeDefined();
    errorSpy.mockRestore();
  });

  it("succeeds when worktree directory is missing on disk (stale metadata)", async () => {
    setupExistingBench();
    setupProcessMocks();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Directory is gone but git still has the worktree registered
    vi.mocked(fs.default.existsSync).mockReturnValue(false);
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: "worktree /home/.roubo/workspaces/test-project/bench-1\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const bench = benchManager.teardownBench("test-project", 1, true);
    await flushBackground();

    // Teardown should complete, not get stuck
    expect(bench.status).not.toBe("error");
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
    expect(benchManager.getBench("test-project", 1)).toBeUndefined();
    const removeStep = bench.teardownSteps.find((s) => s.id === "remove-workspace");
    expect(removeStep?.status).toBe("done");
    const cleanupStep = bench.teardownSteps.find((s) => s.id === "cleanup");
    expect(cleanupStep?.status).toBe("done");
    // Recovery path should use targeted remove, not project-wide prune
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const removeCalls = calls.filter((c) => c[1][0] === "worktree" && c[1][1] === "remove");
    expect(removeCalls).toHaveLength(1);
    const pruneCalls = calls.filter((c) => c[1][0] === "worktree" && c[1][1] === "prune");
    expect(pruneCalls).toHaveLength(0);
    // Recovery path should not log any errors
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("succeeds when branch is already deleted", async () => {
    setupExistingBench();
    setupProcessMocks();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fs.default.existsSync).mockReturnValue(true);
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: "worktree /home/.roubo/workspaces/test-project/bench-1\n",
          stderr: "",
        };
      }
      if (args[0] === "branch" && args[1] === "-D") {
        return {
          code: 1,
          stdout: "",
          stderr: "error: branch 'bench-1' not found",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const bench = benchManager.teardownBench("test-project", 1, true);
    await flushBackground();

    // "branch not found" is tolerated — teardown completes without logging an error
    expect(bench.status).not.toBe("error");
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
    expect(benchManager.getBench("test-project", 1)).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("succeeds when workspace is an orphaned directory not registered as a worktree", async () => {
    setupExistingBench();
    setupProcessMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Directory exists on disk but is no longer tracked as a worktree
    vi.mocked(fs.default.existsSync).mockReturnValue(true);
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        // Workspace path is NOT in the list; include a path that is a prefix of
        // the bench path to ensure we use an exact line match, not a substring check
        return {
          code: 0,
          stdout: "worktree /home/.roubo/workspaces/test-project/bench-10\nHEAD abc123\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const bench = benchManager.teardownBench("test-project", 1, true);
    await flushBackground();

    expect(bench.status).not.toBe("error");
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
    expect(benchManager.getBench("test-project", 1)).toBeUndefined();
    // Should rm the orphaned directory, not call worktree remove
    expect(fs.default.rmSync).toHaveBeenCalledWith("/home/.roubo/workspaces/test-project/bench-1", {
      recursive: true,
      force: true,
    });
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const removeCalls = calls.filter((c) => c[1][0] === "worktree" && c[1][1] === "remove");
    expect(removeCalls).toHaveLength(0);
    // rmSync should have succeeded cleanly — no warnings
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to worktree remove --force when worktree list fails", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 128,
          stdout: "",
          stderr: "fatal: not a git repository",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const bench = benchManager.teardownBench("test-project", 1, true);
    await flushBackground();

    expect(bench.status).not.toBe("error");
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
    expect(benchManager.getBench("test-project", 1)).toBeUndefined();
    // Should fall back to worktree remove --force, not rmSync
    const calls = vi.mocked(execModule.runCommand).mock.calls;
    const removeCalls = calls.filter((c) => c[1][0] === "worktree" && c[1][1] === "remove");
    expect(removeCalls).toHaveLength(1);
    expect(fs.default.rmSync).not.toHaveBeenCalled();
    // Branch deletion must still run even when the list check fails
    const branchCalls = calls.filter((c) => c[1][0] === "branch" && c[1][1] === "-D");
    expect(branchCalls).toHaveLength(1);
  });
});

describe("extractWorkspacePermissions via teardown", () => {
  const flushBackground = () => new Promise((r) => setTimeout(r, 0));

  it("merges extracted permissions into project master list", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(fs.default.readFileSync).mockReturnValue(
      JSON.stringify({ permissions: { allow: ["Bash(npm:*)"] } }),
    );
    vi.mocked(stateService.getProjectPermissions).mockReturnValue({
      allow: ["Read"],
      deny: [],
      ask: [],
    });

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(stateService.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: ["Read", "Bash(npm:*)"],
      deny: [],
      ask: [],
    });
  });

  it("does not call setProjectPermissions when file is missing", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(fs.default.readFileSync).mockImplementation(() => {
      const err = Object.assign(new Error("ENOENT: no such file"), {
        code: "ENOENT",
      });
      throw err;
    });

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(stateService.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("does not call setProjectPermissions when file is malformed JSON", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(fs.default.readFileSync).mockReturnValue("not valid json{{");

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(stateService.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("deduplicates permissions when extracted entries overlap with existing", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(fs.default.readFileSync).mockReturnValue(
      JSON.stringify({ permissions: { allow: ["Read", "Bash(npm:*)"] } }),
    );
    vi.mocked(stateService.getProjectPermissions).mockReturnValue({
      allow: ["Read", "Write"],
      deny: [],
      ask: [],
    });

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(stateService.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: ["Read", "Write", "Bash(npm:*)"],
      deny: [],
      ask: [],
    });
  });

  it("merges deny rules from workspace", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(fs.default.readFileSync).mockReturnValue(
      JSON.stringify({
        permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] },
      }),
    );
    vi.mocked(stateService.getProjectPermissions).mockReturnValue({
      allow: ["Read"],
      deny: [],
      ask: [],
    });

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(stateService.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: ["Read"],
      deny: ["Bash(rm:*)"],
      ask: [],
    });
  });

  it("does not call setProjectPermissions when permissions.allow and deny are both empty", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(fs.default.readFileSync).mockReturnValue(
      JSON.stringify({ permissions: { allow: [] } }),
    );

    benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(stateService.setProjectPermissions).not.toHaveBeenCalled();
  });

  it("does not fail teardown when settings.local.json is missing", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(fs.default.readFileSync).mockImplementation(() => {
      const err = Object.assign(new Error("ENOENT: no such file"), {
        code: "ENOENT",
      });
      throw err;
    });

    const bench = benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(bench.error).toBeUndefined();
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
  });

  it("logs a warning for unexpected errors and does not fail teardown", async () => {
    setupExistingBench();
    setupProcessMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(fs.default.readFileSync).mockImplementation(() => {
      const err = Object.assign(new Error("EPERM: permission denied"), {
        code: "EPERM",
      });
      throw err;
    });

    const bench = benchManager.teardownBench("test-project", 1);
    await flushBackground();

    expect(warnSpy).toHaveBeenCalledWith(
      "[bench-manager] extractWorkspacePermissions failed:",
      expect.any(Error),
    );
    expect(bench.error).toBeUndefined();
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
    warnSpy.mockRestore();
  });
});

describe("startComponent", () => {
  it("throws INVALID_STATE for a blank-workspace-path bench (allowlist-rejected)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig();
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [
        makePersistedBench({
          id: 1,
          workspacePath: "/home/.roubo/workspaces/test-project/bench-1; rm -rf x",
        }),
      ],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    await expect(benchManager.startComponent("test-project", 1, "backend")).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(benchManager.getBench("test-project", 1)?.error).toBeTruthy();

    warnSpy.mockRestore();
  });

  it("starts docker service via composeUp + waitForHealthy", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();

    await benchManager.startComponent("test-project", 1, "db");

    expect(dockerService.composeUp).toHaveBeenCalledWith(
      expect.objectContaining({
        composeFile: "docker-compose.yml",
        service: "db",
        projectName: "roubo-test-project-bench-1",
      }),
    );
    expect(dockerService.waitForHealthy).toHaveBeenCalledWith("roubo-test-project-bench-1", "db");
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("running");
  });

  it("starts process service via process-manager", async () => {
    setupExistingBench();
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "backend");

    expect(processManager.startProcess).toHaveBeenCalledWith(
      "test-project-bench-1-backend",
      "dotnet",
      ["run", "--project", "src/Api/Api.csproj"],
      expect.any(Object),
      expect.any(String),
    );
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.backend.status).toBe("running");
  });

  it("starts process service with directory as cwd", async () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "client",
        },
      },
      ports: { frontend: { base: 3000 } },
    });
    setupExistingBench({ config, ports: { frontend: 3000 } });
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "frontend");

    expect(processManager.startProcess).toHaveBeenCalledWith(
      "test-project-bench-1-frontend",
      "npm",
      ["run", "dev"],
      {},
      expect.stringContaining("client"),
    );
  });

  it("writes env file for process component with envFile config", async () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "client",
          envFile: ".env.local",
          envVars: { VITE_API_URL: "http://localhost:5000" },
        },
      },
      ports: { frontend: { base: 3000 } },
    });
    setupExistingBench({ config, ports: { frontend: 3000 } });
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "frontend");

    expect(fs.default.promises.writeFile).toHaveBeenCalledWith(
      "/home/.roubo/workspaces/test-project/bench-1/.env.local",
      expect.stringContaining("VITE_API_URL="),
    );
  });

  it("writes env file relative to workspace root, not service directory", async () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "client",
          envFile: "client/.env.local",
          envVars: { VITE_API_URL: "http://localhost:5000" },
        },
      },
      ports: { frontend: { base: 3000 } },
    });
    setupExistingBench({ config, ports: { frontend: 3000 } });
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "frontend");

    expect(fs.default.promises.writeFile).toHaveBeenCalledWith(
      "/home/.roubo/workspaces/test-project/bench-1/client/.env.local",
      expect.stringContaining("VITE_API_URL="),
    );
  });

  it("resolves template variables in process command", async () => {
    const config = makeConfig({
      components: {
        backend: {
          type: "process",
          command: "dotnet run --urls={{urls.backend}}",
        },
      },
      ports: { backend: { base: 5000 } },
    });
    setupExistingBench({ config, ports: { backend: 5000 } });
    setupProcessMocks();
    vi.mocked(configParser.resolveTemplate).mockImplementation((s: string) =>
      s.replace("{{urls.backend}}", "http://localhost:5000"),
    );

    await benchManager.startComponent("test-project", 1, "backend");

    expect(processManager.startProcess).toHaveBeenCalledWith(
      "test-project-bench-1-backend",
      "dotnet",
      ["run", "--urls=http://localhost:5000"],
      expect.any(Object),
      expect.any(String),
    );
  });

  it("runs migrations after docker service starts", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
          migration: { command: "dotnet", args: ["ef", "database", "update"] },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    await benchManager.startComponent("test-project", 1, "db");

    expect(execModule.runCommand).toHaveBeenCalledWith(
      "dotnet",
      ["ef", "database", "update"],
      "/home/.roubo/workspaces/test-project/bench-1",
      {},
      300_000,
    );
  });

  it("splits multi-word migration command into executable and args", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
          migration: {
            command: "dotnet run --project responda-service/Seeder",
            args: ["connection-string"],
          },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    await benchManager.startComponent("test-project", 1, "db");

    expect(execModule.runCommand).toHaveBeenCalledWith(
      "dotnet",
      ["run", "--project", "responda-service/Seeder", "connection-string"],
      "/home/.roubo/workspaces/test-project/bench-1",
      {},
      300_000,
    );
  });

  it("passes service env to docker compose and migration commands", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
          migration: { command: "dotnet ef", args: ["database", "update"] },
          env: { GITHUB_PAT: "my-pat", DB_NAME: "mydb" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    await benchManager.startComponent("test-project", 1, "db");

    expect(dockerService.composeUp).toHaveBeenCalledWith(
      expect.objectContaining({
        portOverrides: expect.objectContaining({
          GITHUB_PAT: "my-pat",
          DB_NAME: "mydb",
        }),
      }),
    );
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "dotnet",
      ["ef", "database", "update"],
      "/home/.roubo/workspaces/test-project/bench-1",
      { GITHUB_PAT: "my-pat", DB_NAME: "mydb" },
      300_000,
    );
  });

  it("sets service status to error on failure", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    vi.mocked(dockerService.composeUp).mockResolvedValue({
      success: false,
      error: "compose failed",
      stdout: "",
      stderr: "compose failed",
    });
    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");

    await benchManager.startComponent("test-project", 1, "db");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("error");
  });

  it("sets error status when waitForHealthy returns false", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    vi.mocked(dockerService.composeUp).mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
    });
    vi.mocked(dockerService.waitForHealthy).mockResolvedValue(false);
    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");

    await benchManager.startComponent("test-project", 1, "db");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("error");
    expect(bench.components.db.error).toContain("did not become healthy");
  });

  it("runs init service after health check passes", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: {
            composeFile: "docker-compose.yml",
            service: "db",
            initService: "db-init",
          },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();

    await benchManager.startComponent("test-project", 1, "db");

    expect(dockerService.composeRunInit).toHaveBeenCalledWith(
      expect.objectContaining({
        composeFile: "docker-compose.yml",
        initService: "db-init",
        projectName: "roubo-test-project-bench-1",
        timeoutMs: 120_000,
      }),
    );
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("running");
  });

  it("does not call composeRunInit when no initService configured", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();

    await benchManager.startComponent("test-project", 1, "db");

    expect(dockerService.composeRunInit).not.toHaveBeenCalled();
  });

  it("sets error status when init service fails", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: {
            composeFile: "docker-compose.yml",
            service: "db",
            initService: "db-init",
          },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    vi.mocked(dockerService.composeUp).mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
    });
    vi.mocked(dockerService.waitForHealthy).mockResolvedValue(true);
    vi.mocked(dockerService.composeRunInit).mockResolvedValue({
      success: false,
      error: "Init service failed: seed error",
      stdout: "",
      stderr: "seed error",
    });
    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");

    await benchManager.startComponent("test-project", 1, "db");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("error");
    expect(bench.components.db.error).toContain("Init service failed");
  });

  it("throws NOT_FOUND for unknown bench", async () => {
    await expect(benchManager.startComponent("test-project", 99, "backend")).rejects.toThrow();
    try {
      await benchManager.startComponent("test-project", 99, "backend");
    } catch (err) {
      expect((err as any).code).toBe("NOT_FOUND");
    }
  });

  it("throws COMPONENT_NOT_FOUND for unknown component", async () => {
    setupExistingBench();

    await expect(benchManager.startComponent("test-project", 1, "nonexistent")).rejects.toThrow();
    try {
      await benchManager.startComponent("test-project", 1, "nonexistent");
    } catch (err) {
      expect((err as any).code).toBe("COMPONENT_NOT_FOUND");
    }
  });

  it("sets statusDetail phases during docker service startup", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: {
            composeFile: "docker-compose.yml",
            service: "db",
            initService: "db-init",
          },
          migration: { command: "dotnet", args: ["ef", "database", "update"] },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");

    const phases: (string | undefined)[] = [];
    const getPhase = () => {
      const bench = benchManager.getBench("test-project", 1);
      if (!bench) throw new Error("expected bench");
      return bench.components.db.statusDetail;
    };
    vi.mocked(dockerService.composeUp).mockImplementation(async () => {
      phases.push(getPhase());
      return { success: true };
    });
    vi.mocked(dockerService.waitForHealthy).mockImplementation(async () => {
      phases.push(getPhase());
      return true;
    });
    vi.mocked(dockerService.composeRunInit).mockImplementation(async () => {
      phases.push(getPhase());
      return { success: true };
    });
    vi.mocked(execModule.runCommand).mockImplementation(async () => {
      phases.push(getPhase());
      return { code: 0, stdout: "", stderr: "" };
    });

    await benchManager.startComponent("test-project", 1, "db");

    expect(phases).toEqual([
      "Starting container",
      "Waiting for healthy",
      "Running init component",
      "Running migrations",
    ]);
  });

  it("sets startedAt when entering starting state", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });

    let capturedStartedAt: string | undefined;
    vi.mocked(dockerService.composeUp).mockImplementation(async () => {
      const bench = benchManager.getBench("test-project", 1);
      if (!bench) throw new Error("expected bench");
      capturedStartedAt = bench.components.db.startedAt;
      return { success: true };
    });
    vi.mocked(dockerService.waitForHealthy).mockResolvedValue(true);
    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");

    await benchManager.startComponent("test-project", 1, "db");

    expect(capturedStartedAt).toBeDefined();
    expect(new Date(capturedStartedAt as string).getTime()).not.toBeNaN();
  });

  it("clears statusDetail and timestamps on successful start", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();

    await benchManager.startComponent("test-project", 1, "db");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("running");
    expect(bench.components.db.statusDetail).toBeUndefined();
    expect(bench.components.db.statusDetailStartedAt).toBeUndefined();
    expect(bench.components.db.startedAt).toBeUndefined();
  });

  it("clears statusDetail and timestamps on error", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    vi.mocked(dockerService.composeUp).mockResolvedValue({
      success: false,
      error: "compose failed",
      stdout: "",
      stderr: "compose failed",
    });
    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");

    await benchManager.startComponent("test-project", 1, "db");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("error");
    expect(bench.components.db.statusDetail).toBeUndefined();
    expect(bench.components.db.statusDetailStartedAt).toBeUndefined();
    expect(bench.components.db.startedAt).toBeUndefined();
  });

  it("uses custom portEnvVar from docker config", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: {
            composeFile: "docker-compose.yml",
            service: "db",
            portEnvVar: "DB_HOST_PORT",
          },
        },
      },
      ports: { db: { base: 1433 } },
    });
    setupExistingBench({ config, ports: { db: 1433 } });
    vi.mocked(configParser.buildTemplateContext).mockReturnValue({
      ports: { db: 1433 },
      workspace: "/home/.roubo/workspaces/test-project/bench-1",
      components: {},
      portHttps: {},
    });
    setupDockerServiceMocks();

    await benchManager.startComponent("test-project", 1, "db");

    expect(dockerService.composeUp).toHaveBeenCalledWith(
      expect.objectContaining({
        portOverrides: { DB_HOST_PORT: "1433" },
      }),
    );
  });

  it("defaults to HOST_PORT when portEnvVar not specified", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    vi.mocked(configParser.buildTemplateContext).mockReturnValue({
      ports: { db: 5432 },
      workspace: "/home/.roubo/workspaces/test-project/bench-1",
      components: {},
      portHttps: {},
    });
    setupDockerServiceMocks();

    await benchManager.startComponent("test-project", 1, "db");

    expect(dockerService.composeUp).toHaveBeenCalledWith(
      expect.objectContaining({
        portOverrides: { HOST_PORT: "5432" },
      }),
    );
  });

  it("builds phases for docker service with all lifecycle steps", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: {
            composeFile: "docker-compose.yml",
            service: "db",
            initService: "db-init",
          },
          migration: { command: "dotnet", args: ["ef", "database", "update"] },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    await benchManager.startComponent("test-project", 1, "db");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.phases).toEqual([
      { label: "Starting container", status: "done" },
      { label: "Waiting for healthy", status: "done" },
      { label: "Running init component", status: "done" },
      { label: "Running migrations", status: "done" },
    ]);
  });

  it("builds phases for docker service without optional steps", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();

    await benchManager.startComponent("test-project", 1, "db");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.phases).toEqual([
      { label: "Starting container", status: "done" },
      { label: "Waiting for healthy", status: "done" },
    ]);
  });

  it("marks current phase as error on failure", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
          migration: { command: "dotnet", args: ["ef", "database", "update"] },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    vi.mocked(dockerService.composeUp).mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
    });
    vi.mocked(dockerService.waitForHealthy).mockResolvedValue(false);
    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");

    await benchManager.startComponent("test-project", 1, "db");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.phases).toEqual([
      { label: "Starting container", status: "done" },
      { label: "Waiting for healthy", status: "error" },
      { label: "Running migrations", status: "pending" },
    ]);
  });

  it("does not create phases for non-docker services", async () => {
    setupExistingBench();
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "backend");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.backend.phases).toEqual([]);
  });

  it("creates a component-error notification when a process component fails to start", async () => {
    setupExistingBench();
    setupProcessMocks();

    vi.mocked(processManager.startProcess).mockImplementation(() => {
      throw new Error("process failed to start");
    });

    await benchManager.startComponent("test-project", 1, "backend");

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, projectId: "test-project" }),
      "component-error",
    );
  });

  it("creates a component-error notification when a docker component fails to start", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();

    vi.mocked(dockerService.composeUp).mockRejectedValue(new Error("docker failed"));

    await benchManager.startComponent("test-project", 1, "db");

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, projectId: "test-project" }),
      "component-error",
    );
  });

  it("does not create a component-error notification when component starts successfully", async () => {
    setupExistingBench();
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "backend");

    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  // Guard against CodeQL js/prototype-polluting-assignment (alert #27): the
  // component name is user-controlled and indexes plain bench objects.
  describe("prototype-polluting component names", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).status;
    });

    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s with INVALID_COMPONENT and does not pollute Object.prototype",
      async (componentName) => {
        setupExistingBench();

        await expect(
          benchManager.startComponent("test-project", 1, componentName),
        ).rejects.toMatchObject({ code: "INVALID_COMPONENT" });

        expect(({} as Record<string, unknown>).status).toBeUndefined();
      },
    );
  });
});

describe("stopComponent", () => {
  it("stops docker service via composeStop", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { db: { base: 5432 } },
    });
    setupExistingBench({ config, ports: { db: 5432 } });
    setupDockerServiceMocks();
    setupProcessMocks();

    await benchManager.stopComponent("test-project", 1, "db");

    expect(dockerService.composeStop).toHaveBeenCalledWith(
      "roubo-test-project-bench-1",
      "docker-compose.yml",
      "/home/.roubo/workspaces/test-project/bench-1",
      "db",
    );
  });

  it("stops process via processManager", async () => {
    setupExistingBench();
    setupProcessMocks();

    await benchManager.stopComponent("test-project", 1, "backend");

    expect(processManager.stopProcess).toHaveBeenCalledWith("test-project-bench-1-backend");
  });

  it("updates status to stopped", async () => {
    setupExistingBench();
    setupProcessMocks();

    await benchManager.stopComponent("test-project", 1, "backend");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.backend.status).toBe("stopped");
  });

  it("clears statusDetail and timestamps on stop", async () => {
    setupExistingBench();
    setupProcessMocks();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.backend.statusDetail = "Starting container";
    bench.components.backend.statusDetailStartedAt = new Date().toISOString();
    bench.components.backend.startedAt = new Date().toISOString();

    await benchManager.stopComponent("test-project", 1, "backend");

    expect(bench.components.backend.statusDetail).toBeUndefined();
    expect(bench.components.backend.statusDetailStartedAt).toBeUndefined();
    expect(bench.components.backend.startedAt).toBeUndefined();
  });

  it("throws COMPONENT_NOT_FOUND for unknown component", async () => {
    setupExistingBench();

    await expect(benchManager.stopComponent("test-project", 1, "nonexistent")).rejects.toThrow();
    try {
      await benchManager.stopComponent("test-project", 1, "nonexistent");
    } catch (err) {
      expect((err as any).code).toBe("COMPONENT_NOT_FOUND");
    }
  });

  // Guard against CodeQL js/prototype-polluting-assignment (alert #27): the
  // component name is user-controlled and indexes plain bench objects.
  describe("prototype-polluting component names", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).status;
    });

    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s with INVALID_COMPONENT and does not pollute Object.prototype",
      async (componentName) => {
        setupExistingBench();

        await expect(
          benchManager.stopComponent("test-project", 1, componentName),
        ).rejects.toMatchObject({ code: "INVALID_COMPONENT" });

        expect(({} as Record<string, unknown>).status).toBeUndefined();
      },
    );
  });
});

describe("startAllComponents / stopAllComponents", () => {
  it("throws INVALID_STATE for a blank-workspace-path bench (allowlist-rejected)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig();
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [
        makePersistedBench({
          id: 1,
          workspacePath: "/home/.roubo/workspaces/test-project/bench-1; rm -rf x",
        }),
      ],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    // Start must be refused so setup/launch commands never run with cwd="" (the
    // server's own working directory) and the bench's error state is preserved.
    try {
      benchManager.startAllComponents("test-project", 1);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as { code: string }).code).toBe("INVALID_STATE");
    }
    expect(benchManager.getBench("test-project", 1)?.error).toBeTruthy();

    warnSpy.mockRestore();
  });

  it("returns bench in provisioning state with pending steps", () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "client",
        },
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
        },
        app: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "app" },
        },
      },
      ports: {
        frontend: { base: 3000 },
        backend: { base: 5000 },
        app: { base: 5432 },
      },
    });
    setupExistingBench({
      config,
      ports: { frontend: 3000, backend: 5000, app: 5432 },
    });
    setupProcessMocks();
    setupDockerServiceMocks();

    const bench = benchManager.startAllComponents("test-project", 1);

    expect(bench.status).toBe("preparing");
    expect(bench.provisioningSteps).toHaveLength(3);
    expect(bench.provisioningSteps.every((s) => s.status === "pending")).toBe(true);
    expect(bench.provisioningSteps.map((s) => s.id)).toEqual([
      "component:app",
      "component:backend",
      "component:frontend",
    ]);
    // No workspace step
    expect(bench.provisioningSteps.find((s) => s.id === "workspace")).toBeUndefined();
  });

  it("starts all services in background", async () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "client",
        },
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
        },
        app: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "app" },
        },
      },
      ports: {
        frontend: { base: 3000 },
        backend: { base: 5000 },
        app: { base: 5432 },
      },
    });
    setupExistingBench({
      config,
      ports: { frontend: 3000, backend: 5000, app: 5432 },
    });
    setupProcessMocks();
    setupDockerServiceMocks();

    benchManager.startAllComponents("test-project", 1);
    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.components.app.status).toBe("running");
      expect(bench?.components.backend.status).toBe("running");
      expect(bench?.components.frontend.status).toBe("running");
    });

    const bench = benchManager.getBench("test-project", 1);
    expect(bench).toBeDefined();
    expect(bench?.provisioningSteps.every((s) => s.status === "done")).toBe(true);
  });

  it("resets provisioning steps on subsequent startAllServices", async () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "client",
        },
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
        },
      },
      ports: {
        frontend: { base: 3000 },
        backend: { base: 5000 },
      },
    });
    setupExistingBench({ config, ports: { frontend: 3000, backend: 5000 } });
    setupProcessMocks();

    // First start
    benchManager.startAllComponents("test-project", 1);
    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).not.toBe("preparing");
    });

    const benchAfterFirst = benchManager.getBench("test-project", 1);
    expect(benchAfterFirst).toBeDefined();
    expect(benchAfterFirst?.provisioningSteps.every((s) => s.status === "done")).toBe(true);

    // Stop all
    await benchManager.stopAllComponents("test-project", 1);

    // Second start — steps should reset
    const bench = benchManager.startAllComponents("test-project", 1);
    expect(bench.status).toBe("preparing");
    expect(bench.provisioningSteps.every((s) => s.status === "pending")).toBe(true);
  });

  it("respects dependsOn ordering", async () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "client",
          dependsOn: ["backend"],
        },
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
          dependsOn: ["db"],
        },
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: {
        frontend: { base: 3000 },
        backend: { base: 5000 },
        db: { base: 5432 },
      },
    });
    setupExistingBench({
      config,
      ports: { frontend: 3000, backend: 5000, db: 5432 },
    });
    setupProcessMocks();
    setupDockerServiceMocks();

    const startOrder: string[] = [];
    vi.mocked(dockerService.composeUp).mockImplementation(async () => {
      startOrder.push("db");
      return { success: true };
    });
    vi.mocked(processManager.startProcess).mockImplementation((...args) => {
      // Extract component name from process id: "test-project-bench-1-<component>"
      const pid = args[0] as string;
      const componentKey = pid.split("-").pop() ?? "";
      startOrder.push(componentKey);
      return { pid: 123 };
    });

    benchManager.startAllComponents("test-project", 1);
    await vi.waitFor(() => {
      expect(startOrder).toEqual(["db", "backend", "frontend"]);
    });
  });

  it("stopAllServices stops all services", async () => {
    const config = makeConfig({
      components: {
        frontend: {
          type: "process",
          command: "npm run dev",
          directory: "client",
        },
        backend: {
          type: "process",
          command: "dotnet run --project src/Api/Api.csproj",
        },
        app: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "app" },
        },
      },
      ports: {
        frontend: { base: 3000 },
        backend: { base: 5000 },
        app: { base: 5432 },
      },
    });
    setupExistingBench({
      config,
      ports: { frontend: 3000, backend: 5000, app: 5432 },
    });
    setupProcessMocks();
    setupDockerServiceMocks();

    await benchManager.stopAllComponents("test-project", 1);

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.app.status).toBe("stopped");
    expect(bench.components.backend.status).toBe("stopped");
    expect(bench.components.frontend.status).toBe("stopped");
  });
});

describe("getBench / getBenches", () => {
  it("getBench returns undefined for unknown", () => {
    expect(benchManager.getBench("test-project", 99)).toBeUndefined();
  });

  it("getBenches with projectId filters", () => {
    setupCreateBenchMocks();
    setupProcessMocks();
    benchManager.createBench("test-project");

    const benchs = benchManager.getBenches("test-project");
    expect(benchs).toHaveLength(1);
    expect(benchs[0].projectId).toBe("test-project");

    const noBenches = benchManager.getBenches("other-app");
    expect(noBenches).toHaveLength(0);
  });

  it("getBenches without projectId returns all", () => {
    setupCreateBenchMocks();
    setupProcessMocks();
    benchManager.createBench("test-project");

    const benchs = benchManager.getBenches();
    expect(benchs).toHaveLength(1);
  });
});

describe("getComponentLogs", () => {
  it("delegates to processManager.getProcessLogs with correct process id", () => {
    vi.mocked(processManager.getProcessLogs).mockReturnValue(["log line 1", "log line 2"]);

    const logs = benchManager.getComponentLogs("test-project", 1, "backend");

    expect(processManager.getProcessLogs).toHaveBeenCalledWith(
      "test-project-bench-1-backend",
      undefined,
    );
    expect(logs).toEqual(["log line 1", "log line 2"]);
  });
});

describe("refreshComponentStatuses", () => {
  it("updates docker service status from container status", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
    });
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench({ ports: { db: 5432 } })],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");
    vi.mocked(dockerService.getContainerStatuses).mockResolvedValue(
      new Map([["roubo-test-project-bench-1/db", "running"]]),
    );
    vi.mocked(processManager.getProcessStatus).mockReturnValue({
      alive: false,
      exitCode: null,
    });

    await benchManager.refreshComponentStatuses();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.components.db.status).toBe("running");
  });

  it("updates process service status when process dies", async () => {
    const config = makeConfig();
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench()],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.backend.status = "running";

    vi.mocked(processManager.getProcessStatus).mockReturnValue({
      alive: false,
      exitCode: 1,
    });

    await benchManager.refreshComponentStatuses();

    expect(bench.components.backend.status).toBe("stopped");
    expect(bench.components.backend.error).toBe("Exited with code 1");
  });

  it("respects stopping status (does not override to running)", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
    });
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench({ ports: { db: 5432 } })],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.db.status = "stopping";

    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");
    vi.mocked(dockerService.getContainerStatuses).mockResolvedValue(
      new Map([["roubo-test-project-bench-1/db", "running"]]),
    );
    vi.mocked(processManager.getProcessStatus).mockReturnValue({
      alive: false,
      exitCode: null,
    });

    await benchManager.refreshComponentStatuses();

    expect(bench.components.db.status).toBe("stopping");
  });

  it("does not override error status with running for docker services", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
    });
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench({ ports: { db: 5432 } })],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.db.status = "error";
    bench.components.db.error = "Container did not become healthy within timeout";

    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");
    vi.mocked(dockerService.getContainerStatuses).mockResolvedValue(
      new Map([["roubo-test-project-bench-1/db", "running"]]),
    );

    await benchManager.refreshComponentStatuses();

    expect(bench.components.db.status).toBe("error");
    expect(bench.components.db.error).toBe("Container did not become healthy within timeout");
  });

  it("does not override status while startService is actively managing it", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
    });
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench({ ports: { db: 5432 } })],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.db.status = "starting";
    bench.components.db.startedAt = new Date().toISOString();

    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");
    vi.mocked(dockerService.getContainerStatuses).mockResolvedValue(
      new Map([["roubo-test-project-bench-1/db", "running"]]),
    );

    await benchManager.refreshComponentStatuses();

    expect(bench.components.db.status).toBe("starting");
  });

  it("does not override error status for process services", async () => {
    const config = makeConfig();
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench()],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.backend.status = "error";
    bench.components.backend.error = "process failed";

    vi.mocked(processManager.getProcessStatus).mockReturnValue({
      alive: true,
      exitCode: null,
    });

    await benchManager.refreshComponentStatuses();

    expect(bench.components.backend.status).toBe("error");
    expect(bench.components.backend.error).toBe("process failed");
  });

  it("sets stopped with error when container is unhealthy", async () => {
    const config = makeConfig({
      components: {
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
    });
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench({ ports: { db: 5432 } })],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.db.status = "running";

    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");
    vi.mocked(dockerService.getContainerStatuses).mockResolvedValue(
      new Map([["roubo-test-project-bench-1/db", "unhealthy"]]),
    );

    await benchManager.refreshComponentStatuses();

    expect(bench.components.db.status).toBe("stopped");
    expect(bench.components.db.error).toBe("Container health check failed");
  });

  it("does not override provisioning status", async () => {
    const config = makeConfig();
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench()],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.status = "preparing";

    vi.mocked(processManager.getProcessStatus).mockReturnValue({
      alive: false,
      exitCode: null,
    });

    await benchManager.refreshComponentStatuses();

    expect(bench.status).toBe("preparing");
  });
});

describe("updateBenchStatus (tested implicitly)", () => {
  it("sets error when any service has error", async () => {
    const config = makeConfig({
      components: {
        component1: {
          type: "process",
          command: "dotnet run --project a.csproj",
        },
        component2: {
          type: "process",
          command: "dotnet run --project b.csproj",
        },
      },
      ports: { component1: { base: 5000 }, component2: { base: 5100 } },
    });
    setupExistingBench({
      config,
      ports: { component1: 5000, component2: 5100 },
    });
    setupProcessMocks();

    vi.mocked(processManager.startProcess).mockImplementation(() => {
      throw new Error("process failed");
    });
    await benchManager.startComponent("test-project", 1, "component1");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.status).toBe("error");
  });

  it("sets running when all running", async () => {
    setupExistingBench();
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "backend");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.status).toBe("active");
  });

  it("stays idle when individual component is stopping (no longer derives clearing state)", async () => {
    const config = makeConfig({
      components: {
        component1: {
          type: "process",
          command: "dotnet run --project a.csproj",
        },
        component2: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { component1: { base: 5000 }, component2: { base: 5100 } },
    });
    const project = makeProject({ config });
    vi.mocked(stateService.loadState).mockReturnValue({
      benches: [makePersistedBench({ ports: { component1: 5000, component2: 5100 } })],
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.component1.status = "stopping";
    bench.components.component2.status = "running";

    vi.mocked(dockerService.getComposeProjectName).mockReturnValue("roubo-test-project-bench-1");
    vi.mocked(dockerService.getContainerStatuses).mockResolvedValue(
      new Map([["roubo-test-project-bench-1/db", "running"]]),
    );
    vi.mocked(processManager.getProcessStatus).mockReturnValue({
      alive: true,
      exitCode: null,
    });

    await benchManager.refreshComponentStatuses();

    expect(bench.status).toBe("idle");
  });

  it("stays idle when individual component is starting (no longer derives preparing state)", async () => {
    const config = makeConfig({
      components: {
        component1: {
          type: "process",
          command: "dotnet run --project a.csproj",
        },
        component2: {
          type: "process",
          command: "dotnet run --project b.csproj",
        },
      },
      ports: { component1: { base: 5000 }, component2: { base: 5100 } },
    });
    setupExistingBench({
      config,
      ports: { component1: 5000, component2: 5100 },
    });
    setupProcessMocks();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.component1.status = "starting";
    bench.components.component1.startedAt = new Date().toISOString();
    bench.components.component2.status = "stopped";

    vi.mocked(processManager.getProcessStatus).mockReturnValue({
      alive: false,
      exitCode: 0,
    });

    await benchManager.refreshComponentStatuses();

    expect(bench.status).toBe("idle");
  });

  it("sets inactive when some running but not all", async () => {
    const config = makeConfig({
      components: {
        component1: {
          type: "process",
          command: "dotnet run --project a.csproj",
        },
        component2: {
          type: "process",
          command: "dotnet run --project b.csproj",
        },
      },
      ports: { component1: { base: 5000 }, component2: { base: 5100 } },
    });
    setupExistingBench({
      config,
      ports: { component1: 5000, component2: 5100 },
    });
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "component1");

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.status).toBe("idle");
  });

  it("sets inactive when all stopped", () => {
    setupExistingBench();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.status).toBe("idle");
    expect(bench.components.backend.status).toBe("stopped");
  });
});

describe("cleanupAndRetryBench", () => {
  it("throws NOT_FOUND for non-existent bench", async () => {
    try {
      await benchManager.cleanupAndRetryBench("test-project", 99);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as { code: string }).code).toBe("NOT_FOUND");
    }
  });

  it("throws INVALID_STATE when bench has no error", async () => {
    setupExistingBench();
    setupProcessMocks();

    try {
      await benchManager.cleanupAndRetryBench("test-project", 1);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as { code: string }).code).toBe("INVALID_STATE");
    }
  });

  it("throws INVALID_STATE for a bench with a blank workspace path (allowlist-rejected)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig();
    const project = makeProject({ config });
    const unsafe = makePersistedBench({
      id: 1,
      workspacePath: "/home/.roubo/workspaces/test-project/bench-1; rm -rf x",
    });
    vi.mocked(stateService.loadState).mockReturnValue({ benches: [unsafe] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    benchManager.initialize();

    // Sanity: the bench loaded errored with a blanked path, so retry must be refused
    // rather than running provisioning against an empty path.
    expect(benchManager.getBench("test-project", 1)?.workspacePath).toBe("");

    try {
      await benchManager.cleanupAndRetryBench("test-project", 1);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as { code: string }).code).toBe("INVALID_STATE");
    }

    warnSpy.mockRestore();
  });

  it("cleans up resources and re-provisions an error bench", async () => {
    setupExistingBench();
    setupProcessMocks();
    const workspacePath = "/home/.roubo/workspaces/test-project/bench-1";
    // First call returns the workspace in the listing (registered worktree); subsequent calls succeed.
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({
        code: 0,
        stdout: `worktree ${workspacePath}\nHEAD abc123\nbranch refs/heads/bench-1\n`,
        stderr: "",
      })
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    vi.mocked(fs.default.existsSync).mockReturnValue(false);

    // Force bench into error state
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.status = "error";
    bench.error = "Failed to create workspace: directory already exists";
    bench.provisioningSteps = [
      {
        id: "workspace",
        label: "Creating workspace",
        status: "error",
        error: "directory already exists",
      },
    ];

    const result = await benchManager.cleanupAndRetryBench("test-project", 1);

    expect(result.error).toBeUndefined();
    expect(result.id).toBe(1);
    expect(result.branch).toBe("bench-1");
    // Provisioning runs in the background; with mocked runCommand resolving
    // immediately, the bench may already be past 'provisioning' by now.
    // The key assertion is that it's no longer in 'error' state.
    expect(result.status).not.toBe("error");

    // Verify cleanup was performed
    expect(terminalService.destroyBenchSessions).toHaveBeenCalledWith("test-project", 1);
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["worktree", "list", "--porcelain"],
      "/repos/test-project",
    );
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", workspacePath],
      "/repos/test-project",
    );
    expect(execModule.runCommand).toHaveBeenCalledWith(
      "git",
      ["worktree", "prune"],
      "/repos/test-project",
    );
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
  });

  it("preserves assignedIssue through cleanup", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(fs.default.existsSync).mockReturnValue(false);

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.status = "error";
    bench.error = "workspace error";
    bench.assignedIssue = { number: 42, title: "Fix the bug" };

    const result = await benchManager.cleanupAndRetryBench("test-project", 1);

    expect(result.assignedIssue).toEqual({ number: 42, title: "Fix the bug" });
    expect(result.status).toBe("preparing");
  });

  it("extracts and merges permissions from workspace settings.local.json", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    vi.mocked(fs.default.readFileSync).mockReturnValue(
      JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
    );
    vi.mocked(stateService.getProjectPermissions).mockReturnValue({
      allow: ["Read"],
      deny: [],
      ask: [],
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.status = "error";
    bench.error = "workspace error";

    await benchManager.cleanupAndRetryBench("test-project", 1);

    expect(stateService.setProjectPermissions).toHaveBeenCalledWith("test-project", {
      allow: ["Read", "Bash(git:*)"],
      deny: [],
      ask: [],
    });
  });

  it("throws and logs when worktree remove fails during retry", async () => {
    setupExistingBench();
    setupProcessMocks();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fs.default.existsSync).mockReturnValue(false);
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 128,
      stdout: "",
      stderr: "fatal: not a worktree",
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.status = "error";
    bench.error = "workspace error";

    await expect(benchManager.cleanupAndRetryBench("test-project", 1)).rejects.toThrow(
      /worktree remove/,
    );

    expect(errorSpy.mock.calls[0][0]).toContain("bench 1");
    expect(errorSpy.mock.calls[0][0]).toContain("/home/.roubo/workspaces/test-project/bench-1");
    expect(errorSpy.mock.calls[0][0]).toContain("worktree remove");
    expect(stateService.removeBench).not.toHaveBeenCalled();
    expect(bench.status).toBe("error");
    expect(bench.provisioningSteps).toEqual([]);
    errorSpy.mockRestore();
  });

  it("warns but succeeds when worktree prune fails during retry", async () => {
    setupExistingBench();
    setupProcessMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fs.default.existsSync).mockReturnValue(false);
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({
        // worktree list — workspace not registered
        code: 0,
        stdout: "worktree /repos/test-project\nHEAD abc\nbranch refs/heads/main\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "error: worktree prune failed",
      }) // worktree prune fails
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // provisioning commands

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.status = "error";
    bench.error = "workspace error";

    const result = await benchManager.cleanupAndRetryBench("test-project", 1);

    expect(result.status).not.toBe("error");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`worktree prune for bench 1`));
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
    // worktree remove should NOT have been called (workspace was not registered)
    expect(execModule.runCommand).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it("succeeds when workspace was never created (fast-forward failure scenario)", async () => {
    setupExistingBench();
    setupProcessMocks();
    vi.mocked(fs.default.existsSync).mockReturnValue(false);
    // Workspace path is absent from the worktree listing
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({
        // worktree list — only the main worktree appears
        code: 0,
        stdout: "worktree /repos/test-project\nHEAD abc123\nbranch refs/heads/main\n",
        stderr: "",
      })
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // prune + provisioning

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.status = "error";
    bench.error =
      "Could not fast-forward 'main' — your local branch has diverged from origin/main. " +
      "Resolve manually in the source repo, or disable 'Pull latest' in project settings.";

    const result = await benchManager.cleanupAndRetryBench("test-project", 1);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe("error");
    // worktree remove should NOT be called when workspace was never registered
    expect(execModule.runCommand).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.any(String),
    );
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
  });

  it("removes orphaned workspace directory via rmSync when path exists on disk but is not a registered worktree", async () => {
    setupExistingBench();
    setupProcessMocks();
    const workspacePath = "/home/.roubo/workspaces/test-project/bench-1";
    // existsSync returns true — directory is on disk but not in git's worktree list
    vi.mocked(fs.default.existsSync).mockReturnValue(true);
    vi.mocked(execModule.runCommand)
      .mockResolvedValueOnce({
        // worktree list — only main worktree, workspace absent
        code: 0,
        stdout: "worktree /repos/test-project\nHEAD abc123\nbranch refs/heads/main\n",
        stderr: "",
      })
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // prune + provisioning

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.status = "error";
    bench.error = "workspace error";

    const result = await benchManager.cleanupAndRetryBench("test-project", 1);

    expect(result.status).not.toBe("error");
    expect(fs.default.rmSync).toHaveBeenCalledWith(workspacePath, {
      recursive: true,
      force: true,
    });
    expect(execModule.runCommand).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.any(String),
    );
    expect(stateService.removeBench).toHaveBeenCalledWith("test-project", 1);
  });
});

describe("assignContainer", () => {
  const dbConfig = makeConfig({
    components: {
      backend: {
        type: "process",
        command: "dotnet run --project src/Api/Api.csproj",
      },
      db: { type: "database", image: "postgres:16" },
    },
    ports: {
      backend: { base: 5000 },
      db: { base: 5432 },
    },
  });

  it("throws NOT_FOUND when bench does not exist", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(stateService.loadState).mockReturnValue({ benches: [] });
    benchManager.initialize();

    await expect(
      benchManager.assignContainer("test-project", 99, "db", "abc123"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws PROJECT_NOT_FOUND when project config is missing", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ config: null as any }));

    await expect(
      benchManager.assignContainer("test-project", 1, "db", "abc123"),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("throws COMPONENT_NOT_FOUND when component is not in config", async () => {
    setupExistingBench();

    await expect(
      benchManager.assignContainer("test-project", 1, "db", "abc123"),
    ).rejects.toMatchObject({ code: "COMPONENT_NOT_FOUND" });
  });

  it("throws INVALID_COMPONENT_TYPE when component is not a database type", async () => {
    setupExistingBench();

    await expect(
      benchManager.assignContainer("test-project", 1, "backend", "abc123"),
    ).rejects.toMatchObject({ code: "INVALID_COMPONENT_TYPE" });
  });

  it("throws CONTAINER_NOT_FOUND when container ID not in docker list", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(dockerService.listDatabaseContainers).mockResolvedValue([]);

    await expect(
      benchManager.assignContainer("test-project", 1, "db", "abc123"),
    ).rejects.toMatchObject({ code: "CONTAINER_NOT_FOUND" });
  });

  it("throws NO_PORT when container has no published port", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(dockerService.listDatabaseContainers).mockResolvedValue([
      {
        id: "abc123",
        name: "my-postgres",
        image: "postgres:16",
        status: "running",
        port: null,
      },
    ]);

    await expect(
      benchManager.assignContainer("test-project", 1, "db", "abc123"),
    ).rejects.toMatchObject({ code: "NO_PORT" });
  });

  it("assigns container, sets port, and updates service status", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(dockerService.listDatabaseContainers).mockResolvedValue([
      {
        id: "abc123",
        name: "my-postgres",
        image: "postgres:16",
        status: "running",
        port: 5433,
      },
    ]);

    const bench = await benchManager.assignContainer("test-project", 1, "db", "abc123");

    expect(bench.assignedContainers?.db).toEqual({
      containerId: "abc123",
      containerName: "my-postgres",
      port: 5433,
    });
    expect(bench.ports.db).toBe(5433);
    expect(bench.components.db?.status).toBe("running");
    expect(stateService.updateBench).toHaveBeenCalled();
  });

  it("preserves injectedJigSource in updateBench call", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(dockerService.listDatabaseContainers).mockResolvedValue([
      {
        id: "abc123",
        name: "my-postgres",
        image: "postgres:16",
        status: "running",
        port: 5433,
      },
    ]);
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.injectedJigId = "my-jig";
    bench.injectedJigSource = "issue-type-mapping";

    await benchManager.assignContainer("test-project", 1, "db", "abc123");

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        injectedJigSource: "issue-type-mapping",
      }),
    );
  });

  it("preserves componentSetupState in updateBench call", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(dockerService.listDatabaseContainers).mockResolvedValue([
      {
        id: "abc123",
        name: "my-postgres",
        image: "postgres:16",
        status: "running",
        port: 5433,
      },
    ]);
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.components.backend.setupComplete = false;
    bench.components.db.setupComplete = true;

    await benchManager.assignContainer("test-project", 1, "db", "abc123");

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        componentSetupState: { backend: false, db: true },
      }),
    );
  });

  // Guard against CodeQL js/prototype-polluting-assignment (alert #27): the
  // component name is user-controlled and indexes plain bench objects.
  describe("prototype-polluting component names", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).status;
    });

    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s with INVALID_COMPONENT and does not pollute Object.prototype",
      async (componentName) => {
        setupExistingBench({
          config: dbConfig,
          ports: { backend: 5001, db: 5432 },
        });

        await expect(
          benchManager.assignContainer("test-project", 1, componentName, "abc123"),
        ).rejects.toMatchObject({ code: "INVALID_COMPONENT" });

        expect(({} as Record<string, unknown>).status).toBeUndefined();
      },
    );
  });
});

describe("unassignContainer", () => {
  const dbConfig = makeConfig({
    components: {
      backend: {
        type: "process",
        command: "dotnet run --project src/Api/Api.csproj",
      },
      db: { type: "database", image: "postgres:16" },
    },
    ports: {
      backend: { base: 5000 },
      db: { base: 5432 },
    },
  });

  it("throws NOT_FOUND when bench does not exist", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(stateService.loadState).mockReturnValue({ benches: [] });
    benchManager.initialize();

    await expect(benchManager.unassignContainer("test-project", 99, "db")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws PROJECT_NOT_FOUND when project config is missing", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ config: null as any }));

    await expect(benchManager.unassignContainer("test-project", 1, "db")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("throws NOT_ASSIGNED when no container is assigned to the service", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });

    await expect(benchManager.unassignContainer("test-project", 1, "db")).rejects.toMatchObject({
      code: "NOT_ASSIGNED",
    });
  });

  it("removes assignment, restores allocated port, and resets service status", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(portAllocator.allocatePorts).mockReturnValue({
      backend: 5001,
      db: 5432,
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.assignedContainers = {
      db: { containerId: "abc123", containerName: "my-postgres", port: 5433 },
    };
    bench.ports.db = 5433;
    if (bench.components.db) bench.components.db.status = "running";

    const result = await benchManager.unassignContainer("test-project", 1, "db");

    expect(result.assignedContainers).toBeUndefined();
    expect(result.ports.db).toBe(5432);
    expect(result.components.db?.status).toBe("stopped");
    expect(stateService.updateBench).toHaveBeenCalled();
  });

  it("preserves injectedJigSource in updateBench call", async () => {
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(portAllocator.allocatePorts).mockReturnValue({
      backend: 5001,
      db: 5432,
    });
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.assignedContainers = {
      db: { containerId: "abc123", containerName: "my-postgres", port: 5433 },
    };
    bench.injectedJigId = "my-jig";
    bench.injectedJigSource = "project";

    await benchManager.unassignContainer("test-project", 1, "db");

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigSource: "project" }),
    );
  });

  // Guard against CodeQL js/prototype-polluting-assignment (alert #27): the
  // component name is user-controlled and indexes plain bench objects.
  describe("prototype-polluting component names", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).status;
    });

    it.each(["__proto__", "constructor", "prototype"])(
      "rejects %s with INVALID_COMPONENT and does not pollute Object.prototype",
      async (componentName) => {
        setupExistingBench({
          config: dbConfig,
          ports: { backend: 5001, db: 5432 },
        });

        await expect(
          benchManager.unassignContainer("test-project", 1, componentName),
        ).rejects.toMatchObject({ code: "INVALID_COMPONENT" });

        expect(({} as Record<string, unknown>).status).toBeUndefined();
      },
    );
  });
});

describe("workUnits hydration and projection", () => {
  const workUnits = [
    {
      submodule: "api",
      branch: "feat/my-feature",
      workspacePath: "/home/.roubo/workspaces/test-project/bench-1/api",
      pullRequest: {
        repoFullName: "acme/api",
        number: 42,
        title: "My feature",
        state: "open" as const,
        merged: false,
        url: "https://github.com/acme/api/pull/42",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ];

  it("hydrates workUnits from PersistedBench into Bench", () => {
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench({ workUnits });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.workUnits).toEqual(workUnits);
  });

  it("hydrates workUnits as undefined when absent in PersistedBench (legacy)", () => {
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench();

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.workUnits).toBeUndefined();
  });

  it("includes workUnits when projecting Bench to PersistedBench via updateBench", async () => {
    const dbConfig = makeConfig({
      components: {
        backend: { type: "process", command: "node server.js" },
        db: { type: "database", image: "postgres:17" },
      },
      ports: { backend: { base: 5000 }, db: { base: 5432 } },
    });
    setupExistingBench({
      config: dbConfig,
      ports: { backend: 5001, db: 5432 },
    });
    vi.mocked(portAllocator.allocatePorts).mockReturnValue({
      backend: 5001,
      db: 5432,
    });

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.workUnits = workUnits;
    bench.assignedContainers = {
      db: { containerId: "abc123", containerName: "my-postgres", port: 5433 },
    };
    bench.ports.db = 5433;

    vi.mocked(dockerService.getContainerStatus).mockResolvedValue({
      status: "running",
      containerId: "abc123",
      containerName: "my-postgres",
      port: 5433,
    });

    await benchManager.unassignContainer("test-project", 1, "db");

    expect(stateService.updateBench).toHaveBeenCalledWith(expect.objectContaining({ workUnits }));
  });

  it("hydrates baseBranch/baseCommit from PersistedBench into Bench", () => {
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench({
      baseBranch: "main",
      baseCommit: "abc1234",
    });

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.baseBranch).toBe("main");
    expect(bench.baseCommit).toBe("abc1234");
  });

  it("hydrates baseBranch/baseCommit as undefined when absent in PersistedBench (legacy)", () => {
    const config = makeConfig();
    const project = makeProject({ config });
    const persisted = makePersistedBench();

    vi.mocked(stateService.loadState).mockReturnValue({ benches: [persisted] });
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);

    benchManager.initialize();

    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    expect(bench.baseBranch).toBeUndefined();
    expect(bench.baseCommit).toBeUndefined();
  });
});

describe("refreshWorkUnitBranch", () => {
  const SUB_WORKSPACE = "/home/.roubo/workspaces/test-project/bench-1/services/api";

  function makeBenchWithWorkUnits() {
    setupExistingBench();
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.workUnits = [{ submodule: "api", branch: "old-branch", workspacePath: SUB_WORKSPACE }];
    return bench;
  }

  it("updates workUnit.branch and calls stateService.updateBench when HEAD branch changed", async () => {
    const bench = makeBenchWithWorkUnits();
    vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("new-branch");

    await benchManager.refreshWorkUnitBranch(bench, "api");

    const workUnit = bench.workUnits?.[0];
    if (!workUnit) throw new Error("expected work unit");
    expect(workUnit.branch).toBe("new-branch");
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ workUnits: bench.workUnits }),
    );
  });

  it("does not call stateService.updateBench when HEAD branch is unchanged", async () => {
    const bench = makeBenchWithWorkUnits();
    vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("old-branch");

    await benchManager.refreshWorkUnitBranch(bench, "api");

    const workUnit = bench.workUnits?.[0];
    if (!workUnit) throw new Error("expected work unit");
    expect(workUnit.branch).toBe("old-branch");
    expect(stateService.updateBench).not.toHaveBeenCalled();
  });

  it("logs a warning and leaves branch unchanged when resolveHeadBranch throws", async () => {
    const bench = makeBenchWithWorkUnits();
    vi.mocked(gitHelpers.resolveHeadBranch).mockRejectedValue(new Error("detached HEAD"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await benchManager.refreshWorkUnitBranch(bench, "api");

    const workUnit = bench.workUnits?.[0];
    if (!workUnit) throw new Error("expected work unit");
    expect(workUnit.branch).toBe("old-branch");
    expect(stateService.updateBench).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not refresh branch for work unit 'api'"),
    );
  });

  it("returns early with no side effects when submodule key is not found", async () => {
    const bench = makeBenchWithWorkUnits();

    await benchManager.refreshWorkUnitBranch(bench, "nonexistent");

    expect(gitHelpers.resolveHeadBranch).not.toHaveBeenCalled();
    expect(stateService.updateBench).not.toHaveBeenCalled();
  });

  it("preserves assignedContainers, assignedIssue, and notifications in updateBench call", async () => {
    const bench = makeBenchWithWorkUnits();
    bench.assignedContainers = {
      db: { containerId: "c1", containerName: "pg", port: 5432 },
    };
    bench.assignedIssue = {
      number: 7,
      title: "My issue",
      url: "https://github.com/org/repo/issues/7",
      repoFullName: "org/repo",
    };
    bench.notifications = [
      {
        id: "n1",
        type: "bench-ready",
        priority: "info",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("new-branch");

    await benchManager.refreshWorkUnitBranch(bench, "api");

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedContainers: bench.assignedContainers,
        assignedIssue: bench.assignedIssue,
        notifications: bench.notifications,
      }),
    );
  });

  it("preserves injectedJigId in updateBench call", async () => {
    const bench = makeBenchWithWorkUnits();
    bench.injectedJigId = "my-jig";
    vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("new-branch");

    await benchManager.refreshWorkUnitBranch(bench, "api");

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigId: "my-jig" }),
    );
  });

  it("preserves injectedJigSource in updateBench call", async () => {
    const bench = makeBenchWithWorkUnits();
    bench.injectedJigId = "my-jig";
    bench.injectedJigSource = "issue-type-mapping";
    vi.mocked(gitHelpers.resolveHeadBranch).mockResolvedValue("new-branch");

    await benchManager.refreshWorkUnitBranch(bench, "api");

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        injectedJigSource: "issue-type-mapping",
      }),
    );
  });
});

describe("setWorkUnitIgnoredForAutoClear", () => {
  function makeBenchWithWorkUnits() {
    setupExistingBench();
    const bench = benchManager.getBench("test-project", 1);
    if (!bench) throw new Error("expected bench");
    bench.workUnits = [
      {
        submodule: "api",
        branch: "main",
        workspacePath: "/home/.roubo/workspaces/test-project/bench-1/services/api",
      },
      {
        submodule: "web",
        branch: "main",
        workspacePath: "/home/.roubo/workspaces/test-project/bench-1/clients/web",
      },
    ];
    return bench;
  }

  it("sets ignoredForAutoClear=true on the matching work unit and persists via updateBench", () => {
    const bench = makeBenchWithWorkUnits();

    const result = benchManager.setWorkUnitIgnoredForAutoClear("test-project", 1, "api", true);

    expect(result).toBe(bench);
    const apiUnit = bench.workUnits?.find((wu) => wu.submodule === "api");
    expect(apiUnit?.ignoredForAutoClear).toBe(true);
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ workUnits: bench.workUnits }),
    );
  });

  it("sets ignoredForAutoClear=false to resume tracking", () => {
    const bench = makeBenchWithWorkUnits();
    const apiUnit = bench.workUnits?.find((wu) => wu.submodule === "api");
    if (apiUnit) apiUnit.ignoredForAutoClear = true;

    benchManager.setWorkUnitIgnoredForAutoClear("test-project", 1, "api", false);

    expect(apiUnit?.ignoredForAutoClear).toBe(false);
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ workUnits: bench.workUnits }),
    );
  });

  it("does not affect sibling work units", () => {
    const bench = makeBenchWithWorkUnits();

    benchManager.setWorkUnitIgnoredForAutoClear("test-project", 1, "api", true);

    const webUnit = bench.workUnits?.find((wu) => wu.submodule === "web");
    expect(webUnit?.ignoredForAutoClear).toBeUndefined();
  });

  it("throws BenchError NOT_FOUND when bench does not exist", () => {
    setupExistingBench();
    benchManager.initialize();

    expect(() =>
      benchManager.setWorkUnitIgnoredForAutoClear("test-project", 999, "api", true),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(stateService.updateBench).not.toHaveBeenCalled();
  });

  it("throws BenchError NOT_FOUND when work unit submodule does not exist on bench", () => {
    makeBenchWithWorkUnits();

    expect(() =>
      benchManager.setWorkUnitIgnoredForAutoClear("test-project", 1, "nonexistent", true),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(stateService.updateBench).not.toHaveBeenCalled();
  });

  it("preserves injectedJigSource in updateBench call", () => {
    const bench = makeBenchWithWorkUnits();
    bench.injectedJigId = "my-jig";
    bench.injectedJigSource = "app";

    benchManager.setWorkUnitIgnoredForAutoClear("test-project", 1, "api", true);

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ injectedJigSource: "app" }),
    );
  });

  it("preserves all other bench fields in the updateBench call", () => {
    const bench = makeBenchWithWorkUnits();
    bench.assignedContainers = {
      db: { containerId: "c1", containerName: "pg", port: 5432 },
    };
    bench.assignedIssue = {
      number: 7,
      title: "My issue",
      url: "https://github.com/org/repo/issues/7",
      repoFullName: "org/repo",
    };
    bench.notifications = [
      {
        id: "n1",
        type: "bench-ready",
        priority: "info",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    benchManager.setWorkUnitIgnoredForAutoClear("test-project", 1, "api", true);

    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedContainers: bench.assignedContainers,
        assignedIssue: bench.assignedIssue,
        notifications: bench.notifications,
      }),
    );
  });
});

/** Set up an existing bench whose persisted componentSetupState we control. */
function setupBenchWithSetupState(
  config: ReturnType<typeof makeConfig>,
  componentSetupState: Record<string, boolean>,
  ports: Record<string, number> = { backend: 5001 },
) {
  const project = makeProject({ config });
  vi.mocked(stateService.loadState).mockReturnValue({
    benches: [makePersistedBench({ componentSetupState, ports })],
  });
  vi.mocked(projectRegistry.getProject).mockReturnValue(project);
  vi.mocked(portAllocator.allocatePorts).mockReturnValue(ports);
  vi.mocked(stateService.getWorkspacePath).mockReturnValue(
    "/home/.roubo/workspaces/test-project/bench-1",
  );
  vi.mocked(configParser.buildTemplateContext).mockReturnValue({
    ports,
    portHttps: {},
    workspace: "/home/.roubo/workspaces/test-project/bench-1",
    components: {},
  });
  vi.mocked(configParser.resolveTemplate).mockImplementation((s) => s);
  vi.mocked(configParser.resolveServiceEnv).mockImplementation((env) => env);
  benchManager.initialize();
  return project;
}

describe("startAllComponents (Start endpoint setup gating)", () => {
  it("first Start runs setup, persists setupComplete: true, then launches", async () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start", setup: "npm ci" },
      },
    });
    setupBenchWithSetupState(config, { backend: false });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    benchManager.startAllComponents("test-project", 1);

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("active");
    });

    expect(execModule.runCommand).toHaveBeenCalledWith(
      "npm",
      ["ci"],
      "/home/.roubo/workspaces/test-project/bench-1",
      undefined,
      300_000,
    );
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ componentSetupState: { backend: true } }),
    );
    expect(processManager.startProcess).toHaveBeenCalled();
    const bench = benchManager.getBench("test-project", 1);
    expect(bench?.components.backend.setupComplete).toBe(true);
  });

  it("second Start (after stop) skips setup and only launches", async () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start", setup: "npm ci" },
      },
    });
    setupBenchWithSetupState(config, { backend: true });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    benchManager.startAllComponents("test-project", 1);

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("active");
    });

    expect(execModule.runCommand).not.toHaveBeenCalled();
    expect(processManager.startProcess).toHaveBeenCalled();
  });

  it("does not run setup for components that have no setup command", async () => {
    setupExistingBench();
    setupProcessMocks();

    benchManager.startAllComponents("test-project", 1);

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("active");
    });

    expect(execModule.runCommand).not.toHaveBeenCalled();
    expect(processManager.startProcess).toHaveBeenCalled();
  });

  it("setup failure halts chain at the failing component, leaves setupComplete: false", async () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start", setup: "npm ci" },
        worker: { type: "process", command: "npm run worker" },
      },
      ports: { backend: { base: 5000 }, worker: { base: 5001 } },
    });
    setupBenchWithSetupState(
      config,
      { backend: false, worker: true },
      { backend: 5001, worker: 5002 },
    );
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "install failed",
    });

    benchManager.startAllComponents("test-project", 1);

    await vi.waitFor(() => {
      const bench = benchManager.getBench("test-project", 1);
      expect(bench?.status).toBe("error");
    });

    const bench = benchManager.getBench("test-project", 1);
    expect(bench?.components.backend.setupComplete).toBe(false);
    expect(bench?.error).toContain("backend");
    expect(processManager.startProcess).not.toHaveBeenCalled();
  });

  it("seeds bench-setup step and runs bench-level setup before components", async () => {
    const config = makeConfig({
      benches: { max: 5, setup: "npm ci" },
      components: {
        backend: { type: "process", command: "npm start" },
      },
    });
    setupBenchWithSetupState(config, { backend: true });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const bench = benchManager.startAllComponents("test-project", 1);
    expect(bench.provisioningSteps[0]).toMatchObject({ id: "bench-setup", status: "pending" });

    await vi.waitFor(() => {
      const b = benchManager.getBench("test-project", 1);
      expect(b?.status).toBe("active");
    });

    expect(execModule.runCommand).toHaveBeenCalledWith(
      "npm",
      ["ci"],
      "/home/.roubo/workspaces/test-project/bench-1",
      undefined,
      600_000,
    );
    const finalBench = benchManager.getBench("test-project", 1);
    expect(finalBench?.provisioningSteps.find((s) => s.id === "bench-setup")?.status).toBe("done");
  });

  it("does not seed bench-setup step when config has no bench-level setup", () => {
    setupExistingBench();
    setupProcessMocks();

    const bench = benchManager.startAllComponents("test-project", 1);

    expect(bench.provisioningSteps.find((s) => s.id === "bench-setup")).toBeUndefined();
  });
});

describe("startComponent (per-component Start setup gating)", () => {
  it("first per-component Start runs setup then launches and persists setupComplete", async () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start", setup: "npm ci" },
      },
    });
    setupBenchWithSetupState(config, { backend: false });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await benchManager.startComponent("test-project", 1, "backend");

    expect(execModule.runCommand).toHaveBeenCalledWith(
      "npm",
      ["ci"],
      "/home/.roubo/workspaces/test-project/bench-1",
      undefined,
      300_000,
    );
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({ componentSetupState: { backend: true } }),
    );
    expect(processManager.startProcess).toHaveBeenCalled();
    const bench = benchManager.getBench("test-project", 1);
    expect(bench?.components.backend.setupComplete).toBe(true);
    expect(bench?.components.backend.status).toBe("running");
  });

  it("second per-component Start skips setup", async () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start", setup: "npm ci" },
      },
    });
    setupBenchWithSetupState(config, { backend: true });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await benchManager.startComponent("test-project", 1, "backend");

    expect(execModule.runCommand).not.toHaveBeenCalled();
    expect(processManager.startProcess).toHaveBeenCalled();
  });

  it("does not run bench-level setup even when configured", async () => {
    const config = makeConfig({
      benches: { max: 5, setup: "npm ci" },
      components: {
        backend: { type: "process", command: "npm start" },
      },
    });
    setupBenchWithSetupState(config, { backend: true });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await benchManager.startComponent("test-project", 1, "backend");

    expect(execModule.runCommand).not.toHaveBeenCalled();
    expect(processManager.startProcess).toHaveBeenCalled();
  });

  it("setup failure leaves setupComplete: false and bench in error", async () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start", setup: "npm ci" },
      },
    });
    setupBenchWithSetupState(config, { backend: false });
    setupProcessMocks();
    vi.mocked(execModule.runCommand).mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "install failed",
    });

    await benchManager.startComponent("test-project", 1, "backend");

    const bench = benchManager.getBench("test-project", 1);
    expect(bench?.status).toBe("error");
    expect(bench?.components.backend.setupComplete).toBe(false);
    expect(processManager.startProcess).not.toHaveBeenCalled();
  });

  it("seeds a single-component provisioning step", async () => {
    const config = makeConfig({
      components: {
        backend: { type: "process", command: "npm start" },
        worker: { type: "process", command: "npm run worker" },
      },
      ports: { backend: { base: 5000 }, worker: { base: 5001 } },
    });
    setupBenchWithSetupState(
      config,
      { backend: true, worker: true },
      { backend: 5001, worker: 5002 },
    );
    setupProcessMocks();

    await benchManager.startComponent("test-project", 1, "backend");

    const bench = benchManager.getBench("test-project", 1);
    expect(bench?.provisioningSteps).toHaveLength(1);
    expect(bench?.provisioningSteps[0].id).toBe(`${COMPONENT_STEP_PREFIX}backend`);
    expect(bench?.provisioningSteps[0].status).toBe("done");
  });
});
