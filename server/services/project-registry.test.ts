import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { makeConfig } from "../test/fixtures.js";

vi.mock("./config-parser.js");
vi.mock("./state.js");
vi.mock("./port-allocator.js");
// FR-004 / NFR-001: unregisterProject evicts the persistent disk cache for the
// project. Mock the query service so the call-site is asserted without touching
// the real on-disk cache.
const cutListMocks = vi.hoisted(() => ({
  evictPlugin: vi.fn<(id: string) => void>(),
  evictProject: vi.fn<(id: string) => void>(),
}));
vi.mock("./cut-list-query-service.js", () => ({
  cutListQueryService: cutListMocks,
}));

import { parseConfig } from "./config-parser.js";
import * as state from "./state.js";
import { checkPortConflicts, getPortConflicts } from "./port-allocator.js";

const mockedParseConfig = vi.mocked(parseConfig);
const mockedCheckPortConflicts = vi.mocked(checkPortConflicts);
const mockedGetPortConflicts = vi.mocked(getPortConflicts);
const mockedLoadProjects = vi.mocked(state.loadProjects);
const mockedAddProject = vi.mocked(state.addProject);
const mockedRemoveProject = vi.mocked(state.removeProject);
const mockedRemoveBench = vi.mocked(state.removeBench);
const mockedGetPersistedBenches = vi.mocked(state.getPersistedBenches);

let registryModule: typeof import("./project-registry.js");

beforeEach(async () => {
  vi.resetModules();
  cutListMocks.evictPlugin.mockReset();
  cutListMocks.evictProject.mockReset();
  registryModule = await import("./project-registry.js");
});

describe("initialize", () => {
  it("populates from state with valid configs", () => {
    mockedLoadProjects.mockReturnValue({
      projects: [{ id: "project1", repoPath: "/repos/project1" }],
    });
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });

    registryModule.initialize();

    const projects = registryModule.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("project1");
    expect(projects[0].configValid).toBe(true);
  });

  it("handles invalid configs (configValid: false)", () => {
    mockedLoadProjects.mockReturnValue({
      projects: [{ id: "broken", repoPath: "/repos/broken" }],
    });
    mockedParseConfig.mockReturnValue({
      valid: false,
      errors: ["missing field", "bad type"],
    });

    registryModule.initialize();

    const projects = registryModule.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].configValid).toBe(false);
    expect(projects[0].configError).toBe("missing field; bad type");
  });

  it("loads persisted settings.worktreeSource into the in-memory project", () => {
    mockedLoadProjects.mockReturnValue({
      projects: [
        {
          id: "project1",
          repoPath: "/repos/project1",
          settings: { worktreeSource: { branchFromDefault: false, pullLatest: true } },
        },
      ],
    });
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });

    registryModule.initialize();

    const project = registryModule.getProject("project1");
    expect(project?.settings.worktreeSource).toEqual({
      branchFromDefault: false,
      pullLatest: true,
    });
  });

  it("treats a persisted project with no settings as both toggles on (R4 default)", () => {
    mockedLoadProjects.mockReturnValue({
      projects: [{ id: "legacy", repoPath: "/repos/legacy" }],
    });
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });

    registryModule.initialize();

    const project = registryModule.getProject("legacy");
    expect(project?.settings.worktreeSource).toEqual({
      branchFromDefault: true,
      pullLatest: true,
    });
  });

  it("applies R4 default settings to invalid-config projects with no persisted settings", () => {
    mockedLoadProjects.mockReturnValue({
      projects: [{ id: "broken-legacy", repoPath: "/repos/broken-legacy" }],
    });
    mockedParseConfig.mockReturnValue({ valid: false, errors: ["missing field"] });

    registryModule.initialize();

    const project = registryModule.getProject("broken-legacy");
    expect(project?.settings.worktreeSource).toEqual({
      branchFromDefault: true,
      pullLatest: true,
    });
  });
});

describe("onProjectConfigLoaded", () => {
  it("fires on initialize for each project with a valid config", () => {
    mockedLoadProjects.mockReturnValue({
      projects: [
        { id: "valid", repoPath: "/repos/valid" },
        { id: "broken", repoPath: "/repos/broken" },
      ],
    });
    mockedParseConfig
      .mockReturnValueOnce({ valid: true, config: makeConfig() })
      .mockReturnValueOnce({ valid: false, errors: ["bad"] });

    const listener = vi.fn();
    registryModule.onProjectConfigLoaded(listener);
    registryModule.initialize();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ id: "valid", configValid: true });
  });

  it("fires on registerProject after the project is saved", () => {
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });
    mockedCheckPortConflicts.mockReturnValue([]);

    const listener = vi.fn();
    registryModule.onProjectConfigLoaded(listener);
    const project = registryModule.registerProject("/repos/new-project");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(project);
  });

  it("fires on reloadConfig when the new parse is valid", () => {
    mockedLoadProjects.mockReturnValue({
      projects: [{ id: "p1", repoPath: "/repos/p1" }],
    });
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });
    registryModule.initialize();

    const listener = vi.fn();
    registryModule.onProjectConfigLoaded(listener);
    registryModule.reloadConfig("p1");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ id: "p1", configValid: true });
  });

  it("does not fire on reloadConfig when the new parse is invalid", () => {
    mockedLoadProjects.mockReturnValue({
      projects: [{ id: "p1", repoPath: "/repos/p1" }],
    });
    mockedParseConfig.mockReturnValueOnce({ valid: true, config: makeConfig() });
    registryModule.initialize();

    const listener = vi.fn();
    registryModule.onProjectConfigLoaded(listener);
    mockedParseConfig.mockReturnValueOnce({ valid: false, errors: ["broke"] });
    registryModule.reloadConfig("p1");

    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates listener errors with a console.warn and continues notifying the rest", () => {
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });
    mockedCheckPortConflicts.mockReturnValue([]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const after = vi.fn();
    registryModule.onProjectConfigLoaded(throwing);
    registryModule.onProjectConfigLoaded(after);
    registryModule.registerProject("/repos/p1");

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("config-loaded listener threw"),
      "boom",
    );
    warn.mockRestore();
  });
});

describe("registerProject", () => {
  it("succeeds and calls state.addProject", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    const project = registryModule.registerProject("/repos/test-project");

    expect(project.id).toBe("test-project");
    expect(project.configValid).toBe(true);
    expect(project.settings).toEqual({
      worktreeSource: { branchFromDefault: true, pullLatest: true },
    });
    expect(mockedAddProject).toHaveBeenCalledWith({
      id: "test-project",
      repoPath: "/repos/test-project",
      settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    });
  });

  it("normalises a non-normalised repoPath through the safe-path barrier (CodeQL #92)", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    const resolved = path.resolve("/repos/a/b/../test-project");
    const project = registryModule.registerProject("/repos/a/b/../test-project");

    expect(project.repoPath).toBe(resolved);
    expect(mockedParseConfig).toHaveBeenCalledWith(resolved);
    expect(mockedAddProject).toHaveBeenCalledWith(expect.objectContaining({ repoPath: resolved }));
  });

  it("throws INVALID_PATH for a repoPath containing a NUL byte (CodeQL #92)", () => {
    mockedParseConfig.mockClear();
    try {
      registryModule.registerProject("/repos/test\0project");
      expect.unreachable("expected registerProject to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(registryModule.ProjectRegistryError);
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "INVALID_PATH",
      );
    }
    expect(mockedParseConfig).not.toHaveBeenCalled();
  });

  it("throws NO_CONFIG when config not found", () => {
    mockedParseConfig.mockReturnValue({
      valid: false,
      errors: ["roubo.yaml not found at /repos/missing/.roubo/roubo.yaml"],
    });

    expect(() => registryModule.registerProject("/repos/missing")).toThrow(
      registryModule.ProjectRegistryError,
    );

    try {
      registryModule.registerProject("/repos/missing");
    } catch (e) {
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "NO_CONFIG",
      );
    }
  });

  it("throws INVALID_CONFIG when schema invalid", () => {
    mockedParseConfig.mockReturnValue({
      valid: false,
      errors: ['(root): must have required property "project"'],
    });

    try {
      registryModule.registerProject("/repos/bad");
    } catch (e) {
      expect(e).toBeInstanceOf(registryModule.ProjectRegistryError);
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "INVALID_CONFIG",
      );
    }
  });

  it("throws DUPLICATE when already registered", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    registryModule.registerProject("/repos/test-project");

    try {
      registryModule.registerProject("/repos/test-project");
    } catch (e) {
      expect(e).toBeInstanceOf(registryModule.ProjectRegistryError);
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "DUPLICATE",
      );
    }
  });

  it("throws PORT_CONFLICT when conflicts detected", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([
      "Port conflict: test-project.backend (5000-5004) overlaps with other.backend (5002-5006)",
    ]);

    try {
      registryModule.registerProject("/repos/test-project");
    } catch (e) {
      expect(e).toBeInstanceOf(registryModule.ProjectRegistryError);
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "PORT_CONFLICT",
      );
    }
  });
});

describe("unregisterProject", () => {
  it("succeeds and calls state.removeProject", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    registryModule.registerProject("/repos/test-project");

    mockedGetPersistedBenches.mockReturnValue([]);

    registryModule.unregisterProject("test-project");

    expect(mockedRemoveProject).toHaveBeenCalledWith("test-project");
    expect(registryModule.getProject("test-project")).toBeUndefined();
    // FR-004 / NFR-001: unregister evicts the project's persistent disk cache.
    expect(cutListMocks.evictProject).toHaveBeenCalledWith("test-project");
  });

  it("does not evict the disk cache when unregister throws NOT_FOUND", () => {
    try {
      registryModule.unregisterProject("nonexistent");
    } catch {
      // expected
    }
    expect(cutListMocks.evictProject).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND", () => {
    try {
      registryModule.unregisterProject("nonexistent");
    } catch (e) {
      expect(e).toBeInstanceOf(registryModule.ProjectRegistryError);
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "NOT_FOUND",
      );
    }
  });

  it("throws HAS_BENCHES when benches exist", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    registryModule.registerProject("/repos/test-project");

    mockedGetPersistedBenches.mockReturnValue([
      {
        id: 1,
        projectId: "test-project",
        branch: "main",
        workspacePath: "/workspace",
        ports: {},
        createdAt: "now",
      },
    ]);

    try {
      registryModule.unregisterProject("test-project");
    } catch (e) {
      expect(e).toBeInstanceOf(registryModule.ProjectRegistryError);
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "HAS_BENCHES",
      );
    }
  });

  it("force-unregisters by dropping persisted benches", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    registryModule.registerProject("/repos/test-project");

    mockedGetPersistedBenches.mockReturnValue([
      {
        id: 1,
        projectId: "test-project",
        branch: "main",
        workspacePath: "/workspace/1",
        ports: {},
        createdAt: "now",
      },
      {
        id: 2,
        projectId: "test-project",
        branch: "feature",
        workspacePath: "/workspace/2",
        ports: {},
        createdAt: "now",
      },
    ]);

    registryModule.unregisterProject("test-project", { force: true });

    expect(mockedRemoveBench).toHaveBeenCalledWith("test-project", 1);
    expect(mockedRemoveBench).toHaveBeenCalledWith("test-project", 2);
    expect(mockedRemoveProject).toHaveBeenCalledWith("test-project");
    expect(registryModule.getProject("test-project")).toBeUndefined();
  });

  it("is blocked by an out-of-range bench, then succeeds once it is cleared (davidpoxon/roubo-development#21)", () => {
    // makeConfig sets benches.max = 5, but a bench with id 7 is persisted (its
    // id fell out of range after benches.max was lowered). The guard counts
    // every persisted bench regardless of range, so unregister is blocked until
    // the orphan is surfaced in the UI and cleared.
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    registryModule.registerProject("/repos/test-project");

    // The state mocks accumulate calls across tests in this file (only the
    // cut-list mocks are reset in beforeEach), so clear the ones asserted below.
    mockedRemoveProject.mockClear();
    mockedRemoveBench.mockClear();

    mockedGetPersistedBenches.mockReturnValue([
      {
        id: 7,
        projectId: "test-project",
        branch: "feature",
        workspacePath: "/workspace/7",
        ports: {},
        createdAt: "now",
      },
    ]);

    try {
      registryModule.unregisterProject("test-project");
      expect.unreachable("expected unregisterProject to throw HAS_BENCHES");
    } catch (e) {
      expect(e).toBeInstanceOf(registryModule.ProjectRegistryError);
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "HAS_BENCHES",
      );
    }
    expect(mockedRemoveProject).not.toHaveBeenCalled();
    expect(cutListMocks.evictProject).not.toHaveBeenCalled();

    // The user clears the orphan via the normal Clear action, which removes its
    // state.json record. With no persisted benches left, unregister succeeds.
    mockedGetPersistedBenches.mockReturnValue([]);

    registryModule.unregisterProject("test-project");

    expect(mockedRemoveProject).toHaveBeenCalledWith("test-project");
    expect(registryModule.getProject("test-project")).toBeUndefined();
    expect(cutListMocks.evictProject).toHaveBeenCalledWith("test-project");
  });
});

describe("getProjects", () => {
  it("returns all projects", () => {
    mockedCheckPortConflicts.mockReturnValue([]);

    mockedParseConfig.mockReturnValue({
      valid: true,
      config: makeConfig({
        project: { name: "a", displayName: "A", repo: "org/a" },
      }),
    });
    registryModule.registerProject("/repos/a");

    mockedParseConfig.mockReturnValue({
      valid: true,
      config: makeConfig({
        project: { name: "b", displayName: "B", repo: "org/b" },
      }),
    });
    registryModule.registerProject("/repos/b");

    const projects = registryModule.getProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((a) => a.id).sort()).toEqual(["a", "b"]);
  });
});

describe("getProject", () => {
  it("returns undefined for unknown id", () => {
    expect(registryModule.getProject("unknown")).toBeUndefined();
  });
});

describe("reloadConfig", () => {
  it("updates existing project", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    registryModule.registerProject("/repos/test-project");

    const updatedConfig = makeConfig({
      project: { ...config.project, displayName: "Updated" },
    });
    mockedParseConfig.mockReturnValue({ valid: true, config: updatedConfig });

    const result = registryModule.reloadConfig("test-project");

    expect(result.config.project.displayName).toBe("Updated");
    expect(result.configValid).toBe(true);
  });

  it("throws NOT_FOUND for unknown", () => {
    try {
      registryModule.reloadConfig("nonexistent");
    } catch (e) {
      expect(e).toBeInstanceOf(registryModule.ProjectRegistryError);
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "NOT_FOUND",
      );
    }
  });
});

describe("checkPortConflictsForConfig", () => {
  it("works correctly", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    registryModule.registerProject("/repos/test-project");

    const newConfig = makeConfig({
      project: {
        name: "new-project",
        displayName: "New",
        repo: "org/new",
      },
      ports: { web: { base: 5000 } },
      benches: { max: 5 },
    });

    mockedGetPortConflicts.mockReturnValue([
      {
        newRange: { name: "web", projectId: "new-project", low: 5000, high: 5004 },
        existingRange: { name: "backend", projectId: "test-project", low: 5000, high: 5004 },
      },
    ]);

    const result = registryModule.checkPortConflictsForConfig(newConfig);

    expect(result).toHaveLength(1);
    expect(result[0].port).toBe("web");
    expect(result[0].conflictsWith.projectId).toBe("test-project");
    expect(result[0].conflictsWith.port).toBe("backend");
    expect(result[0].conflictsWith.range).toEqual([5000, 5004]);
  });
});

describe("updateProjectSettings", () => {
  it("updates in-memory settings and writes via state.addProject", () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });
    mockedCheckPortConflicts.mockReturnValue([]);

    registryModule.registerProject("/repos/test-project");
    mockedAddProject.mockClear();

    const next = { worktreeSource: { branchFromDefault: false, pullLatest: false } };
    const updated = registryModule.updateProjectSettings("test-project", next);

    expect(updated.settings).toEqual(next);
    expect(registryModule.getProject("test-project")?.settings).toEqual(next);
    expect(mockedAddProject).toHaveBeenCalledWith({
      id: "test-project",
      repoPath: "/repos/test-project",
      settings: next,
    });
  });

  it("throws NOT_FOUND for unknown project", () => {
    const next = { worktreeSource: { branchFromDefault: true, pullLatest: true } };
    expect(() => registryModule.updateProjectSettings("nope", next)).toThrow(
      registryModule.ProjectRegistryError,
    );
    try {
      registryModule.updateProjectSettings("nope", next);
    } catch (e) {
      expect((e as InstanceType<typeof registryModule.ProjectRegistryError>).code).toBe(
        "NOT_FOUND",
      );
    }
  });
});

describe("ProjectRegistryError", () => {
  it("has correct name and code", () => {
    const err = new registryModule.ProjectRegistryError("test message", "TEST_CODE");
    expect(err.name).toBe("ProjectRegistryError");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err).toBeInstanceOf(Error);
  });
});
