import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginRecord, RegisteredProject, RouboConfig } from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";

// A minimal installed PluginRecord. Only `status` and `manifest.roubo` are read
// by resolveBinding; the rest satisfies the type. `status` defaults to a healthy
// value so the existence gate passes and existing consent/connection tests still
// exercise the binding path.
function makeRecord(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "db-plugin",
    manifest: { roubo: "^1.0.0" } as PluginRecord["manifest"],
    manifestPath: "/tmp/plugin/manifest.yaml",
    pluginDir: "/tmp/plugin",
    source: "bundled" as PluginRecord["source"],
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: null,
    ...overrides,
  };
}

const pluginManagerMocks = vi.hoisted(() => ({
  getConnection: vi.fn<(id: string) => JsonRpcConnection | null>(() => null),
  // Default to an installed record so the pre-existing tests clear the existence
  // gate; the not-installed test overrides this to undefined.
  getRecord: vi.fn<(id: string) => PluginRecord | undefined>(),
  HOST_API_VERSION: "1.3.0",
}));
vi.mock("./plugin-manager.js", () => pluginManagerMocks);

const projectRegistryMocks = vi.hoisted(() => ({
  getProject: vi.fn<(id: string) => RegisteredProject | undefined>(() => undefined),
}));
vi.mock("./project-registry.js", () => projectRegistryMocks);

// Default to "consented" so the pre-existing resolution tests exercise the
// binding/connection path; the not-consented gate has its own test below.
const consentMocks = vi.hoisted(() => ({
  hasConsent: vi.fn<(id: string) => boolean>(() => true),
}));
vi.mock("./plugin-consent-state.js", () => consentMocks);

import { resolveBinding, isNotBound } from "./component-plugin-registry.js";

// A throwaway object standing in for the live JSON-RPC connection. Identity is
// all that matters: the registry must hand back exactly what getConnection
// returns (spawn-once-per-plugin), so we compare by reference.
const fakeConnection = {} as JsonRpcConnection;

function makeProject(
  overrides: Partial<RegisteredProject> & { components?: RouboConfig["components"] } = {},
): RegisteredProject {
  const { components, ...rest } = overrides;
  const config = {
    project: { name: "proj", displayName: "Proj" },
    layout: { type: "single-repo" },
    components: components ?? {},
    ports: {},
    benches: { max: 6 },
  } as unknown as RouboConfig;
  return {
    id: "proj",
    repoPath: "/tmp/proj",
    config,
    configValid: true,
    settings: {} as RegisteredProject["settings"],
    ...rest,
  };
}

beforeEach(() => {
  pluginManagerMocks.getConnection.mockReset().mockReturnValue(null);
  pluginManagerMocks.getRecord.mockReset().mockReturnValue(makeRecord());
  projectRegistryMocks.getProject.mockReset().mockReturnValue(undefined);
  consentMocks.hasConsent.mockReset().mockReturnValue(true);
});

describe("resolveBinding", () => {
  it("resolves a bound component to the live per-plugin connection", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { db: { plugin: { id: "db-plugin" } } } }),
    );
    pluginManagerMocks.getConnection.mockImplementation((id) =>
      id === "db-plugin" ? fakeConnection : null,
    );

    const result = resolveBinding("proj", "db");
    expect(isNotBound(result)).toBe(false);
    if (isNotBound(result)) throw new Error("expected a resolved binding");
    expect(result.pluginId).toBe("db-plugin");
    expect(result.connection).toBe(fakeConnection);
  });

  it("hands two callers the same shared connection (spawn-once-per-plugin)", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({
        components: {
          a: { plugin: { id: "shared-plugin" } },
          b: { plugin: { id: "shared-plugin" } },
        },
      }),
    );
    pluginManagerMocks.getConnection.mockReturnValue(fakeConnection);

    const first = resolveBinding("proj", "a");
    const second = resolveBinding("proj", "b");
    if (isNotBound(first) || isNotBound(second)) throw new Error("expected resolved bindings");
    expect(first.connection).toBe(second.connection);
  });

  it("reports unknown-project when the project is not registered", () => {
    projectRegistryMocks.getProject.mockReturnValue(undefined);
    const result = resolveBinding("missing", "db");
    expect(result).toEqual({ reason: "unknown-project" });
  });

  it("reports invalid-config when the project's config failed to parse", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ configValid: false, config: undefined }),
    );
    const result = resolveBinding("proj", "db");
    expect(result).toEqual({ reason: "invalid-config" });
  });

  it("reports unknown-component when no component matches the name", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { db: { plugin: { id: "db-plugin" } } } }),
    );
    const result = resolveBinding("proj", "frontend");
    expect(result).toEqual({ reason: "unknown-component" });
  });

  it("reports not-bound for a legacy type-only component with no plugin binding", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { db: { type: "database" } } }),
    );
    const result = resolveBinding("proj", "db");
    expect(result).toEqual({ reason: "not-bound" });
  });

  it("reports plugin-unavailable when the bound plugin is not running", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { db: { plugin: { id: "db-plugin" } } } }),
    );
    pluginManagerMocks.getConnection.mockReturnValue(null);
    const result = resolveBinding("proj", "db");
    expect(result).toEqual({ reason: "plugin-unavailable", pluginId: "db-plugin" });
  });

  it("reports not-installed when the bound plugin id has no PluginRecord (issue #408, CP-TC-025)", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { ghost: { plugin: { id: "not-a-real-plugin" } } } }),
    );
    pluginManagerMocks.getRecord.mockReturnValue(undefined);
    const result = resolveBinding("proj", "ghost");
    expect(result).toEqual({ reason: "not-installed", pluginId: "not-a-real-plugin" });
  });

  it("short-circuits not-installed before the consent gate (issue #408, CP-TC-025)", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { ghost: { plugin: { id: "not-a-real-plugin" } } } }),
    );
    pluginManagerMocks.getRecord.mockReturnValue(undefined);
    // Even with consent explicitly absent, an uninstalled id resolves as
    // not-installed: the existence gate runs first, so hasConsent is never
    // consulted and the consumer is not told to acknowledge permissions.
    consentMocks.hasConsent.mockReturnValue(false);
    const result = resolveBinding("proj", "ghost");
    expect(result).toEqual({ reason: "not-installed", pluginId: "not-a-real-plugin" });
    expect(consentMocks.hasConsent).not.toHaveBeenCalled();
  });

  it("reports incompatible with the required range and host version (issue #408, CP-TC-011)", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { db: { plugin: { id: "db-plugin" } } } }),
    );
    // An incompatible plugin is installed but never spawned. resolveBinding must
    // surface the mismatch rather than a generic "not running".
    pluginManagerMocks.getRecord.mockReturnValue(
      makeRecord({
        status: "incompatible",
        manifest: { roubo: "^2.0.0" } as PluginRecord["manifest"],
      }),
    );
    pluginManagerMocks.getConnection.mockReturnValue(null);
    const result = resolveBinding("proj", "db");
    expect(result).toEqual({
      reason: "incompatible",
      pluginId: "db-plugin",
      requiredRange: "^2.0.0",
      hostVersion: "1.3.0",
    });
  });

  it("surfaces incompatible before the consent gate even when unconsented (issue #408, CP-TC-011)", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { db: { plugin: { id: "db-plugin" } } } }),
    );
    // An incompatible plugin the consumer has not consented to must still report
    // the version mismatch, not "acknowledge permissions": the compatibility gate
    // runs before the consent gate, so hasConsent is never consulted.
    pluginManagerMocks.getRecord.mockReturnValue(
      makeRecord({
        status: "incompatible",
        manifest: { roubo: "^2.0.0" } as PluginRecord["manifest"],
      }),
    );
    consentMocks.hasConsent.mockReturnValue(false);
    const result = resolveBinding("proj", "db");
    expect(result).toEqual({
      reason: "incompatible",
      pluginId: "db-plugin",
      requiredRange: "^2.0.0",
      hostVersion: "1.3.0",
    });
    expect(consentMocks.hasConsent).not.toHaveBeenCalled();
  });

  it("refuses to resolve when the bound plugin has no ConsentRecord (issue #615, AC5)", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { db: { plugin: { id: "db-plugin" } } } }),
    );
    consentMocks.hasConsent.mockReturnValue(false);
    // A running connection is irrelevant: the consent gate is checked first, so
    // nothing is spawned for an unconsented plugin.
    pluginManagerMocks.getConnection.mockReturnValue(fakeConnection);

    const result = resolveBinding("proj", "db");
    expect(result).toEqual({ reason: "not-consented", pluginId: "db-plugin" });
    expect(consentMocks.hasConsent).toHaveBeenCalledWith("db-plugin");
    // The consent gate short-circuits before getConnection is consulted.
    expect(pluginManagerMocks.getConnection).not.toHaveBeenCalled();
  });

  it("does not resolve a prototype-pollution component name", () => {
    projectRegistryMocks.getProject.mockReturnValue(
      makeProject({ components: { db: { plugin: { id: "db-plugin" } } } }),
    );
    const result = resolveBinding("proj", "__proto__");
    expect(result).toEqual({ reason: "unknown-component" });
  });
});
