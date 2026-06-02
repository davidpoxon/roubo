import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as YAML from "yaml";
import type { IntegrationConfig, RegisteredProject, RouboConfig } from "@roubo/shared";
import { promoteIntegrationToCommitted, PromoteIntegrationError } from "./promote-integration.js";
import * as projectRegistry from "./project-registry.js";
import * as integrationOverrides from "./integration-overrides.js";

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
  reloadConfig: vi.fn(),
}));
vi.mock("./integration-overrides.js", async () => {
  const actual = await vi.importActual<typeof import("./integration-overrides.js")>(
    "./integration-overrides.js",
  );
  return { ...actual, loadOverride: vi.fn(), getEffectiveWithGlobal: vi.fn() };
});

let tmpDir: string;

function baseConfig(integration?: IntegrationConfig): RouboConfig {
  return {
    project: { name: "demo", displayName: "Demo", repo: "acme/demo" },
    layout: { type: "single-repo" },
    components: { server: { type: "process", command: "npm start" } },
    ports: { server: { base: 3000 } },
    benches: { max: 5 },
    ...(integration ? { integration } : {}),
  } as unknown as RouboConfig;
}

function projectFor(config: RouboConfig): RegisteredProject {
  return {
    id: "demo",
    repoPath: tmpDir,
    config: structuredClone(config),
    configValid: true,
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  };
}

function readWritten(): RouboConfig {
  const written = fs.readFileSync(path.join(tmpDir, ".roubo", "roubo.yaml"), "utf-8");
  return YAML.parse(written) as RouboConfig;
}

beforeEach(() => {
  vi.resetAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-integration-"));
  vi.mocked(integrationOverrides.loadOverride).mockReturnValue(null);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("promoteIntegrationToCommitted", () => {
  it("throws PROJECT_NOT_FOUND when the project is unknown", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    expect(() => promoteIntegrationToCommitted("demo")).toThrow(PromoteIntegrationError);
    expect(() => promoteIntegrationToCommitted("demo")).toThrow(/not found/i);
  });

  it("throws NO_ACTIVE_PLUGIN when the effective config has no plugin", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(baseConfig()));
    vi.mocked(integrationOverrides.getEffectiveWithGlobal).mockReturnValue({});

    try {
      promoteIntegrationToCommitted("demo");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PromoteIntegrationError);
      expect((err as PromoteIntegrationError).code).toBe("NO_ACTIVE_PLUGIN");
    }
    expect(fs.existsSync(path.join(tmpDir, ".roubo", "roubo.yaml"))).toBe(false);
  });

  it("writes the effective plugin + instance into committed roubo.yaml and clears stale sources", () => {
    // Committed still names the stale github-com with old sources; the override
    // resolved to ghe. Promotion should align committed to ghe + instance and
    // drop the plugin-specific sources.
    const committed = baseConfig({
      plugin: "github-com",
      sources: { Repository: [{ externalId: "acme/demo" }] },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(committed));
    vi.mocked(integrationOverrides.getEffectiveWithGlobal).mockReturnValue({
      plugin: "ghe",
      instance: "https://ghe.megaleo.com",
    });

    promoteIntegrationToCommitted("demo");

    const parsed = readWritten();
    expect(parsed.integration?.plugin).toBe("ghe");
    expect(parsed.integration?.instance).toBe("https://ghe.megaleo.com");
    expect(parsed.integration?.sources).toBeUndefined();
    // Unrelated config is preserved.
    expect(parsed.project.repo).toBe("acme/demo");
    expect(projectRegistry.reloadConfig).toHaveBeenCalledWith("demo");
  });

  it("omits instance when the effective plugin has none (e.g. github-com)", () => {
    const committed = baseConfig({ plugin: "ghe", instance: "https://ghe.megaleo.com" });
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(committed));
    vi.mocked(integrationOverrides.getEffectiveWithGlobal).mockReturnValue({
      plugin: "github-com",
    });

    promoteIntegrationToCommitted("demo");

    const parsed = readWritten();
    expect(parsed.integration?.plugin).toBe("github-com");
    expect(parsed.integration?.instance).toBeUndefined();
  });
});
