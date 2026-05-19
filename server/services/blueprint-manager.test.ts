import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
  getProjects: vi.fn().mockReturnValue([]),
}));

vi.mock("./state.js", () => ({
  loadSettings: vi.fn().mockReturnValue({ theme: "dark" }),
  getRouboDir: vi.fn().mockReturnValue("/mock-home/.roubo"),
}));

vi.mock("./config-parser.js", () => ({
  resolveTemplate: vi.fn((content: string) => content),
}));

import * as projectRegistry from "./project-registry.js";
import * as state from "./state.js";
import { resolveTemplate } from "./config-parser.js";
import {
  loadBlueprintFile,
  listBlueprintsForProject,
  listGlobalBlueprints,
  getBlueprint,
  resolveBlueprintContent,
  getDefaultBlueprintId,
  resolveEffectiveDefaultBlueprint,
  resolveBlueprintForIssue,
  invalidateCache,
  slugify,
  createAppBlueprint,
  updateAppBlueprint,
  deleteAppBlueprint,
  findAppBlueprintReferences,
  getAppBlueprint,
  createProjectBlueprint,
  updateProjectBlueprint,
  deleteProjectBlueprint,
  getProjectBlueprint,
  findProjectBlueprintReferences,
  BlueprintError,
} from "./blueprint-manager.js";

const VALID_FRONTMATTER = `---
name: Test Blueprint
description: A test blueprint for unit tests
icon: code
---
This is the blueprint body.
`;

const NO_FRONTMATTER = `This is just plain text with no frontmatter.`;

const INVALID_YAML = `---
name: [unclosed
---
Body here.
`;

const MISSING_FIELDS = `---
icon: code
---
Body here.
`;

describe("loadBlueprintFile", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-test-"));
    tmpFile = path.join(tmpDir, "test-blueprint.md");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a valid blueprint file", () => {
    fs.writeFileSync(tmpFile, VALID_FRONTMATTER);
    const result = loadBlueprintFile(tmpFile);
    if (!result) throw new Error("Expected result to not be null");
    expect(result.id).toBe("test-blueprint");
    expect(result.name).toBe("Test Blueprint");
    expect(result.description).toBe("A test blueprint for unit tests");
    expect(result.icon).toBe("code");
    expect(result.content).toBe("This is the blueprint body.\n");
    expect(result.sizeWarning).toBe(false);
  });

  it("returns null for non-existent file", () => {
    expect(loadBlueprintFile("/nonexistent/path/blueprint.md")).toBeNull();
  });

  it("returns null when frontmatter is missing", () => {
    fs.writeFileSync(tmpFile, NO_FRONTMATTER);
    expect(loadBlueprintFile(tmpFile)).toBeNull();
  });

  it("returns null for invalid YAML frontmatter", () => {
    fs.writeFileSync(tmpFile, INVALID_YAML);
    expect(loadBlueprintFile(tmpFile)).toBeNull();
  });

  it("returns null when required frontmatter fields are missing", () => {
    fs.writeFileSync(tmpFile, MISSING_FIELDS);
    expect(loadBlueprintFile(tmpFile)).toBeNull();
  });

  it('defaults icon to "file-text" when not specified', () => {
    const content = `---\nname: No Icon\ndescription: Has no icon field\n---\nBody.\n`;
    fs.writeFileSync(tmpFile, content);
    const result = loadBlueprintFile(tmpFile);
    if (!result) throw new Error("Expected result to not be null");
    expect(result.icon).toBe("file-text");
  });

  it("rejects files over the 200KB hard limit", () => {
    const bigContent =
      `---\nname: Big Blueprint\ndescription: A very big blueprint\n---\n` + "x".repeat(210 * 1024);
    fs.writeFileSync(tmpFile, bigContent);
    expect(loadBlueprintFile(tmpFile)).toBeNull();
  });

  it("sets sizeWarning for files over 50KB", () => {
    const body = "x".repeat(55 * 1024);
    const content = `---\nname: Biggish Blueprint\ndescription: Over soft limit\n---\n${body}`;
    fs.writeFileSync(tmpFile, content);
    const result = loadBlueprintFile(tmpFile);
    if (!result) throw new Error("Expected result to not be null");
    expect(result.sizeWarning).toBe(true);
  });
});

describe("listBlueprintsForProject", () => {
  beforeEach(() => {
    invalidateCache();
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
  });

  it("returns the embedded global default when no project is found", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const blueprints = listBlueprintsForProject("unknown-project");
    const def = blueprints.find((p) => p.id === "__global_default__");
    if (!def) throw new Error("Expected global default blueprint");
    expect(def.source).toBe("app");
    expect(def.name).toBe("Default");
  });

  it("lists the embedded global default first", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const blueprints = listBlueprintsForProject("project-1");
    expect(blueprints[0].id).toBe("__global_default__");
  });

  it("does not include feature-dev, cleanup, or push built-ins", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const blueprints = listBlueprintsForProject("project-1");
    const ids = blueprints.map((p) => p.id);
    expect(ids).not.toContain("feature-dev");
    expect(ids).not.toContain("cleanup");
    expect(ids).not.toContain("push");
  });

  it("does not include content in returned BlueprintMeta", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const blueprints = listBlueprintsForProject("project-1");
    for (const blueprint of blueprints) {
      expect(blueprint).not.toHaveProperty("content");
    }
  });

  it("returns cached data within TTL", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const first = listBlueprintsForProject("project-1");
    const second = listBlueprintsForProject("project-1");
    expect(first).toBe(second); // same reference — cache hit
  });

  it("re-reads data after cache TTL expires", () => {
    vi.useFakeTimers();
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const first = listBlueprintsForProject("project-1");
    vi.advanceTimersByTime(61_000);
    invalidateCache(); // simulate TTL expiry by invalidating
    const second = listBlueprintsForProject("project-1");
    expect(second).not.toBe(first); // new reference — cache miss after invalidation

    vi.useRealTimers();
  });

  it("repo blueprints override built-ins with same id", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-blueprints-"));
    const blueprintsDir = path.join(tmpDir, ".roubo", "blueprints");
    fs.mkdirSync(blueprintsDir, { recursive: true });

    fs.writeFileSync(
      path.join(blueprintsDir, "feature-dev.md"),
      `---\nname: Custom Feature Dev\ndescription: Repo-level override\nicon: star\n---\nCustom content.\n`,
    );

    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "test-project",
      name: "Test Project",
      repoPath: tmpDir,
      config: null,
    } as unknown as ReturnType<typeof projectRegistry.getProject>);

    invalidateCache();
    const blueprints = listBlueprintsForProject("test-project");
    const featureDev = blueprints.find((p) => p.id === "feature-dev");
    if (!featureDev) throw new Error("Expected feature-dev blueprint to be defined");
    expect(featureDev.source).toBe("project");
    expect(featureDev.name).toBe("Custom Feature Dev");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("listGlobalBlueprints", () => {
  it("includes the embedded global default with source=app", () => {
    vi.mocked(state.getRouboDir).mockReturnValue("/mock-home/.roubo");
    const blueprints = listGlobalBlueprints();
    const def = blueprints.find((p) => p.id === "__global_default__");
    if (!def) throw new Error("Expected global default in global blueprints");
    expect(def.source).toBe("app");
    expect(def.name).toBe("Default");
  });

  it("does not include content in returned BlueprintMeta", () => {
    const blueprints = listGlobalBlueprints();
    for (const blueprint of blueprints) {
      expect(blueprint).not.toHaveProperty("content");
    }
  });
});

describe("getBlueprint", () => {
  beforeEach(() => {
    invalidateCache();
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
  });

  it("returns the embedded global default for GLOBAL_DEFAULT_BLUEPRINT_ID", () => {
    const blueprint = getBlueprint("project-1", "__global_default__");
    if (!blueprint) throw new Error("Expected blueprint to not be null");
    expect(blueprint.id).toBe("__global_default__");
    expect(typeof blueprint.content).toBe("string");
    expect(blueprint.content.length).toBeGreaterThan(0);
    expect(blueprint.source).toBe("app");
    expect(blueprint.sizeWarning).toBe(false);
  });

  it("returns null for unknown blueprint id", () => {
    const blueprint = getBlueprint("project-1", "nonexistent-blueprint");
    expect(blueprint).toBeNull();
  });

  it("returns null for deleted built-in ids like feature-dev", () => {
    expect(getBlueprint("project-1", "feature-dev")).toBeNull();
    expect(getBlueprint("project-1", "cleanup")).toBeNull();
    expect(getBlueprint("project-1", "push")).toBeNull();
  });

  it("returns a copy of the embedded default — mutations do not affect the singleton", () => {
    const a = getBlueprint("project-1", "__global_default__");
    const b = getBlueprint("project-1", "__global_default__");
    if (!a || !b) throw new Error("Expected both blueprints to be defined");
    a.name = "Mutated";
    expect(b.name).toBe("Default");
  });

  it("returns user-global blueprint content for user-authored blueprints", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-global-blueprints-"));
    const blueprintsDir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(blueprintsDir, { recursive: true });
    fs.writeFileSync(
      path.join(blueprintsDir, "my-custom.md"),
      `---\nname: My Custom\ndescription: User-global custom\nicon: star\n---\nCustom content.\n`,
    );

    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    invalidateCache();

    const detail = getBlueprint("project-1", "my-custom");
    if (!detail) throw new Error("Expected blueprint detail to not be null");
    expect(detail.source).toBe("app");
    expect(detail.content).toContain("Custom content.");

    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(state.getRouboDir).mockReturnValue("/mock-home/.roubo");
  });

  it("ignores user-global blueprint with reserved __global_default__ id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-global-blueprints-"));
    const blueprintsDir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(blueprintsDir, { recursive: true });
    fs.writeFileSync(
      path.join(blueprintsDir, "__global_default__.md"),
      `---\nname: Hijacked\ndescription: Attempt to override reserved id\nicon: skull\n---\nHijacked content.\n`,
    );

    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    invalidateCache();

    // Trigger the merge — warning fires here and the reserved id is excluded from the list
    const blueprints = listBlueprintsForProject("project-1");
    const entry = blueprints.find((p) => p.id === "__global_default__");
    if (!entry) throw new Error("Expected global default to remain in list");
    expect(entry.name).toBe("Default");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("reserved id '__global_default__'"),
    );

    // getBlueprint short-circuits for the sentinel and always returns the embedded default
    const blueprint = getBlueprint("project-1", "__global_default__");
    if (!blueprint) throw new Error("Expected embedded default to remain");
    expect(blueprint.name).toBe("Default");

    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(state.getRouboDir).mockReturnValue("/mock-home/.roubo");
  });
});

describe("resolveBlueprintContent", () => {
  beforeEach(() => {
    vi.mocked(resolveTemplate).mockImplementation((content: string) => content);
  });

  it("calls resolveTemplate for first pass", () => {
    resolveBlueprintContent("Hello {{bench.branch}}", {
      ports: {},
      portHttps: {},
      workspace: "/workspace",
      components: {},
      benchBranch: "main",
    });
    expect(resolveTemplate).toHaveBeenCalled();
  });

  it("resolves bench.branch", () => {
    const result = resolveBlueprintContent("Branch: {{bench.branch}}", {
      ports: {},
      portHttps: {},
      workspace: "/workspace",
      components: {},
      benchBranch: "feature/my-feature",
    });
    expect(result).toBe("Branch: feature/my-feature");
  });

  it("resolves bench.id", () => {
    const result = resolveBlueprintContent("Bench: {{bench.id}}", {
      ports: {},
      portHttps: {},
      workspace: "/workspace",
      components: {},
      benchId: 2,
    });
    expect(result).toBe("Bench: 2");
  });

  it("resolves project.name", () => {
    const result = resolveBlueprintContent("Project: {{project.name}}", {
      ports: {},
      portHttps: {},
      workspace: "/workspace",
      components: {},
      projectName: "project",
    });
    expect(result).toBe("Project: project");
  });

  it("resolves issue variables", () => {
    const result = resolveBlueprintContent(
      "{{issueNumber}} {{issueTitle}} {{issueUrl}}\n{{issueBody}}\n{{comments}}",
      {
        ports: {},
        portHttps: {},
        workspace: "/workspace",
        components: {},
        issueNumber: 42,
        issueTitle: "Fix login bug",
        issueUrl: "https://github.com/org/repo/issues/42",
        issueBody: "The login page is broken.",
        comments: "Comment 1\nComment 2",
      },
    );
    expect(result).toBe(
      "42 Fix login bug https://github.com/org/repo/issues/42\nThe login page is broken.\nComment 1\nComment 2",
    );
  });

  it("leaves unknown variables unreplaced", () => {
    const result = resolveBlueprintContent("{{unknown.variable}}", {
      ports: {},
      portHttps: {},
      workspace: "/workspace",
      components: {},
    });
    expect(result).toBe("{{unknown.variable}}");
  });

  it("emits empty string for missing optional issue fields", () => {
    const result = resolveBlueprintContent("{{issueNumber}} {{issueTitle}}", {
      ports: {},
      portHttps: {},
      workspace: "/workspace",
      components: {},
    });
    expect(result).toBe(" ");
  });
});

describe("getDefaultBlueprintId", () => {
  beforeEach(() => {
    invalidateCache();
  });

  it("returns GLOBAL_DEFAULT_BLUEPRINT_ID when no settings or project config override", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    expect(getDefaultBlueprintId("project-1")).toBe("__global_default__");
  });

  it("returns settings.blueprints.defaultBlueprintId when it resolves to a real blueprint", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "default-bp-test-"));
    const blueprintsDir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(blueprintsDir, { recursive: true });
    fs.writeFileSync(
      path.join(blueprintsDir, "my-workflow.md"),
      `---\nname: My Workflow\ndescription: A custom workflow\n---\nDo the thing.\n`,
    );
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "my-workflow" },
    });
    invalidateCache();
    expect(getDefaultBlueprintId("project-1")).toBe("my-workflow");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(state.getRouboDir).mockReturnValue("/mock-home/.roubo");
  });

  it("falls back to GLOBAL_DEFAULT_BLUEPRINT_ID when settings reference a deleted built-in id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "feature-dev" },
    });
    expect(getDefaultBlueprintId("project-1")).toBe("__global_default__");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'feature-dev'"));
  });

  it("falls through to GLOBAL_DEFAULT_BLUEPRINT_ID when project config references a non-existent blueprint and no app default is set", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      name: "Project 1",
      repoPath: "/repo-without-blueprints",
      config: {
        project: { name: "Project 1" },
        blueprints: { defaultBlueprint: "deleted-blueprint" },
      },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    invalidateCache();
    expect(getDefaultBlueprintId("project-1")).toBe("__global_default__");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'deleted-blueprint'"));
  });

  it("returns project config override when it resolves to a real blueprint", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "default-bp-test-"));
    const repoBlueprints = path.join(tmpDir, ".roubo", "blueprints");
    fs.mkdirSync(repoBlueprints, { recursive: true });
    fs.writeFileSync(
      path.join(repoBlueprints, "project-flow.md"),
      `---\nname: Project Flow\ndescription: Repo-level workflow\n---\nCustom flow.\n`,
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      name: "Project 1",
      repoPath: tmpDir,
      config: {
        project: { name: "Project 1" },
        blueprints: { defaultBlueprint: "project-flow" },
      },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    invalidateCache();
    expect(getDefaultBlueprintId("project-1")).toBe("project-flow");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("getDefaultBlueprintId cascade", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-test-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(state.getRouboDir).mockReturnValue("/mock-home/.roubo");
    vi.restoreAllMocks();
  });

  function makeAppBlueprint(name: string) {
    const dir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: test\n---\nContent.\n`,
    );
  }

  function makeProjectBlueprint(repoPath: string, name: string) {
    const dir = path.join(repoPath, ".roubo", "blueprints");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: test\n---\nContent.\n`,
    );
  }

  it("falls through from invalid project default to valid app default", () => {
    const repoDir = path.join(tmpDir, "repo");
    makeAppBlueprint("app-bp");
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: repoDir,
      config: { project: { name: "p" }, blueprints: { defaultBlueprint: "deleted-project-bp" } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "app-bp" },
    });
    invalidateCache();
    expect(getDefaultBlueprintId("project-1")).toBe("app-bp");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'deleted-project-bp'"));
  });

  it("falls through from invalid app default to global when project default is also missing", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "nonexistent-app-bp" },
    });
    expect(getDefaultBlueprintId("project-1")).toBe("__global_default__");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'nonexistent-app-bp'"));
  });

  it("falls through from invalid project default through invalid app default to global", () => {
    const repoDir = path.join(tmpDir, "repo");
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: repoDir,
      config: { project: { name: "p" }, blueprints: { defaultBlueprint: "deleted-project-bp" } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "deleted-app-bp" },
    });
    invalidateCache();
    expect(getDefaultBlueprintId("project-1")).toBe("__global_default__");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("project wins over valid app default when project blueprint exists", () => {
    const repoDir = path.join(tmpDir, "repo");
    makeAppBlueprint("app-bp");
    makeProjectBlueprint(repoDir, "project-bp");
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: repoDir,
      config: { project: { name: "p" }, blueprints: { defaultBlueprint: "project-bp" } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "app-bp" },
    });
    invalidateCache();
    expect(getDefaultBlueprintId("project-1")).toBe("project-bp");
  });
});

describe("resolveEffectiveDefaultBlueprint", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-test-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(state.getRouboDir).mockReturnValue("/mock-home/.roubo");
    vi.restoreAllMocks();
  });

  it("returns global source when nothing is configured", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    const result = resolveEffectiveDefaultBlueprint("project-1");
    expect(result).toEqual({ blueprintId: "__global_default__", source: "global" });
  });

  it("returns app source when only app default is set", () => {
    const dir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "app-bp.md"),
      "---\nname: App\ndescription: d\n---\nContent.\n",
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "app-bp" },
    });
    invalidateCache();
    const result = resolveEffectiveDefaultBlueprint("project-1");
    expect(result).toEqual({ blueprintId: "app-bp", source: "app" });
  });

  it("returns project source when project default is set and valid", () => {
    const repoDir = path.join(tmpDir, "repo");
    const repoBlueprints = path.join(repoDir, ".roubo", "blueprints");
    fs.mkdirSync(repoBlueprints, { recursive: true });
    fs.writeFileSync(
      path.join(repoBlueprints, "proj-bp.md"),
      "---\nname: Proj\ndescription: d\n---\nContent.\n",
    );
    const dir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "app-bp.md"),
      "---\nname: App\ndescription: d\n---\nContent.\n",
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: repoDir,
      config: { project: { name: "p" }, blueprints: { defaultBlueprint: "proj-bp" } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "app-bp" },
    });
    invalidateCache();
    const result = resolveEffectiveDefaultBlueprint("project-1");
    expect(result).toEqual({ blueprintId: "proj-bp", source: "project" });
  });

  it("returns app source when project default is invalid", () => {
    const repoDir = path.join(tmpDir, "repo");
    const dir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "app-bp.md"),
      "---\nname: App\ndescription: d\n---\nContent.\n",
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: repoDir,
      config: { project: { name: "p" }, blueprints: { defaultBlueprint: "nonexistent" } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "app-bp" },
    });
    invalidateCache();
    const result = resolveEffectiveDefaultBlueprint("project-1");
    expect(result).toEqual({ blueprintId: "app-bp", source: "app" });
  });

  it("returns global source when both project and app defaults are invalid", () => {
    const repoDir = path.join(tmpDir, "repo");
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: repoDir,
      config: { project: { name: "p" }, blueprints: { defaultBlueprint: "nonexistent-proj" } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "nonexistent-app" },
    });
    invalidateCache();
    const result = resolveEffectiveDefaultBlueprint("project-1");
    expect(result).toEqual({ blueprintId: "__global_default__", source: "global" });
  });
});

describe("resolveBlueprintForIssue", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-issue-test-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(state.getRouboDir).mockReturnValue("/mock-home/.roubo");
    vi.restoreAllMocks();
  });

  it("returns issue-type-mapping source when issue type has a mapping to a valid blueprint", () => {
    const repoDir = path.join(tmpDir, "repo");
    const repoBlueprints = path.join(repoDir, ".roubo", "blueprints");
    fs.mkdirSync(repoBlueprints, { recursive: true });
    fs.writeFileSync(
      path.join(repoBlueprints, "bug-fix.md"),
      "---\nname: Bug Fix\ndescription: d\n---\nContent.\n",
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: repoDir,
      config: { project: { name: "p" }, blueprints: { issueTypeMappings: { Bug: "bug-fix" } } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    invalidateCache();

    const result = resolveBlueprintForIssue("project-1", "Bug");
    expect(result).toEqual({ blueprintId: "bug-fix", source: "issue-type-mapping" });
  });

  it("falls through to default hierarchy when no issue type is provided", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: "/repo",
      config: { project: { name: "p" }, blueprints: { issueTypeMappings: { Bug: "bug-fix" } } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    invalidateCache();

    const result = resolveBlueprintForIssue("project-1", undefined);
    expect(result.source).toBe("global");
    expect(result.blueprintId).toBe("__global_default__");
  });

  it("falls through with a warn when the mapped blueprint id doesn't exist", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: "/repo",
      config: { project: { name: "p" }, blueprints: { issueTypeMappings: { Bug: "nonexistent" } } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    invalidateCache();
    const warnSpy = vi.mocked(console.warn);

    const result = resolveBlueprintForIssue("project-1", "Bug");
    expect(result.source).toBe("global");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("falls through to default hierarchy when issueTypeMappings is absent", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: "/repo",
      config: { project: { name: "p" } },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    invalidateCache();

    const result = resolveBlueprintForIssue("project-1", "Bug");
    expect(result.source).toBe("global");
  });

  it("accepts __global_default__ as a valid mapped blueprint id", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      id: "project-1",
      repoPath: "/repo",
      config: {
        project: { name: "p" },
        blueprints: { issueTypeMappings: { Bug: "__global_default__" } },
      },
    } as unknown as ReturnType<typeof projectRegistry.getProject>);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    invalidateCache();

    const result = resolveBlueprintForIssue("project-1", "Bug");
    expect(result).toEqual({ blueprintId: "__global_default__", source: "issue-type-mapping" });
  });
});

describe("invalidateCache", () => {
  it("can be called without error", () => {
    expect(() => invalidateCache()).not.toThrow();
    expect(() => invalidateCache("some-project-id")).not.toThrow();
  });
});

// ── CRUD tests ──

describe("slugify", () => {
  it("lowercases and hyphenates basic names", () => {
    expect(slugify("My Blueprint")).toBe("my-blueprint");
  });

  it("strips diacritics", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  it("collapses multiple non-alphanumeric runs into a single hyphen", () => {
    expect(slugify("Hello  World!! Test")).toBe("hello-world-test");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("--hello world--")).toBe("hello-world");
  });

  it("returns empty string for an all-symbol name", () => {
    expect(slugify("!!! ???")).toBe("");
  });

  it("truncates to 100 characters", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBe(100);
  });

  it("handles numeric characters", () => {
    expect(slugify("Test 123")).toBe("test-123");
  });
});

describe("createAppBlueprint", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-crud-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates a blueprint file and returns a BlueprintDetail", () => {
    const detail = createAppBlueprint({
      name: "My Feature",
      description: "A description",
      content: "Hello {{project.name}}",
    });
    expect(detail.id).toBe("my-feature");
    expect(detail.name).toBe("My Feature");
    expect(detail.description).toBe("A description");
    expect(detail.icon).toBe("file-text");
    expect(detail.content).toBe("Hello {{project.name}}");
    expect(detail.source).toBe("app");
    expect(detail.createdAt).toBeDefined();
    expect(detail.updatedAt).toBe(detail.createdAt);
    expect(detail.approxTokens).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmpDir, "blueprints", "my-feature.md"))).toBe(true);
  });

  it("uses a provided icon", () => {
    const detail = createAppBlueprint({
      name: "My Feature",
      description: "desc",
      icon: "rocket",
      content: "hello",
    });
    expect(detail.icon).toBe("rocket");
  });

  it("throws INVALID_NAME when name is missing", () => {
    expect(() => createAppBlueprint({ name: "", description: "d", content: "c" })).toThrow(
      BlueprintError,
    );
    expect(() => createAppBlueprint({ name: "", description: "d", content: "c" })).toThrow(
      expect.objectContaining({ code: "INVALID_NAME" }),
    );
  });

  it("throws INVALID_NAME when name exceeds 100 chars", () => {
    expect(() =>
      createAppBlueprint({ name: "a".repeat(101), description: "d", content: "c" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_NAME" }));
  });

  it("throws INVALID_DESCRIPTION when description is empty", () => {
    expect(() => createAppBlueprint({ name: "Test", description: "", content: "c" })).toThrow(
      expect.objectContaining({ code: "INVALID_DESCRIPTION" }),
    );
  });

  it("throws INVALID_DESCRIPTION when description exceeds 300 chars", () => {
    expect(() =>
      createAppBlueprint({ name: "Test", description: "d".repeat(301), content: "c" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_DESCRIPTION" }));
  });

  it("throws INVALID_ICON when icon is an empty string", () => {
    expect(() =>
      createAppBlueprint({ name: "Test", description: "d", icon: "", content: "c" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ICON" }));
  });

  it("throws INVALID_CONTENT when content is empty", () => {
    expect(() => createAppBlueprint({ name: "Test", description: "d", content: "" })).toThrow(
      expect.objectContaining({ code: "INVALID_CONTENT" }),
    );
  });

  it("accepts content exactly at the 200 KB hard limit", () => {
    const content = "x".repeat(200 * 1024);
    expect(() => createAppBlueprint({ name: "Big One", description: "d", content })).not.toThrow();
  });

  it("throws INVALID_CONTENT when content exceeds 200 KB", () => {
    const content = "x".repeat(200 * 1024 + 1);
    expect(() => createAppBlueprint({ name: "Too Big", description: "d", content })).toThrow(
      expect.objectContaining({ code: "INVALID_CONTENT" }),
    );
  });

  it("throws DUPLICATE_ID when a blueprint with the same slug exists", () => {
    createAppBlueprint({ name: "My Feature", description: "d", content: "c" });
    expect(() =>
      createAppBlueprint({ name: "My Feature", description: "d2", content: "c2" }),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });

  it("throws DUPLICATE_NAME for case-insensitive name collision when slugs differ", () => {
    // Write a file with a slug that doesn't match what the current name would produce —
    // simulating a blueprint that was manually renamed on disk.
    const dir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "legacy-id.md"),
      "---\nname: My Feature\ndescription: old\nicon: file-text\ncreatedAt: 2024-01-01T00:00:00.000Z\nupdatedAt: 2024-01-01T00:00:00.000Z\n---\nContent.\n",
    );
    // Attempt to create "my feature" (slug: "my-feature") — different file, same name
    expect(() =>
      createAppBlueprint({ name: "my feature", description: "d2", content: "c2" }),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_NAME" }));
  });

  it("trims whitespace from name and description", () => {
    const detail = createAppBlueprint({
      name: "  My Feature  ",
      description: "  A description  ",
      content: "hello",
    });
    expect(detail.name).toBe("My Feature");
    expect(detail.description).toBe("A description");
  });

  it("throws RESERVED_ID when name slugifies to 'default'", () => {
    expect(() => createAppBlueprint({ name: "Default", description: "d", content: "c" })).toThrow(
      expect.objectContaining({ code: "RESERVED_ID" }),
    );
  });
});

describe("updateAppBlueprint", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-crud-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("updates a blueprint and returns updated detail", () => {
    createAppBlueprint({ name: "Original", description: "Old desc", content: "old" });
    const updated = updateAppBlueprint("original", { description: "New desc" });
    expect(updated.name).toBe("Original");
    expect(updated.description).toBe("New desc");
  });

  it("preserves createdAt and bumps updatedAt", () => {
    const created = createAppBlueprint({ name: "My BP", description: "d", content: "c" });
    const before = Date.now();
    const updated = updateAppBlueprint("my-bp", { content: "new content" });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeDefined();
    expect(new Date(updated.updatedAt ?? "").getTime()).toBeGreaterThanOrEqual(before);
  });

  it("backfills createdAt to updatedAt when file has no createdAt", () => {
    // Write a file without createdAt in frontmatter
    const dir = path.join(tmpDir, "blueprints");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "no-timestamps.md"),
      "---\nname: No TS\ndescription: test\nicon: file-text\n---\nContent.\n",
    );
    const updated = updateAppBlueprint("no-timestamps", { content: "updated" });
    expect(updated.createdAt).toBeDefined();
    expect(updated.updatedAt).toBeDefined();
  });

  it("throws NOT_FOUND for non-existent id", () => {
    expect(() => updateAppBlueprint("does-not-exist", { content: "x" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("throws RESERVED_ID for the global default id", () => {
    expect(() => updateAppBlueprint("__global_default__", { name: "x" })).toThrow(
      expect.objectContaining({ code: "RESERVED_ID" }),
    );
  });

  it("throws DUPLICATE_NAME when renaming to a conflicting name", () => {
    createAppBlueprint({ name: "alpha", description: "d", content: "c" });
    createAppBlueprint({ name: "beta", description: "d", content: "c" });
    expect(() => updateAppBlueprint("alpha", { name: "Beta" })).toThrow(
      expect.objectContaining({ code: "DUPLICATE_NAME" }),
    );
  });

  it("allows updating the blueprint to keep the same name (case-insensitive self-reference)", () => {
    createAppBlueprint({ name: "My BP", description: "d", content: "c" });
    expect(() => updateAppBlueprint("my-bp", { name: "My BP" })).not.toThrow();
  });
});

describe("deleteAppBlueprint", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-crud-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("deletes the blueprint file", () => {
    createAppBlueprint({ name: "To Delete", description: "d", content: "c" });
    const filePath = path.join(tmpDir, "blueprints", "to-delete.md");
    expect(fs.existsSync(filePath)).toBe(true);
    deleteAppBlueprint("to-delete");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("throws NOT_FOUND for non-existent id", () => {
    expect(() => deleteAppBlueprint("ghost")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("throws RESERVED_ID for the global default id", () => {
    expect(() => deleteAppBlueprint("__global_default__")).toThrow(
      expect.objectContaining({ code: "RESERVED_ID" }),
    );
  });

  it("throws REFERENCED with app-default reference", () => {
    createAppBlueprint({ name: "In Use", description: "d", content: "c" });
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "in-use" },
    });
    expect(() => deleteAppBlueprint("in-use")).toThrow(
      expect.objectContaining({ code: "REFERENCED" }),
    );
    try {
      deleteAppBlueprint("in-use");
    } catch (err) {
      if (err instanceof BlueprintError) {
        expect(err.data).toEqual([{ type: "app-default" }]);
      }
    }
  });

  it("throws REFERENCED when a project config references the blueprint as its default", () => {
    createAppBlueprint({ name: "Project Default", description: "d", content: "c" });
    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      {
        id: "my-project",
        repoPath: "/repo",
        configValid: true,
        settings: {} as never,
        config: {
          project: { name: "my-project", displayName: "My Project", type: "web", repo: "repo" },
          blueprints: { defaultBlueprint: "project-default" },
        } as never,
      },
    ]);
    expect(() => deleteAppBlueprint("project-default")).toThrow(
      expect.objectContaining({ code: "REFERENCED" }),
    );
    try {
      deleteAppBlueprint("project-default");
    } catch (err) {
      if (err instanceof BlueprintError) {
        expect(err.data?.[0]).toEqual(
          expect.objectContaining({ type: "project-default", projectId: "my-project" }),
        );
      }
    }
  });

  it("throws REFERENCED when a project blueprintSettings.defaultBlueprintId references the blueprint", () => {
    createAppBlueprint({ name: "Settings Default", description: "d", content: "c" });
    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      {
        id: "proj-2",
        repoPath: "/repo2",
        configValid: true,
        settings: {} as never,
        config: {
          project: {
            name: "proj-2",
            displayName: "Proj Two",
            type: "web",
            repo: "r",
            blueprintSettings: {
              autoInject: true,
              autoExecute: true,
              defaultBlueprintId: "settings-default",
            },
          },
          blueprints: undefined,
        } as never,
      },
    ]);
    expect(() => deleteAppBlueprint("settings-default")).toThrow(
      expect.objectContaining({ code: "REFERENCED" }),
    );
  });

  it("throws REFERENCED when an issue-type mapping references the blueprint", () => {
    createAppBlueprint({ name: "Bug Flow", description: "d", content: "c" });
    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      {
        id: "proj-3",
        repoPath: "/repo3",
        configValid: true,
        settings: {} as never,
        config: {
          project: {
            name: "proj-3",
            displayName: "Proj Three",
            type: "web",
            repo: "r",
            blueprintSettings: {
              autoInject: true,
              autoExecute: true,
              issueTypeMappings: { bug: "bug-flow", feature: "other-blueprint" },
            },
          },
        } as never,
      },
    ]);
    try {
      deleteAppBlueprint("bug-flow");
      expect.fail("should have thrown");
    } catch (err) {
      if (err instanceof BlueprintError) {
        expect(err.code).toBe("REFERENCED");
        expect(err.data).toEqual([
          expect.objectContaining({
            type: "issue-type-mapping",
            issueType: "bug",
            projectId: "proj-3",
          }),
        ]);
      }
    }
  });
});

describe("findAppBlueprintReferences", () => {
  beforeEach(() => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
  });

  it("returns empty array when nothing references the blueprint", () => {
    expect(findAppBlueprintReferences("some-id")).toEqual([]);
  });

  it("returns app-default reference when matching user settings", () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "my-bp" },
    });
    const refs = findAppBlueprintReferences("my-bp");
    expect(refs).toEqual([{ type: "app-default" }]);
  });

  it("deduplicates project-default reference when both config fields match", () => {
    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      {
        id: "p1",
        repoPath: "/r",
        configValid: true,
        settings: {} as never,
        config: {
          project: {
            name: "p1",
            displayName: "P One",
            type: "web",
            repo: "r",
            blueprintSettings: {
              autoInject: true,
              autoExecute: true,
              defaultBlueprintId: "target",
            },
          },
          blueprints: { defaultBlueprint: "target" },
        } as never,
      },
    ]);
    const refs = findAppBlueprintReferences("target");
    const projectRefs = refs.filter((r) => r.type === "project-default");
    expect(projectRefs).toHaveLength(1);
  });

  it("collects issue-type-mapping references across multiple issue types", () => {
    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      {
        id: "p2",
        repoPath: "/r2",
        configValid: true,
        settings: {} as never,
        config: {
          project: {
            name: "p2",
            displayName: "P Two",
            type: "web",
            repo: "r",
            blueprintSettings: {
              autoInject: true,
              autoExecute: true,
              issueTypeMappings: { bug: "shared-flow", feature: "shared-flow", chore: "other" },
            },
          },
        } as never,
      },
    ]);
    const refs = findAppBlueprintReferences("shared-flow");
    const mappingRefs = refs.filter((r) => r.type === "issue-type-mapping");
    expect(mappingRefs).toHaveLength(2);
    const issueTypes = mappingRefs.map((r) => (r as { issueType: string }).issueType).sort();
    expect(issueTypes).toEqual(["bug", "feature"]);
  });

  it("finds issue-type-mapping references from top-level blueprints.issueTypeMappings", () => {
    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      {
        id: "p4",
        repoPath: "/r4",
        configValid: true,
        settings: {} as never,
        config: {
          project: { name: "p4", displayName: "P Four", type: "web", repo: "r" },
          blueprints: {
            issueTypeMappings: { Bug: "mapped-app-bp", Feature: "mapped-app-bp", Task: "other" },
          },
        } as never,
      },
    ]);
    const refs = findAppBlueprintReferences("mapped-app-bp");
    const mappingRefs = refs.filter((r) => r.type === "issue-type-mapping");
    expect(mappingRefs).toHaveLength(2);
    const issueTypes = mappingRefs.map((r) => (r as { issueType: string }).issueType).sort();
    expect(issueTypes).toEqual(["Bug", "Feature"]);
  });
});

describe("getAppBlueprint", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-crud-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns the embedded global default for the reserved id", () => {
    const bp = getAppBlueprint("__global_default__");
    if (!bp) throw new Error("Expected non-null blueprint");
    expect(bp.id).toBe("__global_default__");
  });

  it("returns a file-based blueprint by id", () => {
    createAppBlueprint({ name: "File One", description: "d", content: "c" });
    const bp = getAppBlueprint("file-one");
    if (!bp) throw new Error("Expected non-null blueprint");
    expect(bp.name).toBe("File One");
    expect(bp.source).toBe("app");
  });

  it("returns null for an unknown id", () => {
    expect(getAppBlueprint("does-not-exist")).toBeNull();
  });
});

// ── Project-level blueprint CRUD tests ──

function makeMockProject(id: string, repoPath: string, configOverride?: Record<string, unknown>) {
  return {
    id,
    repoPath,
    configValid: true,
    settings: {} as never,
    config: {
      project: { name: id, displayName: id, type: "web", repo: "owner/repo" },
      ...configOverride,
    } as never,
  };
}

describe("createProjectBlueprint", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-blueprint-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-repo-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMockProject("proj-1", repoDir));
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates a blueprint file in the repo and returns a BlueprintDetail with source=project", () => {
    const detail = createProjectBlueprint("proj-1", {
      name: "My Feature",
      description: "A description",
      content: "Hello {{project.name}}",
    });
    expect(detail.id).toBe("my-feature");
    expect(detail.source).toBe("project");
    expect(detail.createdAt).toBeDefined();
    const expectedPath = path.join(repoDir, ".roubo/blueprints/my-feature.md");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("throws NOT_FOUND when project is not registered", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(() =>
      createProjectBlueprint("unknown", { name: "Test", description: "d", content: "c" }),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("scope isolation — same id can exist in both app and project scopes", () => {
    // Create app-level blueprint
    createAppBlueprint({ name: "Shared Name", description: "app desc", content: "app content" });
    const appPath = path.join(tmpDir, "blueprints/shared-name.md");
    expect(fs.existsSync(appPath)).toBe(true);

    // Creating same id at project level should NOT throw DUPLICATE_ID
    const detail = createProjectBlueprint("proj-1", {
      name: "Shared Name",
      description: "project desc",
      content: "project content",
    });
    expect(detail.source).toBe("project");
    const projPath = path.join(repoDir, ".roubo/blueprints/shared-name.md");
    expect(fs.existsSync(projPath)).toBe(true);
  });

  it("throws DUPLICATE_ID within the same project scope", () => {
    createProjectBlueprint("proj-1", { name: "My BP", description: "d", content: "c" });
    expect(() =>
      createProjectBlueprint("proj-1", { name: "My BP", description: "d2", content: "c2" }),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });

  it("throws DUPLICATE_NAME within the same project scope", () => {
    const dir = path.join(repoDir, ".roubo/blueprints");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "legacy-id.md"),
      "---\nname: Existing BP\ndescription: old\nicon: file-text\ncreatedAt: 2024-01-01T00:00:00.000Z\nupdatedAt: 2024-01-01T00:00:00.000Z\n---\nContent.\n",
    );
    expect(() =>
      createProjectBlueprint("proj-1", { name: "Existing BP", description: "d", content: "c" }),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_NAME" }));
  });

  it("throws INVALID_NAME for empty name", () => {
    expect(() =>
      createProjectBlueprint("proj-1", { name: "", description: "d", content: "c" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_NAME" }));
  });

  it("invalidates the cache for the project after creation", () => {
    createProjectBlueprint("proj-1", { name: "Cache Test", description: "d", content: "c" });
    // A second creation with the same name must throw DUPLICATE_ID, proving the
    // cache was invalidated and the new file is visible to subsequent operations.
    expect(() =>
      createProjectBlueprint("proj-1", { name: "Cache Test", description: "d", content: "c" }),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });
});

describe("updateProjectBlueprint", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-blueprint-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-repo-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMockProject("proj-1", repoDir));
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("updates a project blueprint and returns updated detail with source=project", () => {
    createProjectBlueprint("proj-1", { name: "Original", description: "Old desc", content: "old" });
    const updated = updateProjectBlueprint("proj-1", "original", { description: "New desc" });
    expect(updated.description).toBe("New desc");
    expect(updated.source).toBe("project");
  });

  it("throws NOT_FOUND when project is not registered", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(() => updateProjectBlueprint("unknown", "some-id", { content: "x" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("throws NOT_FOUND when blueprint file does not exist in project scope", () => {
    expect(() => updateProjectBlueprint("proj-1", "ghost", { content: "x" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("throws RESERVED_ID for the global default id", () => {
    expect(() => updateProjectBlueprint("proj-1", "__global_default__", { name: "x" })).toThrow(
      expect.objectContaining({ code: "RESERVED_ID" }),
    );
  });

  it("throws DUPLICATE_NAME when renaming to a conflicting name within project scope", () => {
    createProjectBlueprint("proj-1", { name: "alpha", description: "d", content: "c" });
    createProjectBlueprint("proj-1", { name: "beta", description: "d", content: "c" });
    expect(() => updateProjectBlueprint("proj-1", "alpha", { name: "Beta" })).toThrow(
      expect.objectContaining({ code: "DUPLICATE_NAME" }),
    );
  });

  it("allows updating with the same name (case-insensitive self-reference)", () => {
    createProjectBlueprint("proj-1", { name: "My BP", description: "d", content: "c" });
    expect(() => updateProjectBlueprint("proj-1", "my-bp", { name: "My BP" })).not.toThrow();
  });
});

describe("deleteProjectBlueprint", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-blueprint-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-repo-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMockProject("proj-1", repoDir));
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("deletes the blueprint file from the repo", () => {
    createProjectBlueprint("proj-1", { name: "To Delete", description: "d", content: "c" });
    const filePath = path.join(repoDir, ".roubo/blueprints/to-delete.md");
    expect(fs.existsSync(filePath)).toBe(true);
    deleteProjectBlueprint("proj-1", "to-delete");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("throws NOT_FOUND when project is not registered", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(() => deleteProjectBlueprint("unknown", "some-id")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("throws NOT_FOUND when blueprint file does not exist", () => {
    expect(() => deleteProjectBlueprint("proj-1", "ghost")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("throws RESERVED_ID for the global default id", () => {
    expect(() => deleteProjectBlueprint("proj-1", "__global_default__")).toThrow(
      expect.objectContaining({ code: "RESERVED_ID" }),
    );
  });

  it("throws REFERENCED when blueprint is the project's default in blueprints.defaultBlueprint", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeMockProject("proj-1", repoDir, { blueprints: { defaultBlueprint: "in-use" } }),
    );
    createProjectBlueprint("proj-1", { name: "In Use", description: "d", content: "c" });
    expect(() => deleteProjectBlueprint("proj-1", "in-use")).toThrow(
      expect.objectContaining({ code: "REFERENCED" }),
    );
    try {
      deleteProjectBlueprint("proj-1", "in-use");
    } catch (err) {
      if (err instanceof BlueprintError) {
        expect(err.data?.[0]).toMatchObject({ type: "project-default", projectId: "proj-1" });
      }
    }
  });

  it("throws REFERENCED when blueprint is referenced via issueTypeMappings", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeMockProject("proj-1", repoDir, {
        project: {
          name: "proj-1",
          displayName: "proj-1",
          type: "web",
          repo: "owner/repo",
          blueprintSettings: {
            autoInject: true,
            autoExecute: true,
            issueTypeMappings: { bug: "bug-flow" },
          },
        },
      }),
    );
    createProjectBlueprint("proj-1", { name: "Bug Flow", description: "d", content: "c" });
    try {
      deleteProjectBlueprint("proj-1", "bug-flow");
      expect.fail("should have thrown");
    } catch (err) {
      if (err instanceof BlueprintError) {
        expect(err.code).toBe("REFERENCED");
        expect(err.data?.[0]).toMatchObject({ type: "issue-type-mapping", issueType: "bug" });
      }
    }
  });
});

describe("getProjectBlueprint", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-blueprint-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-repo-"));
    vi.mocked(state.getRouboDir).mockReturnValue(tmpDir);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMockProject("proj-1", repoDir));
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    invalidateCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns a project blueprint with source=project", () => {
    createProjectBlueprint("proj-1", { name: "Repo BP", description: "d", content: "hello" });
    const bp = getProjectBlueprint("proj-1", "repo-bp");
    if (!bp) throw new Error("Expected non-null blueprint");
    expect(bp.name).toBe("Repo BP");
    expect(bp.source).toBe("project");
  });

  it("returns null when project is not registered", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(getProjectBlueprint("unknown", "some-id")).toBeNull();
  });

  it("returns null when blueprint file does not exist in project scope", () => {
    expect(getProjectBlueprint("proj-1", "ghost")).toBeNull();
  });

  it("returns null for the reserved global default id", () => {
    expect(getProjectBlueprint("proj-1", "__global_default__")).toBeNull();
  });

  it("returns null for an app-only blueprint that has no project-scope file", () => {
    // App blueprint exists but project blueprint does not
    createAppBlueprint({ name: "App Only", description: "d", content: "c" });
    expect(getProjectBlueprint("proj-1", "app-only")).toBeNull();
  });
});

describe("findProjectBlueprintReferences", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-repo-"));
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(projectRegistry.getProjects).mockReturnValue([]);
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMockProject("proj-1", repoDir));
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns empty array when nothing references the blueprint", () => {
    expect(findProjectBlueprintReferences("proj-1", "some-id")).toEqual([]);
  });

  it("returns empty array when project is not registered", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(findProjectBlueprintReferences("unknown", "some-id")).toEqual([]);
  });

  it("finds project-default from blueprints.defaultBlueprint", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeMockProject("proj-1", repoDir, { blueprints: { defaultBlueprint: "target" } }),
    );
    const refs = findProjectBlueprintReferences("proj-1", "target");
    expect(refs).toEqual([{ type: "project-default", projectId: "proj-1", projectName: "proj-1" }]);
  });

  it("finds project-default from blueprintSettings.defaultBlueprintId", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeMockProject("proj-1", repoDir, {
        project: {
          name: "proj-1",
          displayName: "proj-1",
          type: "web",
          repo: "r",
          blueprintSettings: { autoInject: true, autoExecute: true, defaultBlueprintId: "target" },
        },
      }),
    );
    const refs = findProjectBlueprintReferences("proj-1", "target");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: "project-default", projectId: "proj-1" });
  });

  it("deduplicates project-default when both config fields match", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeMockProject("proj-1", repoDir, {
        blueprints: { defaultBlueprint: "target" },
        project: {
          name: "proj-1",
          displayName: "proj-1",
          type: "web",
          repo: "r",
          blueprintSettings: { autoInject: true, autoExecute: true, defaultBlueprintId: "target" },
        },
      }),
    );
    const refs = findProjectBlueprintReferences("proj-1", "target");
    const projectRefs = refs.filter((r) => r.type === "project-default");
    expect(projectRefs).toHaveLength(1);
  });

  it("finds issue-type-mapping references", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeMockProject("proj-1", repoDir, {
        project: {
          name: "proj-1",
          displayName: "proj-1",
          type: "web",
          repo: "r",
          blueprintSettings: {
            autoInject: true,
            autoExecute: true,
            issueTypeMappings: { bug: "bug-flow", feature: "bug-flow", chore: "other" },
          },
        },
      }),
    );
    const refs = findProjectBlueprintReferences("proj-1", "bug-flow");
    const mappingRefs = refs.filter((r) => r.type === "issue-type-mapping");
    expect(mappingRefs).toHaveLength(2);
    const issueTypes = mappingRefs.map((r) => (r as { issueType: string }).issueType).sort();
    expect(issueTypes).toEqual(["bug", "feature"]);
  });

  it("does not include the user-global app-default setting", () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      blueprints: { autoInject: true, autoExecute: true, defaultBlueprintId: "target" },
    });
    const refs = findProjectBlueprintReferences("proj-1", "target");
    expect(refs.some((r) => r.type === "app-default")).toBe(false);
  });

  it("does not include references from other projects", () => {
    // proj-2 references "target" but we're checking for proj-1's references
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeMockProject("proj-1", repoDir));
    vi.mocked(projectRegistry.getProjects).mockReturnValue([
      makeMockProject("proj-2", "/other-repo", { blueprints: { defaultBlueprint: "target" } }),
    ]);
    const refs = findProjectBlueprintReferences("proj-1", "target");
    expect(refs).toHaveLength(0);
  });

  it("finds issue-type-mapping references from top-level blueprints.issueTypeMappings", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeMockProject("proj-1", repoDir, {
        blueprints: {
          issueTypeMappings: { Bug: "mapped-bp", Feature: "mapped-bp", Task: "other-bp" },
        },
      }),
    );
    const refs = findProjectBlueprintReferences("proj-1", "mapped-bp");
    const mappingRefs = refs.filter((r) => r.type === "issue-type-mapping");
    expect(mappingRefs).toHaveLength(2);
    const issueTypes = mappingRefs.map((r) => (r as { issueType: string }).issueType).sort();
    expect(issueTypes).toEqual(["Bug", "Feature"]);
  });
});
