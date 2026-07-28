import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "claude-code",
    kind: "agent",
    roubo: "^1.4.0",
    ...overrides,
  } as PluginManifest;
}

function makeRecord(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "claude-code",
    manifest: makeManifest(),
    manifestPath: "/tmp/plugin/roubo-plugin.yaml",
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
  getRecord: vi.fn<(id: string) => PluginRecord | undefined>(),
  getAgentManifests: vi.fn<() => PluginManifest[]>(() => []),
  invoke: vi.fn(),
  HOST_API_VERSION: "1.4.0",
}));
vi.mock("./plugin-manager.js", () => pluginManagerMocks);

const consentMocks = vi.hoisted(() => ({
  hasConsent: vi.fn<(id: string) => boolean>(() => true),
}));
vi.mock("./plugin-consent-state.js", () => consentMocks);

import {
  describeAgentNotAvailable,
  isAgentNotAvailable,
  listAgents,
  requestLaunchDescriptor,
  resolveAgent,
} from "./agent-plugin-registry.js";

const fakeConnection = {} as JsonRpcConnection;

beforeEach(() => {
  pluginManagerMocks.getConnection.mockReset().mockReturnValue(fakeConnection);
  pluginManagerMocks.getRecord.mockReset().mockReturnValue(makeRecord());
  pluginManagerMocks.getAgentManifests.mockReset().mockReturnValue([]);
  pluginManagerMocks.invoke.mockReset();
  consentMocks.hasConsent.mockReset().mockReturnValue(true);
});

describe("listAgents", () => {
  it("returns every installed agent-kind manifest, whatever its status", () => {
    const manifests = [makeManifest(), makeManifest({ id: "codex" })];
    pluginManagerMocks.getAgentManifests.mockReturnValue(manifests);
    expect(listAgents()).toEqual(manifests);
  });
});

describe("resolveAgent", () => {
  it("resolves an installed, compatible, consented, running agent to its live connection", () => {
    const resolved = resolveAgent("claude-code");
    expect(isAgentNotAvailable(resolved)).toBe(false);
    if (isAgentNotAvailable(resolved)) return;
    expect(resolved.pluginId).toBe("claude-code");
    expect(resolved.connection).toBe(fakeConnection);
    expect(resolved.manifest.kind).toBe("agent");
  });

  it("reports not-installed before consulting consent (an unknown id is never a consent problem)", () => {
    pluginManagerMocks.getRecord.mockReturnValue(undefined);
    expect(resolveAgent("nope")).toEqual({ reason: "not-installed", pluginId: "nope" });
    expect(consentMocks.hasConsent).not.toHaveBeenCalled();
  });

  it("reports not-an-agent when the id resolves to a different plugin kind", () => {
    pluginManagerMocks.getRecord.mockReturnValue(
      makeRecord({ manifest: makeManifest({ kind: "component" }) }),
    );
    expect(resolveAgent("claude-code")).toEqual({
      reason: "not-an-agent",
      pluginId: "claude-code",
      kind: "component",
    });
  });

  it("reports incompatible before consent, naming the range and host version", () => {
    pluginManagerMocks.getRecord.mockReturnValue(
      makeRecord({ status: "incompatible", manifest: makeManifest({ roubo: "^9.0.0" }) }),
    );
    consentMocks.hasConsent.mockReturnValue(false);
    expect(resolveAgent("claude-code")).toEqual({
      reason: "incompatible",
      pluginId: "claude-code",
      requiredRange: "^9.0.0",
      hostVersion: "1.4.0",
    });
    expect(consentMocks.hasConsent).not.toHaveBeenCalled();
  });

  it("leaves a running agent inert when consent was declined (AP-TC-014 S002)", () => {
    consentMocks.hasConsent.mockReturnValue(false);
    expect(resolveAgent("claude-code")).toEqual({
      reason: "not-consented",
      pluginId: "claude-code",
    });
    // The gate short-circuits before a connection is ever handed out, so no
    // runtime capability is granted by the plugin merely being up.
    expect(pluginManagerMocks.getConnection).not.toHaveBeenCalled();
  });

  it("reports plugin-unavailable when consented but not currently running", () => {
    pluginManagerMocks.getConnection.mockReturnValue(null);
    expect(resolveAgent("claude-code")).toEqual({
      reason: "plugin-unavailable",
      pluginId: "claude-code",
    });
  });
});

describe("describeAgentNotAvailable", () => {
  it("explains every reason distinctly", () => {
    const messages = [
      describeAgentNotAvailable({ reason: "not-installed", pluginId: "a" }),
      describeAgentNotAvailable({ reason: "not-an-agent", pluginId: "a", kind: "integration" }),
      describeAgentNotAvailable({
        reason: "incompatible",
        pluginId: "a",
        requiredRange: "^9.0.0",
        hostVersion: "1.4.0",
      }),
      describeAgentNotAvailable({ reason: "not-consented", pluginId: "a" }),
      describeAgentNotAvailable({ reason: "plugin-unavailable", pluginId: "a" }),
    ];
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages[3]).toMatch(/consent/i);
  });
});

describe("requestLaunchDescriptor", () => {
  it("invokes translateLaunch over the ordinary plugin-manager RPC path", async () => {
    const descriptor = { schemaVersion: 1, kind: "agent-launch", command: "claude", args: [] };
    pluginManagerMocks.invoke.mockResolvedValue(descriptor);

    const params = { config: { model: "haiku" }, context: { sessionId: "s-1" } };
    await expect(requestLaunchDescriptor("claude-code", params)).resolves.toEqual(descriptor);
    expect(pluginManagerMocks.invoke).toHaveBeenCalledWith(
      "claude-code",
      "translateLaunch",
      params,
      undefined,
    );
  });

  it("passes a caller-supplied timeout through", async () => {
    pluginManagerMocks.invoke.mockResolvedValue({});
    await requestLaunchDescriptor("claude-code", { config: {}, context: {} }, { timeoutMs: 5000 });
    expect(pluginManagerMocks.invoke).toHaveBeenCalledWith(
      "claude-code",
      "translateLaunch",
      expect.anything(),
      { timeoutMs: 5000 },
    );
  });
});
