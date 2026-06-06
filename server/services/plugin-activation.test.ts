import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./project-registry.js", () => ({ getProject: vi.fn() }));
vi.mock("./integration-overrides.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./integration-overrides.js")>();
  return {
    ...original,
    loadOverride: vi.fn(),
    // Stub the wrapper so the test doesn't read ~/.roubo/integrations/_global/
    // off disk. loadGlobalOverride is reached via a same-module lexical
    // reference that vi.mock can't intercept; mocking the wrapper is the
    // established pattern (see active-plugin.test.ts).
    getEffectiveWithGlobal: vi.fn((c, p) => ({
      ...(c ?? {}),
      ...(p?.integration ?? {}),
    })),
  };
});
vi.mock("./plugin-manager.js", () => ({ invoke: vi.fn(), listInstalled: vi.fn(() => []) }));

import {
  clearActivationCache,
  ensurePluginActivated,
  forgetPluginActivation,
  forgetProjectActivation,
  resolveSources,
  resolveExclusion,
} from "./plugin-activation.js";
import * as projectRegistry from "./project-registry.js";
import { loadOverride } from "./integration-overrides.js";
import * as pluginManager from "./plugin-manager.js";
import { getInstanceHost, clearInstanceRegistry } from "./plugin-instance-registry.js";

const PROJECT_ID = "proj-1";
const GITHUB_PLUGIN = "github-com";
const GHE_PLUGIN = "ghe";

// Manifest stubs matching what `pluginManager.listInstalled()` returns at
// runtime. The filter at plugin-config-filter.ts reads
// `manifest.configSchema.properties` to decide which `advanced.*` keys are
// legal, so the tests must provide enough of the manifest for that lookup.
const GHE_MANIFEST = {
  id: GHE_PLUGIN,
  configSchema: {
    type: "object",
    properties: {
      instance: { type: "string" },
      allowSelfSignedTls: { type: "boolean" },
    },
  },
};
const GITHUB_MANIFEST = {
  id: GITHUB_PLUGIN,
  configSchema: {
    type: "object",
    properties: {
      sources: { type: "array" },
    },
  },
};
const OTHER_MANIFEST = {
  id: "other",
  configSchema: {
    type: "object",
    properties: { instance: { type: "string" } },
  },
};

function mockInstalledPlugins(): void {
  vi.mocked(pluginManager.listInstalled).mockReturnValue([
    { id: GHE_PLUGIN, manifest: GHE_MANIFEST },
    { id: GITHUB_PLUGIN, manifest: GITHUB_MANIFEST },
    { id: "other", manifest: OTHER_MANIFEST },
  ] as never);
}

function mockGithubProject(sources: Record<string, string[]> | undefined): void {
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    config: {
      integration: sources ? { plugin: GITHUB_PLUGIN, sources } : { plugin: GITHUB_PLUGIN },
    },
  } as never);
  vi.mocked(loadOverride).mockReturnValue(null);
}

function mockGheProject(opts: {
  instance?: string;
  sources?: Record<string, string[]>;
  advanced?: Record<string, unknown>;
}): void {
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    config: {
      integration: {
        plugin: GHE_PLUGIN,
        ...(opts.instance ? { instance: opts.instance } : {}),
        ...(opts.sources ? { sources: opts.sources } : {}),
        ...(opts.advanced ? { advanced: opts.advanced } : {}),
      },
    },
  } as never);
  vi.mocked(loadOverride).mockReturnValue(null);
}

describe("ensurePluginActivated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActivationCache();
    clearInstanceRegistry();
    mockInstalledPlugins();
  });

  it("is a no-op for a plugin with no plugin-wide config (e.g. github-com)", async () => {
    mockGithubProject({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, GITHUB_PLUGIN);

    // No instance / advanced fields => nothing plugin-wide to push.
    expect(pluginManager.invoke).not.toHaveBeenCalled();
    // ...and no instance constraint is recorded, so host.fetch stays governed
    // by the manifest allowlist alone (#338).
    expect(getInstanceHost(GITHUB_PLUGIN)).toBeNull();
  });

  it("records the configured instance host for host.fetch enforcement (#338)", async () => {
    mockGheProject({ instance: "https://GHE.Example.com:8443" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);

    expect(getInstanceHost(GHE_PLUGIN)).toBe("ghe.example.com:8443");
  });

  it("updates the recorded instance host when the instance changes", async () => {
    mockGheProject({ instance: "https://ghe-a.example.com" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    expect(getInstanceHost(GHE_PLUGIN)).toBe("ghe-a.example.com");

    mockGheProject({ instance: "https://ghe-b.example.com" });
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    expect(getInstanceHost(GHE_PLUGIN)).toBe("ghe-b.example.com");
  });

  it("pushes plugin-wide config (instance, advanced) via setActiveConfig and omits per-project sources", async () => {
    mockGheProject({
      instance: "https://ghe.example.com",
      sources: { Repository: ["foo/bar"] },
      advanced: { allowSelfSignedTls: true },
    });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);

    expect(pluginManager.invoke).toHaveBeenCalledWith(
      GHE_PLUGIN,
      "setActiveConfig",
      {
        config: {
          instance: "https://ghe.example.com",
          allowSelfSignedTls: true,
        },
      },
      { timeoutMs: 5_000 },
    );
  });

  it("skips the round-trip when called twice with the same plugin-wide config", async () => {
    mockGheProject({ instance: "https://ghe.example.com" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);

    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not re-push when a different project shares the same plugin-wide config (no cross-project bleed)", async () => {
    // Both projects use the same GHE instance; the plugin-wide config is
    // identical, so the host should push exactly once across both projects.
    mockGheProject({ instance: "https://ghe.example.com" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated("proj-a", GHE_PLUGIN);
    await ensurePluginActivated("proj-b", GHE_PLUGIN);

    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);
  });

  it("re-pushes after forgetProjectActivation invalidates the cache", async () => {
    mockGheProject({ instance: "https://ghe.example.com" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    forgetProjectActivation(PROJECT_ID, GHE_PLUGIN);
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);

    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
  });

  it("re-pushes when the plugin-wide config changes between calls", async () => {
    mockGheProject({ instance: "https://ghe-a.example.com" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);

    mockGheProject({ instance: "https://ghe-b.example.com" });
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);

    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
  });

  it("throws when the plugin reports activation failure and does not cache", async () => {
    mockGheProject({ instance: "https://ghe.example.com" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      ok: false,
      errors: [{ field: "instance", message: "must be an http(s) URL" }],
    });

    await expect(ensurePluginActivated(PROJECT_ID, GHE_PLUGIN)).rejects.toThrow(
      /instance: must be an http\(s\) URL/,
    );

    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    // Second call must have actually invoked, proving the failure was not cached.
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
  });

  it("filters stale advanced keys (issue #125) so no RPC is sent when nothing legitimate remains", async () => {
    // Reproduces the production state where ~/.roubo/integrations/_global/
    // github-com.yaml carries a stale `advanced.sources: ""` from before
    // commit 23ea55b. github-com's manifest declares `sources` only at the
    // top level, so the filter strips it from `advanced` and the resulting
    // plugin-wide payload is empty. `ensurePluginActivated` early-returns
    // without paying any JSON-RPC round-trip.
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        integration: {
          plugin: GITHUB_PLUGIN,
          advanced: { sources: "" },
        },
      },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensurePluginActivated(PROJECT_ID, GITHUB_PLUGIN)).resolves.toBeUndefined();
    expect(pluginManager.invoke).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${GITHUB_PLUGIN}: dropping stale advanced keys`),
    );
  });

  it("swallows MethodNotFound when the plugin has plugin-wide config but no setActiveConfig handler, and caches the snapshot", async () => {
    // Even with #125 fixed there is still a legitimate scenario for the
    // MethodNotFound swallow: a plugin that has real plugin-wide config the
    // host can push (e.g. an `instance`) but doesn't register a handler. The
    // host should not page the user; treat it as a no-op and cache.
    mockGheProject({ instance: "https://ghe.example.com" });
    const notFound = Object.assign(new Error("Unhandled method setActiveConfig"), {
      code: "MethodNotFound",
    });
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(notFound);

    await expect(ensurePluginActivated(PROJECT_ID, GHE_PLUGIN)).resolves.toBeUndefined();
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);

    // Cached: the second call must not retry.
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the project is unknown (route handler will 503)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);

    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("forgetPluginActivation clears the cache so the next call re-pushes", async () => {
    mockGheProject({ instance: "https://ghe.example.com" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);

    forgetPluginActivation(GHE_PLUGIN);

    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
  });

  it("forgetPluginActivation leaves other plugins' cache entries untouched", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    mockGheProject({ instance: "https://ghe.example.com" });
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);

    // Switch project context to a fictional second plugin with its own
    // plugin-wide config so the activation cache holds an entry for each.
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: "other", instance: "https://other.example.com" } },
    } as never);
    await ensurePluginActivated(PROJECT_ID, "other");

    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);

    forgetPluginActivation(GHE_PLUGIN);

    // GHE should re-push; `other` should stay cached.
    mockGheProject({ instance: "https://ghe.example.com" });
    await ensurePluginActivated(PROJECT_ID, GHE_PLUGIN);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: "other", instance: "https://other.example.com" } },
    } as never);
    await ensurePluginActivated(PROJECT_ID, "other");

    expect(pluginManager.invoke).toHaveBeenCalledTimes(3);
  });
});

describe("resolveSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("translates SourceSelection categories to {kind, externalId}[]", () => {
    mockGithubProject({ Repository: ["foo/bar", "foo/baz"], Project: ["foo/#1"] });
    expect(resolveSources(PROJECT_ID)).toEqual([
      { kind: "repo", externalId: "foo/bar" },
      { kind: "repo", externalId: "foo/baz" },
      { kind: "project", externalId: "foo/#1" },
    ]);
  });

  it("returns [] when the project has no sources configured", () => {
    mockGithubProject(undefined);
    expect(resolveSources(PROJECT_ID)).toEqual([]);
  });

  it("returns [] when the project is unknown", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(resolveSources(PROJECT_ID)).toEqual([]);
  });

  it("warns and skips entries whose category the plugin does not recognise", () => {
    mockGithubProject({ Repository: ["foo/bar"], Milestone: ["foo/m1"] } as Record<
      string,
      string[]
    >);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveSources(PROJECT_ID)).toEqual([{ kind: "repo", externalId: "foo/bar" }]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`ignoring unknown source category "Milestone"`),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(GITHUB_PLUGIN));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(PROJECT_ID));
  });
});

describe("resolveExclusion (FR-009/FR-010)", () => {
  const JIRA_PLUGIN = "jira-self-hosted";
  const JIRA_MANIFEST = {
    id: JIRA_PLUGIN,
    configSchema: { type: "object", properties: { instance: { type: "string" } } },
    defaultIntegrationConfig: {
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed", "Done", "Resolved"],
    },
  };

  function mockJiraProject(integration: Record<string, unknown>): void {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { integration: { plugin: JIRA_PLUGIN, ...integration } },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      { id: JIRA_PLUGIN, manifest: JIRA_MANIFEST },
    ] as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the plugin manifest defaults when the project config is silent", () => {
    mockJiraProject({});
    expect(resolveExclusion(PROJECT_ID)).toEqual({
      excludedStatusCategories: ["Done"],
      excludedStatuses: ["Closed", "Done", "Resolved"],
    });
  });

  it("lets the project config override the manifest category default", () => {
    mockJiraProject({ excludedStatusCategories: ["In Progress"] });
    const result = resolveExclusion(PROJECT_ID);
    expect(result.excludedStatusCategories).toEqual(["In Progress"]);
    expect(result.excludedStatuses).toEqual(["Closed", "Done", "Resolved"]);
  });

  it("returns empty lists when the project is unknown", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    expect(resolveExclusion(PROJECT_ID)).toEqual({
      excludedStatusCategories: [],
      excludedStatuses: [],
    });
  });
});
