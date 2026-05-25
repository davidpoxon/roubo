import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginRecord } from "@roubo/shared";

vi.mock("./project-registry.js", () => ({ getProject: vi.fn() }));
vi.mock("./plugin-manager.js", () => ({ listInstalled: vi.fn(() => []) }));
vi.mock("./integration-overrides.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./integration-overrides.js")>();
  return {
    ...original,
    loadOverride: vi.fn(),
    getEffectiveWithGlobal: vi.fn((c, p) => ({
      ...(c ?? {}),
      ...(p?.integration ?? {}),
    })),
  };
});

import {
  resolveActivePlugin,
  activeIntegrationDisplayName,
  DEFAULT_PAGE_SIZE,
} from "./active-plugin.js";
import * as projectRegistry from "./project-registry.js";
import * as pluginManager from "./plugin-manager.js";
import { loadOverride, IntegrationOverrideError } from "./integration-overrides.js";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveActivePlugin", () => {
  it("returns null when the project is not registered", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(resolveActivePlugin("p1")).toBeNull();
  });

  it("returns null when the project has no parsed config", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({ config: undefined } as never);
    expect(resolveActivePlugin("p1")).toBeNull();
  });

  it("returns null when integration.plugin is unset after merge", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: {} },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);
    expect(resolveActivePlugin("p1")).toBeNull();
  });

  it("returns the active plugin id with the default pageSize when none is configured", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: "github-com" } },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);

    const result = resolveActivePlugin("p1");
    expect(result).toEqual({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("honors a pageSize set in the per-user override", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: "github-com" } },
    } as never);
    vi.mocked(loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "github-com", pageSize: 25 },
    });

    const result = resolveActivePlugin("p1");
    expect(result?.pageSize).toBe(25);
  });

  it("falls back to the committed config when the override file is malformed", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: "github-com" } },
    } as never);
    vi.mocked(loadOverride).mockImplementation(() => {
      throw new IntegrationOverrideError("bad", "SCHEMA");
    });

    const result = resolveActivePlugin("p1");
    expect(result?.pluginId).toBe("github-com");
  });
});

function makeRecord(id: string, name: string | null): PluginRecord {
  return {
    id,
    source: { kind: "bundled" } as never,
    status: "enabled",
    manifest: name === null ? null : ({ name } as never),
    error: null,
  } as never;
}

describe("activeIntegrationDisplayName", () => {
  it("returns null when the project has no active plugin", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(activeIntegrationDisplayName("p1")).toBeNull();
  });

  it("returns null when integration.plugin is unset after merge", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: {} },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);
    expect(activeIntegrationDisplayName("p1")).toBeNull();
  });

  it("returns the manifest name when the active plugin is installed", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: "github-com" } },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makeRecord("github-com", "GitHub.com"),
    ]);

    expect(activeIntegrationDisplayName("p1")).toBe("GitHub.com");
  });

  it("returns null when the active plugin id is set but the plugin isn't installed", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: "jira-self-hosted" } },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);

    expect(activeIntegrationDisplayName("p1")).toBeNull();
  });

  it("returns null when the installed plugin has no manifest", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: "github-com" } },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([makeRecord("github-com", null)]);

    expect(activeIntegrationDisplayName("p1")).toBeNull();
  });
});
