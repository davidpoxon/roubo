import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  PluginManifest,
  PluginRecord,
  RegisteredProject,
  UserPreferences,
} from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";

// The registry runs for real: its availability gate chain is precisely what
// decides whether a preset resolves, so mocking it would mock the thing under
// test. plugin-manager, the consent store, settings, and the project registry
// are the boundaries.
const pluginManagerMocks = vi.hoisted(() => ({
  getConnection: vi.fn<(id: string) => JsonRpcConnection | null>(() => ({}) as JsonRpcConnection),
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

const stateMocks = vi.hoisted(() => ({
  loadSettings: vi.fn<() => UserPreferences>(() => ({ theme: "dark" })),
}));
vi.mock("./state.js", () => stateMocks);

const projectRegistryMocks = vi.hoisted(() => ({
  getProject: vi.fn<(id: string) => RegisteredProject | undefined>(() => undefined),
}));
vi.mock("./project-registry.js", () => projectRegistryMocks);

// The app-level config a preset's params overlay. Mocked so the overlay is
// declared per test rather than read off the developer's own ~/.roubo.
const agentOverrideMocks = vi.hoisted(() => ({
  getEffectiveAgentConfig: vi.fn<(id: string) => Record<string, unknown>>(() => ({})),
}));
vi.mock("./agent-overrides.js", () => agentOverrideMocks);

import { listAgentPresets, resolveAgentPreset } from "./agent-presets.js";
import { resetAgentConfigValidatorCache } from "./agent-config-validator.js";

const MODE_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["plan", "auto"] },
    model: { type: "string", enum: ["opus", "sonnet"] },
  },
  additionalProperties: false,
};

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "claude-code",
    name: "Claude Code",
    kind: "agent",
    roubo: "^1.4.0",
    version: "1.0.0",
    configSchema: MODE_SCHEMA,
    ...overrides,
  } as PluginManifest;
}

function makeRecord(manifest: PluginManifest): PluginRecord {
  return {
    id: manifest.id,
    manifest,
    manifestPath: "/tmp/plugin/roubo-plugin.yaml",
    pluginDir: "/tmp/plugin",
    source: "bundled" as PluginRecord["source"],
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: null,
  };
}

/** Install a set of agent plugins into the mocked plugin manager. */
function installAgents(manifests: PluginManifest[]) {
  const byId = new Map(manifests.map((m) => [m.id, makeRecord(m)]));
  pluginManagerMocks.getRecord.mockImplementation((id) => byId.get(id));
  pluginManagerMocks.getAgentManifests.mockReturnValue(manifests);
}

const CLAUDE = makeManifest();
const CODEX = makeManifest({ id: "codex-cli", name: "Codex CLI" });

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentConfigValidatorCache();
  pluginManagerMocks.getConnection.mockReturnValue({} as JsonRpcConnection);
  consentMocks.hasConsent.mockReturnValue(true);
  stateMocks.loadSettings.mockReturnValue({ theme: "dark" });
  projectRegistryMocks.getProject.mockReturnValue(undefined);
  agentOverrideMocks.getEffectiveAgentConfig.mockReturnValue({});
  installAgents([CLAUDE, CODEX]);
});

function setDefaultAgent(pluginId?: string) {
  stateMocks.loadSettings.mockReturnValue({
    theme: "dark",
    jigs: {
      autoInject: true,
      autoExecute: true,
      ...(pluginId !== undefined && { defaultAgentPluginId: pluginId }),
    },
  });
}

describe("built-in presets", () => {
  it("ships Agent, Agent (Plan) and Agent (Auto), all bound to the default agent", () => {
    setDefaultAgent("claude-code");
    const builtins = listAgentPresets().filter((p) => p.source === "builtin");
    expect(builtins.map((p) => p.name)).toEqual(["Agent", "Agent (Plan)", "Agent (Auto)"]);
    expect(builtins.every((p) => p.bindsDefaultAgent)).toBe(true);
    expect(builtins.map((p) => p.params.mode)).toEqual([undefined, "plan", "auto"]);
  });

  // AP-TC-027, AP-TC-042: the built-ins resolve to the current default agent.
  it("resolves every built-in to the current default agent", () => {
    setDefaultAgent("claude-code");
    const builtins = listAgentPresets().filter((p) => p.source === "builtin");
    expect(builtins.every((p) => p.agentPluginId === "claude-code")).toBe(true);
    expect(builtins.every((p) => p.resolvedAgentName === "Claude Code")).toBe(true);
  });

  // AP-TC-031, AP-TC-039, AP-TC-045: resolution is lazy, so a default change
  // re-points the built-ins with nothing stored to invalidate.
  it("re-resolves when the default agent changes", () => {
    setDefaultAgent("claude-code");
    expect(listAgentPresets()[0].agentPluginId).toBe("claude-code");
    setDefaultAgent("codex-cli");
    expect(listAgentPresets()[0].agentPluginId).toBe("codex-cli");
    expect(listAgentPresets()[0].resolvedAgentName).toBe("Codex CLI");
  });

  it("flags built-ins as unresolvable when no default agent is available", () => {
    installAgents([]);
    setDefaultAgent(undefined);
    const builtin = listAgentPresets()[0];
    expect(builtin.unresolved?.reason).toBe("no-default-agent");
    expect(builtin.agentPluginId).toBeUndefined();
  });

  it("falls back to the single installed agent when no default is persisted", () => {
    installAgents([CODEX]);
    setDefaultAgent(undefined);
    expect(listAgentPresets()[0].agentPluginId).toBe("codex-cli");
  });
});

describe("preset resolution", () => {
  // AP-TC-044: a plugin-bound preset ignores the default agent entirely.
  it("resolves a plugin-bound preset to its named agent regardless of the default", () => {
    setDefaultAgent("claude-code");
    const resolved = resolveAgentPreset(
      { id: "p1", name: "Quick fix", agent: "codex-cli" },
      "app",
      { defaultAgentPluginId: "claude-code" },
    );
    expect(resolved.bindsDefaultAgent).toBe(false);
    expect(resolved.agentPluginId).toBe("codex-cli");
    expect(resolved.resolvedAgentName).toBe("Codex CLI");
    expect(resolved.unresolved).toBeUndefined();
  });

  // AP-TC-032: an uninstalled plugin is flagged with a message naming it, and
  // the preset is left without a resolved agent so no launch can proceed.
  it("flags a preset bound to an uninstalled plugin", () => {
    installAgents([CLAUDE]);
    const resolved = resolveAgentPreset(
      { id: "p1", name: "Quick fix", agent: "codex-cli" },
      "app",
      { defaultAgentPluginId: "claude-code" },
    );
    expect(resolved.unresolved?.reason).toBe("agent-unavailable");
    expect(resolved.unresolved?.message).toContain("Quick fix");
    expect(resolved.unresolved?.message).toContain("codex-cli");
    expect(resolved.agentPluginId).toBeUndefined();
  });

  it("flags a preset whose agent has not been consented", () => {
    consentMocks.hasConsent.mockImplementation((id) => id !== "codex-cli");
    const resolved = resolveAgentPreset(
      { id: "p1", name: "Quick fix", agent: "codex-cli" },
      "app",
      { defaultAgentPluginId: "claude-code" },
    );
    expect(resolved.unresolved?.reason).toBe("agent-unavailable");
  });

  // AP-TC-033: an invalid param names both the preset and the parameter.
  it("rejects params the bound agent's configSchema refuses", () => {
    const resolved = resolveAgentPreset(
      { id: "p1", name: "Turbo", agent: "claude-code", params: { mode: "turbo" } },
      "project",
      { defaultAgentPluginId: "claude-code" },
    );
    expect(resolved.unresolved?.reason).toBe("invalid-params");
    expect(resolved.unresolved?.message).toContain("Turbo");
    expect(resolved.unresolved?.message).toContain("mode");
    expect(resolved.unresolved?.message).toContain("plan, auto");
  });

  it("accepts params the bound agent's configSchema allows", () => {
    const resolved = resolveAgentPreset(
      {
        id: "p1",
        name: "Deep work",
        agent: "claude-code",
        params: { mode: "plan", model: "opus" },
      },
      "app",
      { defaultAgentPluginId: "claude-code" },
    );
    expect(resolved.unresolved).toBeUndefined();
    expect(resolved.params).toEqual({ mode: "plan", model: "opus" });
  });

  // A preset's params are a partial override, so a field the schema marks
  // required but the preset does not set is the app config's problem, not the
  // preset's. Validating the bare bag would take the shipped built-ins down on
  // any agent whose schema has a required field.
  it("does not reject a partial override against a schema with a required field", () => {
    const REQUIRED_MODEL = makeManifest({
      id: "picky-agent",
      name: "Picky Agent",
      configSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["plan", "auto"] },
          model: { type: "string", enum: ["opus", "sonnet"] },
        },
        required: ["model"],
        additionalProperties: false,
      },
    });
    installAgents([REQUIRED_MODEL]);
    agentOverrideMocks.getEffectiveAgentConfig.mockReturnValue({});

    const builtins = listAgentPresets().filter((p) => p.source === "builtin");
    const plan = builtins.find((p) => p.name === "Agent (Plan)");
    expect(plan?.unresolved).toBeUndefined();
    expect(plan?.resolvedAgentName).toBe("Picky Agent");

    // The preset's OWN bad param is still rejected (AP-TC-033 still holds).
    const bad = resolveAgentPreset(
      { id: "p1", name: "Turbo", agent: "picky-agent", params: { mode: "turbo" } },
      "app",
      { defaultAgentPluginId: "picky-agent" },
    );
    expect(bad.unresolved?.reason).toBe("invalid-params");
    expect(bad.unresolved?.message).toContain("mode");
  });

  // Issue #654: `mode` is a per-plugin `configSchema` key, not a host concept,
  // but the built-ins hardcode it. An agent whose schema closes
  // `additionalProperties` and never declares `mode` therefore made
  // `Agent (Plan)` and `Agent (Auto)` permanently unlaunchable, and built-ins
  // cannot be edited or deleted. Built-ins degrade instead: the rejected key is
  // dropped and the preset launches as plain `Agent`.
  describe("a built-in whose hardcoded param the bound agent's schema rejects", () => {
    const POSTURE_ONLY = makeManifest({
      id: "posture-agent",
      name: "Posture Agent",
      configSchema: {
        type: "object",
        properties: { posture: { type: "string", enum: ["read-only", "write"] } },
        additionalProperties: false,
      },
    });

    beforeEach(() => {
      installAgents([POSTURE_ONLY]);
      setDefaultAgent("posture-agent");
    });

    it("resolves every built-in, dropping the rejected param", () => {
      const builtins = listAgentPresets().filter((p) => p.source === "builtin");
      expect(builtins.map((p) => p.name)).toEqual(["Agent", "Agent (Plan)", "Agent (Auto)"]);
      expect(builtins.every((p) => p.unresolved === undefined)).toBe(true);
      expect(builtins.every((p) => p.agentPluginId === "posture-agent")).toBe(true);
      expect(builtins.every((p) => p.resolvedAgentName === "Posture Agent")).toBe(true);
      // Degraded to plain-Agent behavior: `mode` is gone from the resolved params.
      expect(builtins.map((p) => p.params)).toEqual([{}, {}, {}]);
    });

    // Issue #665: the drop used to be completely silent, so `Agent (Plan)`
    // launched as plain `Agent` under its own name with nothing to say so.
    it("reports the drop as an advisory notice that leaves the preset launchable", () => {
      const builtins = listAgentPresets().filter((p) => p.source === "builtin");
      const degraded = builtins.filter((p) => p.name !== "Agent");
      expect(degraded.map((p) => p.name)).toEqual(["Agent (Plan)", "Agent (Auto)"]);

      for (const preset of degraded) {
        expect(preset.degraded?.droppedParams).toEqual(["mode"]);
        expect(preset.degraded?.message).toContain(preset.name);
        expect(preset.degraded?.message).toContain("mode");
        expect(preset.degraded?.message).toContain("Posture Agent");
        // Advisory only. `unresolved` is what a launch surface derives
        // `enabled` from, and it must stay clear.
        expect(preset.unresolved).toBeUndefined();
      }
    });

    // Plain `Agent` sets no params at all, so nothing was ever dropped for it.
    it("does not mark the paramless built-in degraded", () => {
      const agent = listAgentPresets().find((p) => p.name === "Agent");
      expect(agent?.degraded).toBeUndefined();
      expect(agent?.unresolved).toBeUndefined();
    });

    // The carve-out is source-gated, not blanket: an app or project preset is
    // editable, so its bad param stays surfaced rather than silently dropped.
    it("still hard-rejects the same param on a project preset", () => {
      const resolved = resolveAgentPreset(
        { id: "project:Plan", name: "Plan", agent: "default", params: { mode: "plan" } },
        "project",
        { defaultAgentPluginId: "posture-agent" },
      );
      expect(resolved.unresolved?.reason).toBe("invalid-params");
      expect(resolved.unresolved?.message).toContain("Plan");
      expect(resolved.unresolved?.message).toContain("mode");
      expect(resolved.params).toEqual({ mode: "plan" });
      // The advisory notice belongs to the degrade path only: this preset was
      // rejected outright, not degraded (issue #665).
      expect(resolved.degraded).toBeUndefined();
    });

    it("still hard-rejects the same param on an app preset", () => {
      const resolved = resolveAgentPreset(
        { id: "at-1", name: "Deep work", agent: "posture-agent", params: { mode: "plan" } },
        "app",
        { defaultAgentPluginId: "posture-agent" },
      );
      expect(resolved.unresolved?.reason).toBe("invalid-params");
      expect(resolved.degraded).toBeUndefined();
    });
  });

  it("validates a preset's params against the app defaults they overlay", () => {
    agentOverrideMocks.getEffectiveAgentConfig.mockReturnValue({ model: "opus" });
    const resolved = resolveAgentPreset(
      { id: "p1", name: "Deep work", agent: "claude-code", params: { mode: "plan" } },
      "app",
      { defaultAgentPluginId: "claude-code" },
    );
    expect(resolved.unresolved).toBeUndefined();
    // The overlay is a validation input only; the preset still records exactly
    // the overrides it set, never the merged result.
    expect(resolved.params).toEqual({ mode: "plan" });
  });

  it("carries the preset's jig behavior through unchanged", () => {
    const resolved = resolveAgentPreset(
      { id: "p1", name: "Triage", agent: "claude-code", jig: "__none__" },
      "app",
      { defaultAgentPluginId: "claude-code" },
    );
    expect(resolved.jig).toBe("__none__");
  });
});

describe("listAgentPresets", () => {
  // AP-TC-026: project presets sit alongside app presets, neither overriding
  // the other.
  it("merges built-in, app-level and roubo.yaml presets", () => {
    stateMocks.loadSettings.mockReturnValue({
      theme: "dark",
      jigs: { autoInject: true, autoExecute: true, defaultAgentPluginId: "claude-code" },
      agentTools: [{ id: "at-1", name: "Deep work", agent: "codex-cli", params: { mode: "plan" } }],
    });
    projectRegistryMocks.getProject.mockReturnValue({
      config: {
        tools: [
          { type: "shell", name: "Editor", icon: "code", command: "code ." },
          { type: "agent", name: "Repo triage", agent: "default", params: { mode: "auto" } },
        ],
      },
    } as unknown as RegisteredProject);

    const presets = listAgentPresets("proj-1");
    expect(presets.map((p) => [p.source, p.name])).toEqual([
      ["builtin", "Agent"],
      ["builtin", "Agent (Plan)"],
      ["builtin", "Agent (Auto)"],
      ["app", "Deep work"],
      ["project", "Repo triage"],
    ]);
    // The app preset stays pinned to Codex; the project preset follows the default.
    expect(presets[3].agentPluginId).toBe("codex-cli");
    expect(presets[4].agentPluginId).toBe("claude-code");
    expect(presets[4].id).toBe("project:Repo triage");
  });

  it("omits non-agent tools from the project layer", () => {
    setDefaultAgent("claude-code");
    projectRegistryMocks.getProject.mockReturnValue({
      config: {
        tools: [{ type: "browser", name: "Web App", icon: "globe", url: "http://localhost:3000" }],
      },
    } as unknown as RegisteredProject);
    expect(listAgentPresets("proj-1").every((p) => p.source === "builtin")).toBe(true);
  });

  // Issue #649: `loadSettings` is uncached, so the batch must resolve off the
  // two reads it makes itself (the hoisted default, and the app presets) rather
  // than one per preset. No default agent set is the case that used to defeat
  // the hoist, because passing an explicit `undefined` re-triggered a
  // default-parameter read for every preset.
  it("reads settings a fixed number of times per batch when no default agent is set", () => {
    installAgents([CODEX]);
    stateMocks.loadSettings.mockReturnValue({
      theme: "dark",
      jigs: { autoInject: true, autoExecute: true },
      agentTools: [
        { id: "at-1", name: "Deep work", agent: "default" },
        { id: "at-2", name: "Triage", agent: "default" },
      ],
    });
    projectRegistryMocks.getProject.mockReturnValue({
      config: { tools: [{ type: "agent", name: "Repo triage", agent: "default" }] },
    } as unknown as RegisteredProject);

    const presets = listAgentPresets("proj-1");
    expect(presets).toHaveLength(6);
    expect(presets.every((p) => p.agentPluginId === "codex-cli")).toBe(true);
    // Two reads: the hoisted default and `listAppAgentPresets`. Never per preset.
    expect(stateMocks.loadSettings).toHaveBeenCalledTimes(2);
  });
});
