import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntegrationConfig, PluginRecord } from "@roubo/shared";

vi.mock("./plugin-manager.js", () => ({
  invoke: vi.fn(),
}));
vi.mock("./credential-store.js", () => ({
  set: vi.fn(),
  get: vi.fn(),
}));

import { runIntegrationTest, classifyError, errorMessage } from "./integration-test.js";
import * as pluginManager from "./plugin-manager.js";

beforeEach(() => {
  vi.resetAllMocks();
});

function makeRecord(id: string): PluginRecord {
  return {
    id,
    source: { kind: "bundled" } as never,
    status: "enabled",
    manifest: null,
    error: null,
  } as never;
}

function makeEffective(
  sources: IntegrationConfig["sources"] | undefined,
  plugin = "github-com",
): IntegrationConfig {
  return { plugin, ...(sources !== undefined ? { sources } : {}) } as IntegrationConfig;
}

describe("runIntegrationTest", () => {
  it("invokes validateConfig with { config } wrapper (regression: plugin's params.config was undefined)", async () => {
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined) // validateConfig
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octocat" });

    const config = { instance: "https://github.example.com", sources: [] };
    const result = await runIntegrationTest(makeRecord("github-com"), config);

    expect(result).toEqual({
      ok: true,
      identity: { externalId: "u-1", displayName: "Octocat" },
      categories: [{ category: "issues", label: "Issues", status: "ok" }],
    });

    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      1,
      "github-com",
      "validateConfig",
      { config },
      { timeoutMs: 15_000 },
    );
  });

  it("invokes getCurrentUser with no params (SDK contract: () => CurrentUser)", async () => {
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octocat" });

    await runIntegrationTest(makeRecord("github-com"), { instance: "x" });

    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      2,
      "github-com",
      "getCurrentUser",
      {},
      { timeoutMs: 15_000 },
    );
  });

  it("propagates validateConfig rejections and classifies them", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(new Error("401 Unauthorized"));
    const result = await runIntegrationTest(makeRecord("github-com"), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("auth");
      expect(result.error.message).toMatch(/401/);
    }
  });

  it("surfaces a validateConfig { ok: false } result instead of masking it with getCurrentUser (GHE TLS regression)", async () => {
    // A stateful plugin (GHE) resolves { ok: false } and rolls its active
    // config back to null on a failed probe. The host must report that real
    // error (here a self-signed-cert TLS failure, so the dialog can offer the
    // opt-in) rather than blindly calling getCurrentUser, which would throw a
    // misleading "No active configuration" error classified as "other".
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      ok: false,
      errors: [{ message: "self-signed certificate in certificate chain" }],
    });

    const result = await runIntegrationTest(makeRecord("ghe"), {
      instance: "https://ghe.example.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("tls");
      expect(result.error.message).toMatch(/self-signed certificate/);
    }
    // getCurrentUser must not run once validation has failed.
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);
    expect(pluginManager.invoke).toHaveBeenCalledWith(
      "ghe",
      "validateConfig",
      { config: { instance: "https://ghe.example.com" } },
      { timeoutMs: 15_000 },
    );
  });

  it("prefixes the field name when validateConfig reports a field error", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      ok: false,
      errors: [{ field: "instance", message: "instance must be a non-empty string" }],
    });

    const result = await runIntegrationTest(makeRecord("ghe"), {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("instance: instance must be a non-empty string");
    }
  });

  it("returns a structured error when getCurrentUser returns an invalid shape", async () => {
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ wrong: "shape" });

    const result = await runIntegrationTest(makeRecord("github-com"), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("other");
      expect(result.error.message).toMatch(/invalid getCurrentUser/);
    }
  });

  describe("per-category result strip (WU-041, FR-047)", () => {
    it("emits an Issues-only strip at global scope (no ctx): Issues always renders, no probes", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" });

      const result = await runIntegrationTest(makeRecord("github-com"), {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.categories).toEqual([{ category: "issues", label: "Issues", status: "ok" }]);
      }
      // validateConfig + getCurrentUser only; no probe.
      expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
    });

    it("returns just the Issues row when ctx has no saved sources", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" });

      const result = await runIntegrationTest(
        makeRecord("github-com"),
        {},
        {
          effective: makeEffective(undefined),
        },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.categories).toEqual([{ category: "issues", label: "Issues", status: "ok" }]);
      }
      // validateConfig + getCurrentUser only; no probe.
      expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
    });

    it("does not probe for non-GitHub-family plugins", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Jane" });

      const result = await runIntegrationTest(
        makeRecord("jira-self-hosted"),
        {},
        {
          effective: {
            plugin: "jira-self-hosted",
            sources: { Project: ["PROJ"] },
          } as IntegrationConfig,
        },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.categories).toEqual([{ category: "issues", label: "Issues", status: "ok" }]);
      }
      expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
    });

    it("invokes probeAlertCategories with the union of enabled categories across sources", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" })
        .mockResolvedValueOnce({
          reports: [
            { category: "code-scanning", status: "ok", httpStatus: 200 },
            {
              category: "secret-scanning",
              status: "not-enabled",
              detail: "GHAS off",
              httpStatus: 404,
            },
          ],
        });

      const result = await runIntegrationTest(
        makeRecord("github-com"),
        {},
        {
          effective: makeEffective({
            Repository: [
              { externalId: "octo/widget", includeCodeQLAlerts: true },
              { externalId: "octo/sprocket", includeSecretScanningAlerts: true },
            ],
          }),
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.categories).toEqual([
          { category: "issues", label: "Issues", status: "ok" },
          {
            category: "code-scanning",
            label: "Code Scanning alerts",
            status: "ok",
            httpStatus: 200,
          },
          {
            category: "secret-scanning",
            label: "Secret Scanning alerts",
            status: "not-enabled",
            detail: "GHAS off",
            httpStatus: 404,
          },
        ]);
      }
      expect(pluginManager.invoke).toHaveBeenNthCalledWith(
        3,
        "github-com",
        "probeAlertCategories",
        expect.objectContaining({
          sources: [
            {
              kind: "repo",
              externalId: "octo/widget",
              includeCodeQLAlerts: true,
            },
            {
              kind: "repo",
              externalId: "octo/sprocket",
              includeSecretScanningAlerts: true,
            },
          ],
          enabledCategories: ["code-scanning", "secret-scanning"],
          timeoutMsPerProbe: 5000,
        }),
        expect.objectContaining({ timeoutMs: 12000 }),
      );
    });

    it("passes through a full TC-094 mix (ok + scope-aware not-enabled + ok) verbatim", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" })
        .mockResolvedValueOnce({
          reports: [
            { category: "code-scanning", status: "ok", httpStatus: 200 },
            {
              category: "secret-scanning",
              status: "not-enabled",
              detail: "requires GitHub Advanced Security on private repos.",
              httpStatus: 410,
            },
            { category: "dependabot", status: "ok", httpStatus: 200 },
          ],
        });

      const result = await runIntegrationTest(
        makeRecord("github-com"),
        {},
        {
          effective: makeEffective({
            Repository: [
              {
                externalId: "octo/widget",
                includeCodeQLAlerts: true,
                includeSecretScanningAlerts: true,
                includeDependabotAlerts: true,
              },
            ],
          }),
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.displayName).toBe("Octo");
        expect(result.categories).toEqual([
          { category: "issues", label: "Issues", status: "ok" },
          {
            category: "code-scanning",
            label: "Code Scanning alerts",
            status: "ok",
            httpStatus: 200,
          },
          {
            category: "secret-scanning",
            label: "Secret Scanning alerts",
            status: "not-enabled",
            detail: "requires GitHub Advanced Security on private repos.",
            httpStatus: 410,
          },
          { category: "dependabot", label: "Dependabot alerts", status: "ok", httpStatus: 200 },
        ]);
      }
    });

    it("surfaces a timed-out probe row without failing the overall test (TC-103, FR-047)", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" })
        .mockResolvedValueOnce({
          reports: [
            { category: "code-scanning", status: "timed-out", detail: "Timed out" },
            { category: "secret-scanning", status: "ok", httpStatus: 200 },
            { category: "dependabot", status: "ok", httpStatus: 200 },
          ],
        });

      const result = await runIntegrationTest(
        makeRecord("github-com"),
        {},
        {
          effective: makeEffective({
            Repository: [
              {
                externalId: "octo/widget",
                includeCodeQLAlerts: true,
                includeSecretScanningAlerts: true,
                includeDependabotAlerts: true,
              },
            ],
          }),
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.categories?.[1]).toEqual({
          category: "code-scanning",
          label: "Code Scanning alerts",
          status: "timed-out",
          detail: "Timed out",
        });
        expect(result.categories?.slice(2).map((c) => c.status)).toEqual(["ok", "ok"]);
      }
    });

    it("treats MethodNotFound from probeAlertCategories as no extra rows (Issues only)", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" })
        .mockRejectedValueOnce(
          Object.assign(new Error("not implemented"), { code: "MethodNotFound" }),
        );

      const result = await runIntegrationTest(
        makeRecord("github-com"),
        {},
        {
          effective: makeEffective({
            Repository: [{ externalId: "octo/widget", includeDependabotAlerts: true }],
          }),
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.categories).toEqual([{ category: "issues", label: "Issues", status: "ok" }]);
      }
    });

    it("marks every enabled category as error when the probe throws (FR-047: overall test stays ok)", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" })
        .mockRejectedValueOnce(new Error("plugin crashed"));

      const result = await runIntegrationTest(
        makeRecord("ghe"),
        {},
        {
          effective: makeEffective(
            { Repository: [{ externalId: "octo/widget", includeCodeQLAlerts: true }] },
            "ghe",
          ),
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.categories).toEqual([
          { category: "issues", label: "Issues", status: "ok" },
          {
            category: "code-scanning",
            label: "Code Scanning alerts",
            status: "error",
            detail: "plugin crashed",
          },
        ]);
      }
    });

    it("marks a missing report from the plugin as error", async () => {
      vi.mocked(pluginManager.invoke)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" })
        .mockResolvedValueOnce({
          reports: [{ category: "code-scanning", status: "ok", httpStatus: 200 }],
        });

      const result = await runIntegrationTest(
        makeRecord("github-com"),
        {},
        {
          effective: makeEffective({
            Repository: [
              {
                externalId: "octo/widget",
                includeCodeQLAlerts: true,
                includeDependabotAlerts: true,
              },
            ],
          }),
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.categories?.[2]).toEqual({
          category: "dependabot",
          label: "Dependabot alerts",
          status: "error",
          detail: "Plugin did not report this category.",
        });
      }
    });
  });
});

describe("classifyError", () => {
  it("classifies TLS, network, auth, other", () => {
    expect(classifyError("self signed certificate")).toBe("tls");
    expect(classifyError("getaddrinfo ENOTFOUND")).toBe("network");
    expect(classifyError("401 Unauthorized")).toBe("auth");
    expect(classifyError("something else")).toBe("other");
  });

  it("classifies the flattened undici cause message as tls, not other (issue #442)", () => {
    // The message wrapInternal now produces for a self-signed-cert transport
    // failure: the bare "fetch failed" prefix plus the surfaced err.cause code
    // and message. Before the fix this was a bare "fetch failed" and fell to
    // "other", hiding the inline self-signed-TLS opt-in.
    const flattened =
      "fetch failed: DEPTH_ZERO_SELF_SIGNED_CERT: self signed certificate in certificate chain";
    expect(classifyError(flattened)).toBe("tls");
    expect(classifyError("fetch failed")).toBe("other");
  });
});

describe("errorMessage", () => {
  it("extracts message from Error, string, or unknown", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("Unknown error");
  });
});
