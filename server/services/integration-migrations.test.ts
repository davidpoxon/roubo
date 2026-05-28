import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RegisteredProject, RouboConfig } from "@roubo/shared";

vi.mock("./project-registry.js", () => ({
  onProjectConfigLoaded: vi.fn(),
  getProjects: vi.fn(),
  getProject: vi.fn(),
}));
vi.mock("./derive-github-sources.js", () => ({
  deriveAndPersistGithubSources: vi.fn(),
}));
vi.mock("./integration-overrides.js", () => ({
  loadOverride: vi.fn(),
  getEffectiveWithGlobal: vi.fn(),
  IntegrationOverrideError: class IntegrationOverrideError extends Error {},
}));

import * as projectRegistry from "./project-registry.js";
import * as deriveSources from "./derive-github-sources.js";
import * as overrides from "./integration-overrides.js";
import {
  initializeIntegrationMigrations,
  awaitPendingIntegrationSetup,
} from "./integration-migrations.js";

function projectFixture(id = "demo"): RegisteredProject {
  return {
    id,
    repoPath: "/tmp/" + id,
    config: { project: { name: id } } as unknown as RouboConfig,
    configValid: true,
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  };
}

let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
});

describe("initializeIntegrationMigrations", () => {
  it("subscribes to projectRegistry.onProjectConfigLoaded and sweeps already-loaded projects", () => {
    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      projectFixture("a"),
      { ...projectFixture("b"), configValid: false },
    ]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    initializeIntegrationMigrations();

    expect(projectRegistry.onProjectConfigLoaded).toHaveBeenCalledTimes(1);
    expect(projectRegistry.getProjects).toHaveBeenCalledTimes(1);
    // The sweep only invokes getProject for the valid project.
    expect(projectRegistry.getProject).toHaveBeenCalledTimes(1);
    expect(projectRegistry.getProject).toHaveBeenCalledWith("a");
  });

  it("triggers github-com derivation when sources are missing", async () => {
    const project = projectFixture("a");
    vi.mocked(projectRegistry.getProjects).mockReturnValue([project]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    vi.mocked(overrides.loadOverride).mockReturnValue(null);
    vi.mocked(overrides.getEffectiveWithGlobal).mockReturnValue({
      plugin: "github-com",
      sources: undefined,
    });
    vi.mocked(deriveSources.deriveAndPersistGithubSources).mockResolvedValue(null);

    initializeIntegrationMigrations();
    await awaitPendingIntegrationSetup("a");

    expect(deriveSources.deriveAndPersistGithubSources).toHaveBeenCalledWith("a");
  });

  it("skips derivation when sources are already populated", async () => {
    const project = projectFixture("a");
    vi.mocked(projectRegistry.getProjects).mockReturnValue([project]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    vi.mocked(overrides.loadOverride).mockReturnValue(null);
    vi.mocked(overrides.getEffectiveWithGlobal).mockReturnValue({
      plugin: "github-com",
      sources: { Repository: [{ externalId: "acme/demo" }] },
    });

    initializeIntegrationMigrations();
    await awaitPendingIntegrationSetup("a");

    expect(deriveSources.deriveAndPersistGithubSources).not.toHaveBeenCalled();
  });

  it("skips derivation when active plugin is not github-com", async () => {
    const project = projectFixture("a");
    vi.mocked(projectRegistry.getProjects).mockReturnValue([project]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    vi.mocked(overrides.loadOverride).mockReturnValue(null);
    vi.mocked(overrides.getEffectiveWithGlobal).mockReturnValue({
      plugin: "jira-self-hosted",
      sources: undefined,
    });

    initializeIntegrationMigrations();
    await awaitPendingIntegrationSetup("a");

    expect(deriveSources.deriveAndPersistGithubSources).not.toHaveBeenCalled();
  });

  it("forwards future onProjectConfigLoaded events to the same dispatch path", async () => {
    const project = projectFixture("b");
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    vi.mocked(overrides.loadOverride).mockReturnValue(null);
    vi.mocked(overrides.getEffectiveWithGlobal).mockReturnValue({
      plugin: "github-com",
      sources: undefined,
    });

    let captured: ((project: RegisteredProject) => void) | undefined;
    vi.mocked(projectRegistry.onProjectConfigLoaded).mockImplementation((cb) => {
      captured = cb;
    });
    vi.mocked(deriveSources.deriveAndPersistGithubSources).mockResolvedValue(null);

    initializeIntegrationMigrations();
    if (!captured) throw new Error("listener was not captured");

    captured(project);
    await awaitPendingIntegrationSetup("b");

    expect(deriveSources.deriveAndPersistGithubSources).toHaveBeenCalledWith("b");
  });

  it("de-dupes concurrent migration runs for the same project", async () => {
    const project = projectFixture("a");
    vi.mocked(projectRegistry.getProjects).mockReturnValue([project]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    vi.mocked(overrides.loadOverride).mockReturnValue(null);
    vi.mocked(overrides.getEffectiveWithGlobal).mockReturnValue({
      plugin: "github-com",
      sources: undefined,
    });

    let captured: ((project: RegisteredProject) => void) | undefined;
    vi.mocked(projectRegistry.onProjectConfigLoaded).mockImplementation((cb) => {
      captured = cb;
    });

    let resolveDerive!: () => void;
    vi.mocked(deriveSources.deriveAndPersistGithubSources).mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveDerive = () => resolve(null);
        }),
    );

    initializeIntegrationMigrations(); // sweep triggers run #1 for "a"
    if (!captured) throw new Error("listener was not captured");
    captured(project); // hook fires while run #1 still pending

    resolveDerive();
    await awaitPendingIntegrationSetup("a");

    expect(deriveSources.deriveAndPersistGithubSources).toHaveBeenCalledTimes(1);
  });
});

describe("awaitPendingIntegrationSetup", () => {
  it("resolves immediately when nothing is in flight", async () => {
    await expect(awaitPendingIntegrationSetup("never-touched")).resolves.toBeUndefined();
    expect(deriveSources.deriveAndPersistGithubSources).not.toHaveBeenCalled();
  });

  it("awaits an in-flight derivation before resolving", async () => {
    const project = projectFixture("a");
    vi.mocked(projectRegistry.getProjects).mockReturnValue([project]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    vi.mocked(overrides.loadOverride).mockReturnValue(null);
    vi.mocked(overrides.getEffectiveWithGlobal).mockReturnValue({
      plugin: "github-com",
      sources: undefined,
    });

    let resolveDerive!: () => void;
    let resolved = false;
    vi.mocked(deriveSources.deriveAndPersistGithubSources).mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveDerive = () => {
            resolved = true;
            resolve(null);
          };
        }),
    );

    initializeIntegrationMigrations();
    const awaiter = awaitPendingIntegrationSetup("a");
    expect(resolved).toBe(false);

    resolveDerive();
    await awaiter;
    expect(resolved).toBe(true);
  });
});
