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
} from "./plugin-activation.js";
import * as projectRegistry from "./project-registry.js";
import { loadOverride } from "./integration-overrides.js";
import * as pluginManager from "./plugin-manager.js";

const PROJECT_ID = "proj-1";
const PLUGIN_ID = "github-com";

function mockProjectWithSources(sources: Record<string, string[]> | undefined): void {
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    config: {
      integration: sources ? { plugin: PLUGIN_ID, sources } : { plugin: PLUGIN_ID },
    },
  } as never);
  vi.mocked(loadOverride).mockReturnValue(null);
}

describe("ensurePluginActivated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActivationCache();
  });

  it("pushes translated sources to the plugin via setActiveConfig", async () => {
    mockProjectWithSources({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);

    expect(pluginManager.invoke).toHaveBeenCalledWith(
      PLUGIN_ID,
      "setActiveConfig",
      { config: { sources: [{ kind: "repo", externalId: "foo/bar" }] } },
      { timeoutMs: 5_000 },
    );
  });

  it("skips the round-trip when called twice with the same config", async () => {
    mockProjectWithSources({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);
    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);

    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);
  });

  it("re-pushes after forgetProjectActivation invalidates the cache", async () => {
    mockProjectWithSources({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);
    forgetProjectActivation(PROJECT_ID);
    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);

    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
  });

  it("re-pushes when the project's sources change between calls", async () => {
    mockProjectWithSources({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });
    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);

    mockProjectWithSources({ Repository: ["foo/bar", "foo/baz"] });
    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);

    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
  });

  it("throws when the plugin reports activation failure and does not cache", async () => {
    mockProjectWithSources({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      ok: false,
      errors: [{ field: "sources", message: "sources must be an array" }],
    });

    await expect(ensurePluginActivated(PROJECT_ID, PLUGIN_ID)).rejects.toThrow(
      /sources: sources must be an array/,
    );

    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });
    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);
    // Second call must have actually invoked, proving the failure was not cached.
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when the project is unknown (route handler will 503)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);

    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("forgetPluginActivation clears every cached project for that plugin", async () => {
    mockProjectWithSources({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated("proj-a", PLUGIN_ID);
    await ensurePluginActivated("proj-b", PLUGIN_ID);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);

    // Cached: re-calling without invalidation must not re-push.
    await ensurePluginActivated("proj-a", PLUGIN_ID);
    await ensurePluginActivated("proj-b", PLUGIN_ID);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);

    forgetPluginActivation(PLUGIN_ID);

    await ensurePluginActivated("proj-a", PLUGIN_ID);
    await ensurePluginActivated("proj-b", PLUGIN_ID);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(4);
  });

  it("forgetPluginActivation leaves other plugins' cache entries untouched", async () => {
    mockProjectWithSources({ Repository: ["foo/bar"] });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, "github-com");
    await ensurePluginActivated(PROJECT_ID, "ghe");
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);

    forgetPluginActivation("github-com");

    // github-com should re-push; ghe should stay cached.
    await ensurePluginActivated(PROJECT_ID, "github-com");
    await ensurePluginActivated(PROJECT_ID, "ghe");
    expect(pluginManager.invoke).toHaveBeenCalledTimes(3);
  });

  it("includes instance and advanced fields when present", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        integration: {
          plugin: PLUGIN_ID,
          instance: "https://ghe.example.com",
          sources: { Repository: ["foo/bar"] },
          advanced: { allowSelfSignedTls: true },
        },
      },
    } as never);
    vi.mocked(loadOverride).mockReturnValue(null);
    vi.mocked(pluginManager.invoke).mockResolvedValue({ ok: true });

    await ensurePluginActivated(PROJECT_ID, PLUGIN_ID);

    expect(pluginManager.invoke).toHaveBeenCalledWith(
      PLUGIN_ID,
      "setActiveConfig",
      {
        config: {
          sources: [{ kind: "repo", externalId: "foo/bar" }],
          instance: "https://ghe.example.com",
          allowSelfSignedTls: true,
        },
      },
      { timeoutMs: 5_000 },
    );
  });
});
