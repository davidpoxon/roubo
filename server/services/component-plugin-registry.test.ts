import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RegisteredProject, RouboConfig } from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";

const pluginManagerMocks = vi.hoisted(() => ({
  getConnection: vi.fn<(id: string) => JsonRpcConnection | null>(() => null),
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
