import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";

// The registry is exercised for real (its gate chain is what surfaces an
// unavailable agent), so plugin-manager and the consent store are the mocks.
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

// The two STORED layers are mocked at their read boundary; `mergeAgentConfig`
// stays real so the overlay semantics under test are the shipped ones.
const appLayerMocks = vi.hoisted(() => ({
  getEffectiveAgentConfig: vi.fn<() => Record<string, unknown>>(() => ({})),
}));
vi.mock("./agent-overrides.js", () => appLayerMocks);

const projectLayerMocks = vi.hoisted(() => ({
  getProjectAgentOverrides: vi.fn<() => Record<string, unknown>>(() => ({})),
}));
vi.mock("./agent-project-overrides.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-project-overrides.js")>();
  return { ...actual, getProjectAgentOverrides: projectLayerMocks.getProjectAgentOverrides };
});

import {
  AgentUnavailableError,
  prepareAgentLaunch,
  resolveEffectiveAgentConfig,
  resolveLaunchAgentId,
} from "./agent-launch-pipeline.js";
import { AgentDescriptorError } from "./agent-launch-executor.js";

const fakeConnection = {} as JsonRpcConnection;

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "claude-code",
    name: "Claude Code",
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

function makeDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: "claude",
    args: ["--session-id", "{{sessionId}}"],
    ...overrides,
  };
}

const launchParams = {
  pluginId: "claude-code",
  projectId: "roubo",
  benchId: 3,
  workspacePath: "/workspaces/bench-3",
  sessionId: "11111111-2222-3333-4444-555555555555",
};

beforeEach(() => {
  pluginManagerMocks.getConnection.mockReset().mockReturnValue(fakeConnection);
  pluginManagerMocks.getRecord.mockReset().mockReturnValue(makeRecord());
  pluginManagerMocks.getAgentManifests.mockReset().mockReturnValue([]);
  pluginManagerMocks.invoke.mockReset().mockResolvedValue(makeDescriptor());
  consentMocks.hasConsent.mockReset().mockReturnValue(true);
  appLayerMocks.getEffectiveAgentConfig.mockReset().mockReturnValue({});
  projectLayerMocks.getProjectAgentOverrides.mockReset().mockReturnValue({});
});

describe("resolveEffectiveAgentConfig (AP-FR-011 four-layer order)", () => {
  it("applies application defaults, project overrides, preset, then per-launch, in that order", () => {
    appLayerMocks.getEffectiveAgentConfig.mockReturnValue({
      model: "app",
      posture: "app",
      extraArgs: "app",
      onlyApp: "app",
    });
    projectLayerMocks.getProjectAgentOverrides.mockReturnValue({
      model: "project",
      posture: "project",
      extraArgs: "project",
    });

    const effective = resolveEffectiveAgentConfig("roubo", "claude-code", {
      preset: { model: "preset", posture: "preset" },
      perLaunch: { model: "per-launch" },
    });

    expect(effective).toEqual({
      // Each field is won by the last layer that mentions it.
      model: "per-launch",
      posture: "preset",
      extraArgs: "project",
      onlyApp: "app",
    });
  });

  it("lets a field absent from every higher layer keep tracking the app default", () => {
    appLayerMocks.getEffectiveAgentConfig.mockReturnValue({ model: "opus", verbose: true });
    projectLayerMocks.getProjectAgentOverrides.mockReturnValue({ verbose: false });

    expect(resolveEffectiveAgentConfig("roubo", "claude-code")).toEqual({
      model: "opus",
      verbose: false,
    });
  });

  it("treats an explicit falsy or null override as an override, not an absence", () => {
    appLayerMocks.getEffectiveAgentConfig.mockReturnValue({ model: "opus", verbose: true });

    expect(
      resolveEffectiveAgentConfig("roubo", "claude-code", {
        perLaunch: { model: null, verbose: false },
      }),
    ).toEqual({ model: null, verbose: false });
  });
});

describe("resolveLaunchAgentId (AP-FR-006 launch resolution order)", () => {
  /** Only `installed` resolves; every other id is an uninstalled plugin. */
  function onlyInstalled(...installed: string[]) {
    pluginManagerMocks.getRecord.mockImplementation((id: string) =>
      installed.includes(id) ? makeRecord({ id, manifest: makeManifest({ id }) }) : undefined,
    );
  }

  it("returns the jig's binding when the jig has one (AP-TC-021 S001)", () => {
    onlyInstalled("claude-code", "codex-cli");

    expect(
      resolveLaunchAgentId({
        jigAgentPluginId: "claude-code",
        defaultAgentPluginId: "codex-cli",
      }),
    ).toBe("claude-code");
  });

  it("falls back to the current default when the jig has no binding (AP-TC-021 S002)", () => {
    onlyInstalled("claude-code", "codex-cli");

    expect(resolveLaunchAgentId({ defaultAgentPluginId: "codex-cli" })).toBe("codex-cli");
  });

  it("leaves an explicit binding untouched by a default change (AP-TC-021 S003)", () => {
    onlyInstalled("claude-code", "codex-cli");

    // The default moved to codex-cli; the bound jig still resolves to its own agent.
    expect(
      resolveLaunchAgentId({
        jigAgentPluginId: "claude-code",
        defaultAgentPluginId: "codex-cli",
      }),
    ).toBe("claude-code");
  });

  it("falls back to the default when the bound agent is no longer installed (AP-TC-035 S002)", () => {
    onlyInstalled("claude-code");

    expect(
      resolveLaunchAgentId({
        jigAgentPluginId: "codex-cli",
        defaultAgentPluginId: "claude-code",
      }),
    ).toBe("claude-code");
  });

  it("falls back to the default when the bound agent is installed but unconsented", () => {
    onlyInstalled("claude-code", "codex-cli");
    consentMocks.hasConsent.mockImplementation((id: string) => id !== "codex-cli");

    expect(
      resolveLaunchAgentId({
        jigAgentPluginId: "codex-cli",
        defaultAgentPluginId: "claude-code",
      }),
    ).toBe("claude-code");
  });

  it("returns undefined when neither layer names an agent", () => {
    expect(resolveLaunchAgentId({})).toBeUndefined();
  });

  it("returns undefined when the only binding is unresolvable and no default is set", () => {
    onlyInstalled();

    expect(resolveLaunchAgentId({ jigAgentPluginId: "codex-cli" })).toBeUndefined();
  });

  it("falls through rather than failing the launch when the default is no longer installed", () => {
    // Two agents were installed when the default was chosen; both are gone now,
    // so there is nothing to degrade to and the launch stays on the built-in
    // command path instead of throwing AgentUnavailableError downstream.
    onlyInstalled();
    pluginManagerMocks.getAgentManifests.mockReturnValue([]);

    expect(resolveLaunchAgentId({ defaultAgentPluginId: "codex-cli" })).toBeUndefined();
  });

  it("does not pick a survivor when the stale default leaves more than one agent available", () => {
    onlyInstalled("claude-code", "codex-cli");
    pluginManagerMocks.getAgentManifests.mockReturnValue([
      makeManifest({ id: "claude-code" }),
      makeManifest({ id: "codex-cli", name: "Codex CLI" }),
    ]);

    // `gemini-cli` was uninstalled after being made the default; with two agents
    // still available there is no unambiguous stand-in, so resolution declines.
    expect(resolveLaunchAgentId({ defaultAgentPluginId: "gemini-cli" })).toBeUndefined();
  });

  it("treats a single configured agent as the default with nothing persisted (AP-TC-041 S001)", () => {
    onlyInstalled("claude-code");
    pluginManagerMocks.getAgentManifests.mockReturnValue([makeManifest({ id: "claude-code" })]);

    expect(resolveLaunchAgentId({})).toBe("claude-code");
  });

  it("degrades a stale default to the one agent that is actually available", () => {
    onlyInstalled("claude-code");
    pluginManagerMocks.getAgentManifests.mockReturnValue([makeManifest({ id: "claude-code" })]);

    expect(resolveLaunchAgentId({ defaultAgentPluginId: "codex-cli" })).toBe("claude-code");
  });

  it("still prefers a resolvable jig binding over the single-agent fallback", () => {
    onlyInstalled("claude-code", "codex-cli");
    pluginManagerMocks.getAgentManifests.mockReturnValue([makeManifest({ id: "claude-code" })]);

    expect(resolveLaunchAgentId({ jigAgentPluginId: "codex-cli" })).toBe("codex-cli");
  });
});

describe("prepareAgentLaunch", () => {
  it("passes the resolved config and the host-minted session id to translateLaunch", async () => {
    appLayerMocks.getEffectiveAgentConfig.mockReturnValue({ model: "app" });
    projectLayerMocks.getProjectAgentOverrides.mockReturnValue({ model: "project" });

    const prepared = await prepareAgentLaunch({ ...launchParams, initialPrompt: "do the thing" });

    expect(prepared.pluginId).toBe("claude-code");
    expect(prepared.manifest.name).toBe("Claude Code");
    expect(prepared.effectiveConfig).toEqual({ model: "project" });
    expect(pluginManagerMocks.invoke).toHaveBeenCalledWith(
      "claude-code",
      "translateLaunch",
      {
        config: { model: "project" },
        context: {
          projectId: "roubo",
          benchId: 3,
          workspacePath: "/workspaces/bench-3",
          sessionId: launchParams.sessionId,
          effectiveConfig: { model: "project" },
          initialPrompt: "do the thing",
        },
      },
      undefined,
    );
  });

  it("omits initialPrompt from the context when the launch carries none", async () => {
    await prepareAgentLaunch(launchParams);
    const context = pluginManagerMocks.invoke.mock.calls[0][2] as { context: object };
    expect(context.context).not.toHaveProperty("initialPrompt");
  });

  it("returns the descriptor validated against the shared schema", async () => {
    const prepared = await prepareAgentLaunch(launchParams);
    expect(prepared.descriptor.command).toBe("claude");
    expect(prepared.descriptor.args).toEqual(["--session-id", "{{sessionId}}"]);
  });

  it("rejects a descriptor the schema does not accept, before anything is spawned", async () => {
    pluginManagerMocks.invoke.mockResolvedValue({ schemaVersion: 1, kind: "agent-launch" });
    await expect(prepareAgentLaunch(launchParams)).rejects.toBeInstanceOf(AgentDescriptorError);
  });

  it("surfaces an unsupported descriptor schemaVersion by name", async () => {
    pluginManagerMocks.invoke.mockResolvedValue(makeDescriptor({ schemaVersion: 99 }));
    await expect(prepareAgentLaunch(launchParams)).rejects.toThrow(/schemaVersion 99/);
  });
});

describe("prepareAgentLaunch availability gate", () => {
  it("refuses an uninstalled agent without reading its config or calling the plugin", async () => {
    pluginManagerMocks.getRecord.mockReturnValue(undefined);

    const err = await prepareAgentLaunch(launchParams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentUnavailableError);
    expect((err as AgentUnavailableError).notAvailable.reason).toBe("not-installed");
    expect((err as Error).message).toMatch(/not installed/);
    expect(appLayerMocks.getEffectiveAgentConfig).not.toHaveBeenCalled();
    expect(pluginManagerMocks.invoke).not.toHaveBeenCalled();
  });

  it("refuses an unconsented agent even when its process is running", async () => {
    consentMocks.hasConsent.mockReturnValue(false);

    const err = await prepareAgentLaunch(launchParams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentUnavailableError);
    expect((err as AgentUnavailableError).notAvailable.reason).toBe("not-consented");
    expect(pluginManagerMocks.invoke).not.toHaveBeenCalled();
  });

  it("refuses an incompatible agent, naming the version mismatch", async () => {
    pluginManagerMocks.getRecord.mockReturnValue(makeRecord({ status: "incompatible" }));

    const err = await prepareAgentLaunch(launchParams).catch((e: unknown) => e);
    expect((err as AgentUnavailableError).notAvailable.reason).toBe("incompatible");
    expect((err as Error).message).toMatch(/requires roubo/);
  });

  it("refuses an installed plugin of a different kind", async () => {
    pluginManagerMocks.getRecord.mockReturnValue(
      makeRecord({ manifest: makeManifest({ kind: "integration" }) }),
    );

    const err = await prepareAgentLaunch(launchParams).catch((e: unknown) => e);
    expect((err as AgentUnavailableError).notAvailable.reason).toBe("not-an-agent");
  });

  it("refuses an agent whose plugin is installed but not currently running", async () => {
    pluginManagerMocks.getConnection.mockReturnValue(null);

    const err = await prepareAgentLaunch(launchParams).catch((e: unknown) => e);
    expect((err as AgentUnavailableError).notAvailable.reason).toBe("plugin-unavailable");
  });
});

describe("AP-TC-083: config values reach argv literally", () => {
  it("carries shell metacharacters from an extra-arguments field through unexpanded", async () => {
    const hostile = "--fallback-model sonnet ; $(touch /tmp/pwned)";
    appLayerMocks.getEffectiveAgentConfig.mockReturnValue({ extraArgs: hostile });
    // A realistic plugin splits its own extra-args field and returns argv
    // elements; whatever it returns, core never re-parses or shell-interprets it.
    pluginManagerMocks.invoke.mockImplementation(
      (_id: string, _method: string, params: { config: Record<string, unknown> }) =>
        Promise.resolve(
          makeDescriptor({
            args: ["--session-id", "{{sessionId}}", String(params.config.extraArgs)],
          }),
        ),
    );

    const prepared = await prepareAgentLaunch(launchParams);

    expect(prepared.descriptor.args).toEqual([
      "--session-id",
      "{{sessionId}}",
      "--fallback-model sonnet ; $(touch /tmp/pwned)",
    ]);
    // The value is a single argv element: nothing split it on `;` or `$(`.
    expect(prepared.descriptor.args[2]).toBe(hostile);
  });
});
