import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getIntegrationFields,
  setIntegrationFields,
  touchesIntegrationFields,
  IntegrationFieldsError,
} from "./project-integration-fields.js";
import * as projectRegistry from "./project-registry.js";
import { resolveActivePlugin } from "./active-plugin.js";
import type { RegisteredProject, RouboConfig } from "@roubo/shared";

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
  reloadConfig: vi.fn(),
}));
vi.mock("./active-plugin.js", () => ({ resolveActivePlugin: vi.fn() }));

const FIXTURE_CONFIG: RouboConfig = {
  project: {
    name: "demo",
    displayName: "Demo",
    type: "web",
    repo: "acme/demo",
    github: { project: 7 },
  },
  layout: {
    type: "meta-repo",
    submodules: { backend: "apps/backend", frontend: "apps/frontend" },
  },
  // validateConfigObject requires at least one component, so the fixture
  // ships a minimal process component to keep the round-trip honest.
  components: { server: { type: "process", command: "npm start" } },
  ports: { server: { base: 3000 } },
  benches: { max: 5 },
} as unknown as RouboConfig;

let tmpDir: string;

function withProject(config: RouboConfig = FIXTURE_CONFIG): RegisteredProject {
  return {
    id: "demo",
    repoPath: tmpDir,
    config: structuredClone(config),
    configValid: true,
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wu057-"));
});

describe("getIntegrationFields", () => {
  it("returns the three fields plus layoutType from the parsed config", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(withProject());
    const result = getIntegrationFields("demo");
    expect(result).toEqual({
      repo: "acme/demo",
      githubProject: 7,
      submodules: { backend: "apps/backend", frontend: "apps/frontend" },
      layoutType: "meta-repo",
    });
  });

  it("omits unset fields so the client gets undefined rather than empty defaults", () => {
    const project = withProject({
      project: { name: "demo", displayName: "Demo", type: "web" },
      layout: { type: "single-repo" },
      components: { server: { type: "process", command: "npm start" } },
      ports: { server: { base: 3000 } },
      benches: { max: 5 },
    } as unknown as RouboConfig);
    vi.mocked(projectRegistry.getProject).mockReturnValue(project);
    expect(getIntegrationFields("demo")).toEqual({ layoutType: "single-repo" });
  });

  it("throws PROJECT_NOT_FOUND when the project is unknown", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(() => getIntegrationFields("missing")).toThrowError(IntegrationFieldsError);
  });
});

describe("setIntegrationFields", () => {
  it("persists repo, githubProject, and submodules into roubo.yaml", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(withProject());
    vi.mocked(resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    });

    const next = setIntegrationFields("demo", {
      repo: "acme/other",
      githubProject: 12,
      submodules: { core: "apps/core" },
    });

    expect(next.repo).toBe("acme/other");
    const yamlPath = path.join(tmpDir, ".roubo", "roubo.yaml");
    const written = fs.readFileSync(yamlPath, "utf-8");
    expect(written).toMatch(/repo: "acme\/other"/);
    expect(written).toMatch(/project: 12/);
    expect(written).toMatch(/core: "apps\/core"/);
  });

  it("clears fields when an explicit null is provided", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(withProject());
    vi.mocked(resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    });
    setIntegrationFields("demo", { repo: null, githubProject: null, submodules: null });
    const yamlPath = path.join(tmpDir, ".roubo", "roubo.yaml");
    const written = fs.readFileSync(yamlPath, "utf-8");
    expect(written).not.toMatch(/repo:/);
    expect(written).not.toMatch(/github:/);
    expect(written).not.toMatch(/submodules:/);
  });

  it("rejects writes when no active plugin is configured", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(withProject());
    vi.mocked(resolveActivePlugin).mockReturnValue(null);
    try {
      setIntegrationFields("demo", { repo: "acme/other" });
      expect.fail("expected IntegrationFieldsError");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationFieldsError);
      expect((err as IntegrationFieldsError).code).toBe("NO_ACTIVE_PLUGIN");
    }
  });

  it("rejects writes when the active plugin is not in the supported list", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(withProject());
    vi.mocked(resolveActivePlugin).mockReturnValue({
      pluginId: "jira-self-hosted",
      integrationId: "jira-self-hosted",
      pageSize: 50,
    });
    try {
      setIntegrationFields("demo", { repo: "acme/other" });
      expect.fail("expected IntegrationFieldsError");
    } catch (err) {
      expect((err as IntegrationFieldsError).code).toBe("PLUGIN_NOT_SUPPORTED");
    }
  });

  it("rejects malformed updates with INVALID_FIELD", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(withProject());
    vi.mocked(resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    });
    expect(() => setIntegrationFields("demo", { repo: "   " })).toThrow(IntegrationFieldsError);
    expect(() => setIntegrationFields("demo", { githubProject: -1 })).toThrow(
      IntegrationFieldsError,
    );
    expect(() => setIntegrationFields("demo", { submodules: { "": "x" } } as never)).toThrow(
      IntegrationFieldsError,
    );
  });
});

describe("touchesIntegrationFields", () => {
  it("flags repo, github, and submodules updates", () => {
    expect(touchesIntegrationFields({ project: { repo: "x" } })).toBe(true);
    expect(touchesIntegrationFields({ project: { github: { project: 1 } } })).toBe(true);
    expect(touchesIntegrationFields({ layout: { submodules: {} } })).toBe(true);
  });

  it("returns false for unrelated config writes", () => {
    expect(touchesIntegrationFields({ project: { name: "x" } })).toBe(false);
    expect(touchesIntegrationFields({ layout: { type: "meta-repo" } })).toBe(false);
    expect(touchesIntegrationFields(null)).toBe(false);
  });
});
