import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeConfig } from "../test/fixtures.js";

vi.mock("./config-parser.js");
vi.mock("./state.js");
vi.mock("./port-allocator.js");

import { parseConfig } from "./config-parser.js";
import * as state from "./state.js";
import { checkPortConflicts } from "./port-allocator.js";

const mockedParseConfig = vi.mocked(parseConfig);
const mockedCheckPortConflicts = vi.mocked(checkPortConflicts);
const mockedLoadProjects = vi.mocked(state.loadProjects);
const mockedAddProject = vi.mocked(state.addProject);
const mockedRemoveProject = vi.mocked(state.removeProject);
const mockedRemoveBench = vi.mocked(state.removeBench);
const mockedGetPersistedBenches = vi.mocked(state.getPersistedBenches);

let registryModule: typeof import("./project-registry.js");

beforeEach(async () => {
  vi.resetModules();
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
});

describe("getProjects", () => {
  it("returns all projects", () => {
    mockedCheckPortConflicts.mockReturnValue([]);

    mockedParseConfig.mockReturnValue({
      valid: true,
      config: makeConfig({
        project: { name: "a", displayName: "A", type: "web", repo: "org/a" },
      }),
    });
    registryModule.registerProject("/repos/a");

    mockedParseConfig.mockReturnValue({
      valid: true,
      config: makeConfig({
        project: { name: "b", displayName: "B", type: "web", repo: "org/b" },
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
        type: "web",
        repo: "org/new",
      },
      ports: { web: { base: 5000 } },
      benches: { max: 5 },
    });

    mockedCheckPortConflicts.mockReturnValue([
      "Port conflict: new-project.web (5000-5004) overlaps with test-project.backend (5000-5004)",
    ]);

    const result = registryModule.checkPortConflictsForConfig(newConfig);

    expect(result).toHaveLength(1);
    expect(result[0].port).toBe("web");
    expect(result[0].conflictsWith.projectId).toBe("test-project");
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
