import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import type { PluginManifest } from "@roubo/shared";
import { makeConfig } from "../test/fixtures.js";

vi.mock("./config-parser.js");
vi.mock("./state.js");
vi.mock("./port-allocator.js");
// #884: the registry validates a project's component bindings against the
// installed component-kind manifests. Mock the plugin-manager boundary so the
// second pass runs against a controlled manifest set (and to keep the real,
// heavy plugin-manager module out of these unit tests). The default set carries
// the "process" component the shared fixture binds to, so makeConfig-based
// projects stay valid unless a test overrides it.
const pluginManagerMocks = vi.hoisted(() => ({
  getComponentManifests: vi.fn<() => PluginManifest[]>(() => []),
}));
vi.mock("./plugin-manager.js", () => pluginManagerMocks);
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

// A minimal component-kind manifest for the "process" plugin the shared fixture
// binds to. No configSchema, so validateComponentBindings accepts any config
// block for it: makeConfig-based projects stay valid under the second pass.
const PROCESS_MANIFEST = { id: "process", kind: "component" } as unknown as PluginManifest;

// The same "process" plugin, but declaring a configSchema that REQUIRES a numeric
// `port`. The shared fixture's { command } config omits it, so this manifest
// makes the second pass fail with a path-keyed configSchema error (rule 2). Used
// by the tests that need the LOADED-plugin invalidation path, since config-load
// is now lenient about a not-loaded plugin (#884).
const PROCESS_REQUIRES_PORT_MANIFEST = {
  id: "process",
  kind: "component",
  configSchema: {
    type: "object",
    required: ["port"],
    properties: { port: { type: "number" } },
  },
} as unknown as PluginManifest;

beforeEach(async () => {
  vi.resetModules();
  cutListMocks.evictPlugin.mockReset();
  cutListMocks.evictProject.mockReset();
  pluginManagerMocks.getComponentManifests.mockReset().mockReturnValue([PROCESS_MANIFEST]);
  mockedCheckPortConflicts.mockReturnValue([]);
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

describe("applyProjectsFileEdit (HR-FR-012)", () => {
  it("applies the changed settings of a registered project", async () => {
    mockedLoadProjects.mockReturnValue({
      projects: [
        { id: "project1", repoPath: "/repos/project1" },
        { id: "project2", repoPath: "/repos/project2" },
      ],
    });
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });
    registryModule.initialize();
    const before2 = registryModule.getProject("project2")?.settings;

    const edit = await registryModule.applyProjectsFileEdit({
      projects: [
        {
          id: "project1",
          repoPath: "/repos/project1",
          settings: { worktreeSource: { branchFromDefault: false, pullLatest: true } },
        },
        { id: "project2", repoPath: "/repos/project2" },
      ],
    });

    expect(edit).toEqual({
      outcome: "applied",
      registered: [],
      repathed: [],
      unregistered: [],
      refused: [],
      settingsChanged: ["project1"],
    });
    expect(registryModule.getProject("project1")?.settings.worktreeSource).toEqual({
      branchFromDefault: false,
      pullLatest: true,
    });
    expect(registryModule.getProject("project2")?.settings).toEqual(before2);
    expect(registryModule.getProjects()).toHaveLength(2);
  });

  it("changes nothing when the edit leaves every registered project as it is", async () => {
    mockedLoadProjects.mockReturnValue({
      projects: [{ id: "project1", repoPath: "/repos/project1" }],
    });
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });
    registryModule.initialize();

    expect(
      await registryModule.applyProjectsFileEdit({
        projects: [{ id: "project1", repoPath: "/repos/project1" }],
      }),
    ).toEqual({
      outcome: "applied",
      registered: [],
      repathed: [],
      unregistered: [],
      refused: [],
      settingsChanged: [],
    });
  });
});

describe("applyProjectsFileEdit project set (HR-FR-014)", () => {
  function lifecycle(): import("./project-registry.js").ProjectLifecycleEvent[] {
    const events: import("./project-registry.js").ProjectLifecycleEvent[] = [];
    registryModule.onProjectLifecycle((e) => events.push(e));
    return events;
  }

  beforeEach(() => {
    mockedLoadProjects.mockReturnValue({
      projects: [{ id: "lantern", repoPath: "/repos/lantern" }],
    });
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });
    mockedGetPersistedBenches.mockReturnValue([]);
    vi.mocked(state.saveProjects).mockReset();
    registryModule.initialize();
  });

  it("HR-TC-026 registers a project added by hand and tells the lifecycle listeners", async () => {
    const events = lifecycle();
    const edit = await registryModule.applyProjectsFileEdit({
      projects: [
        { id: "lantern", repoPath: "/repos/lantern" },
        { id: "lantern-2", repoPath: "/repos/lantern-2" },
      ],
    });

    expect(edit).toMatchObject({
      outcome: "applied",
      registered: [{ projectId: "lantern-2", repoPath: "/repos/lantern-2" }],
    });
    expect(registryModule.getProject("lantern-2")).toMatchObject({
      repoPath: "/repos/lantern-2",
      configValid: true,
    });
    expect(events).toEqual([
      { kind: "registered", project: registryModule.getProject("lantern-2") },
    ]);
    expect(mockedParseConfig).toHaveBeenLastCalledWith("/repos/lantern-2");
  });

  it("HR-TC-026 registers a project added with an invalid roubo.yaml config-invalid, as a relaunch loads it", async () => {
    mockedParseConfig.mockReturnValueOnce({ valid: false, errors: ["roubo.yaml not found"] });
    const edit = await registryModule.applyProjectsFileEdit({
      projects: [
        { id: "lantern", repoPath: "/repos/lantern" },
        { id: "lantern-2", repoPath: "/repos/lantern-2" },
      ],
    });

    expect(edit.outcome).toBe("applied");
    expect(registryModule.getProject("lantern-2")).toMatchObject({
      configValid: false,
      configError: "roubo.yaml not found",
    });
  });

  it("HR-TC-032 re-paths a project whose record has a new path, and marks its benches stale", async () => {
    const { isBenchStaleFromRepath } = await import("./project-repath-state.js");
    registryModule.registerLiveBenchSource({
      listBenchIds: () => [2],
      dropBenches: () => 0,
      removeWorkspaces: () => Promise.resolve({ leftovers: [] }),
    });
    const events = lifecycle();
    const edit = await registryModule.applyProjectsFileEdit({
      projects: [{ id: "lantern", repoPath: "/repos/lantern-moved" }],
    });

    expect(edit).toMatchObject({
      outcome: "applied",
      registered: [],
      unregistered: [],
      repathed: [{ projectId: "lantern", repoPath: "/repos/lantern-moved", staleBenchIds: [2] }],
    });
    expect(registryModule.getProject("lantern")?.repoPath).toBe("/repos/lantern-moved");
    expect(mockedParseConfig).toHaveBeenLastCalledWith("/repos/lantern-moved");
    expect(events).toEqual([
      {
        kind: "repathed",
        project: registryModule.getProject("lantern"),
        previousRepoPath: "/repos/lantern",
      },
    ]);
    expect(isBenchStaleFromRepath("lantern", 2)).toBe(true);
    registryModule.registerLiveBenchSource(null);
  });

  it("HR-TC-033 unregisters a project removed by hand and tells the lifecycle listeners", async () => {
    const events = lifecycle();
    const edit = await registryModule.applyProjectsFileEdit({ projects: [] });

    expect(edit).toMatchObject({ outcome: "applied", unregistered: ["lantern"] });
    expect(registryModule.getProject("lantern")).toBeUndefined();
    expect(cutListMocks.evictProject).toHaveBeenCalledWith("lantern");
    expect(events).toEqual([
      { kind: "unregistered", projectId: "lantern", repoPath: "/repos/lantern" },
    ]);
    // The file already lacks the project, so nothing is written back.
    expect(state.saveProjects).not.toHaveBeenCalled();
    expect(mockedRemoveProject).not.toHaveBeenCalled();
  });

  it("refuses to unregister a project removed by hand that has active benches, and writes it back", async () => {
    mockedGetPersistedBenches.mockReturnValue([
      { id: 3, projectId: "lantern", branch: "b", workspacePath: "/w", ports: {} },
    ] as never);
    const events = lifecycle();
    const edit = await registryModule.applyProjectsFileEdit({ projects: [] });

    expect(edit).toMatchObject({
      outcome: "applied",
      unregistered: [],
      refused: [{ projectId: "lantern", benchIds: [3] }],
    });
    expect(registryModule.getProject("lantern")).toBeDefined();
    expect(events).toEqual([]);
    expect(state.saveProjects).toHaveBeenCalledWith({
      projects: [
        {
          id: "lantern",
          repoPath: "/repos/lantern",
          settings: registryModule.getProject("lantern")?.settings,
        },
      ],
    });
  });

  it.each([
    ["no repoPath", [{ id: "lantern-2" }], "project lantern-2 has no repoPath"],
    [
      "a relative repoPath",
      [{ id: "lantern-2", repoPath: "Developer/lantern-2" }],
      "repoPath of project lantern-2 is not an absolute path",
    ],
    [
      "a duplicate id",
      [
        { id: "lantern-2", repoPath: "/repos/a" },
        { id: "lantern-2", repoPath: "/repos/b" },
      ],
      "project lantern-2 is listed twice",
    ],
  ])(
    "rejects the whole file for an entry with %s and keeps the registry",
    async (_, added, first) => {
      const events = lifecycle();
      const edit = await registryModule.applyProjectsFileEdit({
        projects: [
          {
            id: "lantern",
            repoPath: "/repos/lantern",
            settings: { worktreeSource: { branchFromDefault: false, pullLatest: false } },
          },
          ...(added as { id: string; repoPath: string }[]),
        ],
      });

      expect(edit).toEqual({ outcome: "rejected", first });
      expect(registryModule.getProjects().map((p) => p.id)).toEqual(["lantern"]);
      expect(registryModule.getProject("lantern")?.settings.worktreeSource).toEqual({
        branchFromDefault: true,
        pullLatest: true,
      });
      expect(events).toEqual([]);
    },
  );

  it("rejects the whole file when an added project's ports overlap another's", async () => {
    mockedCheckPortConflicts.mockImplementation((project) =>
      project.id === "lantern-2" ? ["Port conflict: lantern-2.web overlaps with lantern.web"] : [],
    );
    const edit = await registryModule.applyProjectsFileEdit({
      projects: [{ id: "lantern-2", repoPath: "/repos/lantern-2" }],
    });

    expect(edit).toEqual({
      outcome: "rejected",
      first: "Port conflict: lantern-2.web overlaps with lantern.web",
    });
    // Nothing of it applied: the removal of lantern included.
    expect(registryModule.getProjects().map((p) => p.id)).toEqual(["lantern"]);
    expect(registryModule.getProject("lantern-2")).toBeUndefined();
    mockedCheckPortConflicts.mockReset().mockReturnValue([]);
  });
});

describe("project lifecycle in the app (HR-FR-014)", () => {
  it("tells the lifecycle listeners of an app register and unregister", async () => {
    mockedLoadProjects.mockReturnValue({ projects: [] });
    mockedGetPersistedBenches.mockReturnValue([]);
    registryModule.initialize();
    const events: import("./project-registry.js").ProjectLifecycleEvent[] = [];
    registryModule.onProjectLifecycle((e) => events.push(e));
    mockedParseConfig.mockReturnValue({ valid: true, config: makeConfig() });

    const project = registryModule.registerProject("/repos/test-project");
    await registryModule.unregisterProject(project.id);

    expect(events).toEqual([
      { kind: "registered", project },
      { kind: "unregistered", projectId: project.id, repoPath: "/repos/test-project" },
    ]);
  });
});
