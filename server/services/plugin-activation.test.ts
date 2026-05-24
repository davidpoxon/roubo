import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./project-registry.js", () => ({ getProject: vi.fn() }));
vi.mock("./integration-overrides.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./integration-overrides.js")>();
  return {
    ...original,
    loadOverride: vi.fn(),
  };
});
vi.mock("./plugin-manager.js", () => ({ invoke: vi.fn() }));

import {
  clearActivationCache,
  ensurePluginActivated,
  forgetPluginActivation,
  forgetProjectActivation,
  resolveSources,
} from "./plugin-activation.js";
import * as projectRegistry from "./project-registry.js";
import { loadOverride } from "./integration-overrides.js";
import * as pluginManager from "./plugin-manager.js";

const PROJECT_ID = "proj-1";
const GITHUB_PLUGIN = "github-com";
const GHE_PLUGIN = "ghe";

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
  });

  it("is a no-op for a plugin with no plugin-wide config (e.g. github-com)", async () => {
    mockGithubProject({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, GITHUB_PLUGIN);

    // No instance / advanced fields => nothing plugin-wide to push.
    expect(pluginManager.invoke).not.toHaveBeenCalled();
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

  it("swallows MethodNotFound when the plugin has no setActiveConfig handler and caches the snapshot", async () => {
    // Reproduces the production state where ~/.roubo/integrations/_global/
    // github-com.yaml carries a stale `advanced` field from before
    // commit 23ea55b. github-com no longer registers `setActiveConfig`, so
    // vscode-jsonrpc replies with -32601 (mapped to "MethodNotFound" by
    // plugin-manager.invoke). The host must treat this as a no-op so the
    // cut list keeps loading.
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        integration: {
          plugin: GITHUB_PLUGIN,
          advanced: { sources: "" },
        },
      },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);

    const notFound = Object.assign(new Error("Unhandled method setActiveConfig"), {
      code: "MethodNotFound",
    });
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(notFound);

    await expect(ensurePluginActivated(PROJECT_ID, GITHUB_PLUGIN)).resolves.toBeUndefined();
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);

    // Subsequent calls must not retry: the snapshot was cached on the
    // swallowed MethodNotFound so we don't pay the JSON-RPC round-trip
    // (and noisy plugin log line) on every source-bound RPC.
    await ensurePluginActivated(PROJECT_ID, GITHUB_PLUGIN);
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
