import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type {
  IntegrationOverride,
  PluginRecord,
  RegisteredProject,
  SourceCandidatesResponse,
} from "@roubo/shared";

vi.mock("../services/project-registry.js");
vi.mock("../services/plugin-manager.js");
vi.mock("../services/credential-store.js");
vi.mock("../services/plugin-activation.js", () => ({
  ensurePluginActivated: vi.fn().mockResolvedValue(undefined),
  forgetProjectActivation: vi.fn(),
  forgetPluginActivation: vi.fn(),
  resolveSources: vi.fn().mockReturnValue([]),
}));
vi.mock("../services/integration-overrides.js", async () => {
  const actual = await vi.importActual<typeof import("../services/integration-overrides.js")>(
    "../services/integration-overrides.js",
  );
  return {
    ...actual,
    loadOverride: vi.fn(),
    saveOverride: vi.fn(),
    loadGlobalOverride: vi.fn(),
    saveGlobalOverride: vi.fn(),
    // The route uses getEffectiveWithGlobal, which internally calls
    // loadGlobalOverride. Mock the wrapper so route tests stay deterministic
    // without standing up filesystem fixtures for each test.
    getEffectiveWithGlobal: vi.fn((committed, projectOverride) => ({
      ...(committed ?? {}),
      ...(projectOverride?.integration ?? {}),
    })),
  };
});

vi.mock("../services/promote-integration.js", async () => {
  const actual = await vi.importActual<typeof import("../services/promote-integration.js")>(
    "../services/promote-integration.js",
  );
  return { ...actual, promoteIntegrationToCommitted: vi.fn() };
});

import router from "./integration.js";
import * as projectRegistry from "../services/project-registry.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as credentialStore from "../services/credential-store.js";
import * as integrationOverrides from "../services/integration-overrides.js";
import * as promoteIntegration from "../services/promote-integration.js";
import { PromoteIntegrationError } from "../services/promote-integration.js";

const app = express();
app.use(express.json());
app.use("/", router);

function makeProject(integration?: Record<string, unknown>): RegisteredProject {
  return {
    id: "demo",
    repoPath: "/tmp/demo",
    config: integration
      ? ({
          project: { name: "demo" },
          integration,
        } as unknown as RegisteredProject["config"])
      : ({
          project: { name: "demo" },
        } as unknown as RegisteredProject["config"]),
    configValid: true,
    settings: {
      worktreeSource: { branchFromDefault: true, pullLatest: true },
    },
  };
}

function makePlugin(
  id: string,
  name = id,
  status: PluginRecord["status"] = "enabled",
  configSchema?: Record<string, unknown>,
  defaultIntegrationConfig?: Record<string, unknown>,
): PluginRecord {
  return {
    id,
    manifest: {
      id,
      name,
      version: "1.0.0",
      description: "Test plugin",
      kind: "integration",
      roubo: "^1.0.0",
      entry: "dist/index.js",
      permissions: {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
      },
      ...(configSchema ? { configSchema } : {}),
      ...(defaultIntegrationConfig ? { defaultIntegrationConfig } : {}),
    },
    manifestPath: "/tmp/manifest.yaml",
    pluginDir: "/tmp/plugin",
    source: "bundled",
    status,
    lastError: null,
    restartHistory: [],
    pid: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
  vi.mocked(integrationOverrides.loadOverride).mockReturnValue(null);
  vi.mocked(integrationOverrides.loadGlobalOverride).mockReturnValue(null);
  vi.mocked(integrationOverrides.getEffectiveWithGlobal).mockImplementation(
    (committed, projectOverride) => ({
      ...(committed ?? {}),
      ...(projectOverride?.integration ?? {}),
    }),
  );
  vi.mocked(credentialStore.set).mockResolvedValue(undefined);
});

describe("GET /:projectId/integration", () => {
  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/missing/integration");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Project not found" });
  });

  it("returns the unconfigured variant when neither yaml nor override has an integration block", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.plugin).toBeNull();
    expect(res.body.captionKey).toBe("none");
    expect(res.body.effective).toEqual({});
    expect(res.body.committed).toBeNull();
    expect(res.body.override).toBeNull();
  });

  it("returns missing-plugin variant when the active plugin is not installed", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.plugin).toEqual({
      id: "jira-self-hosted",
      installed: false,
      status: null,
      manifest: null,
    });
    expect(res.body.captionKey).toBe("yaml-only");
  });

  it("returns configured variant + plugin manifest name, configSchema, and permissions when installed", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("github-com", "GitHub.com"),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.plugin.id).toBe("github-com");
    expect(res.body.plugin.installed).toBe(true);
    expect(res.body.plugin.status).toBe("enabled");
    expect(res.body.plugin.manifest).toMatchObject({
      name: "GitHub.com",
      permissions: {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
      },
    });
    expect(res.body.captionKey).toBe("yaml-only");
  });

  it("captionKey = override-only when only the per-user override has an integration block", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    const override: IntegrationOverride = {
      schemaVersion: 1,
      integration: { plugin: "jira-self-hosted" },
    };
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue(override);
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("jira-self-hosted", "Jira"),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.captionKey).toBe("override-only");
    expect(res.body.effective.plugin).toBe("jira-self-hosted");
    expect(res.body.committed).toBeNull();
    expect(res.body.override).toEqual({ plugin: "jira-self-hosted" });
  });

  it("exposes the plugin's defaultIntegrationConfig in the manifest snapshot (issue #435)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "jira-self-hosted" },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("jira-self-hosted", "Jira", "enabled", undefined, {
        excludedStatusCategories: ["Done"],
      }),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.plugin.manifest.defaultIntegrationConfig).toEqual({
      excludedStatusCategories: ["Done"],
    });
  });

  it("captionKey = yaml-and-override when both blocks are non-empty", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "github-com", instance: "https://github.com" }),
    );
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "jira-self-hosted" },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("jira-self-hosted", "Jira"),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.captionKey).toBe("yaml-and-override");
    expect(res.body.effective.plugin).toBe("jira-self-hosted");
  });

  it("flags integrationMismatch when committed plugin differs from the effective plugin", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "ghe", instance: "https://ghe.example" },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("ghe", "GitHub Enterprise"),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.effective.plugin).toBe("ghe");
    expect(res.body.integrationMismatch).toEqual({
      committedPlugin: "github-com",
      effectivePlugin: "ghe",
      committedInstance: null,
      effectiveInstance: "https://ghe.example",
    });
  });

  it("flags integrationMismatch when the plugin agrees but the instance differs", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "ghe", instance: "https://ghe.old.example" }),
    );
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "ghe", instance: "https://ghe.new.example" },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("ghe", "GitHub Enterprise"),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.integrationMismatch).toEqual({
      committedPlugin: "ghe",
      effectivePlugin: "ghe",
      committedInstance: "https://ghe.old.example",
      effectiveInstance: "https://ghe.new.example",
    });
  });

  it("reports no integrationMismatch when committed and effective integrations agree", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "ghe", instance: "https://ghe.example" }),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("ghe", "GitHub Enterprise"),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.integrationMismatch).toBeNull();
  });

  it("reports no integrationMismatch when the committed config has no plugin", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "ghe" },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("ghe", "GitHub Enterprise"),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.integrationMismatch).toBeNull();
  });
});

describe("POST /:projectId/integration/promote", () => {
  it("returns the rebuilt state on success", async () => {
    vi.mocked(promoteIntegration.promoteIntegrationToCommitted).mockReturnValue(undefined);
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "ghe", instance: "https://ghe.example" }),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("ghe", "GitHub Enterprise"),
    ]);

    const res = await request(app).post("/demo/integration/promote");

    expect(res.status).toBe(200);
    expect(promoteIntegration.promoteIntegrationToCommitted).toHaveBeenCalledWith("demo");
    expect(res.body.effective.plugin).toBe("ghe");
    expect(res.body.integrationMismatch).toBeNull();
  });

  it("returns 404 when promote reports the project is unknown", async () => {
    vi.mocked(promoteIntegration.promoteIntegrationToCommitted).mockImplementation(() => {
      throw new PromoteIntegrationError("Project not found", "PROJECT_NOT_FOUND");
    });

    const res = await request(app).post("/missing/integration/promote");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PROJECT_NOT_FOUND");
  });

  it("returns 400 with the code when the promoted config fails validation", async () => {
    vi.mocked(promoteIntegration.promoteIntegrationToCommitted).mockImplementation(() => {
      throw new PromoteIntegrationError("bad config", "VALIDATION");
    });

    const res = await request(app).post("/demo/integration/promote");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad config");
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 400 when the per-user override is malformed", async () => {
    vi.mocked(promoteIntegration.promoteIntegrationToCommitted).mockImplementation(() => {
      throw new integrationOverrides.IntegrationOverrideError("schema busted", "SCHEMA", [
        { path: "integration.plugin", message: "Required" },
      ]);
    });

    const res = await request(app).post("/demo/integration/promote");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SCHEMA");
    expect(res.body.fieldErrors).toEqual([{ path: "integration.plugin", message: "Required" }]);
  });
});

describe("PUT /:projectId/integration/override", () => {
  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app)
      .put("/missing/integration/override")
      .send({ plugin: "jira-self-hosted" });

    expect(res.status).toBe(404);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when the body lacks a plugin string", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).put("/demo/integration/override").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plugin/i);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when the plugin field is empty", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).put("/demo/integration/override").send({ plugin: "" });

    expect(res.status).toBe(400);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("writes the override with a fresh envelope and returns the new state", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("jira-self-hosted", "Jira"),
    ]);
    // saveOverride should make subsequent loadOverride calls reflect the new value
    vi.mocked(integrationOverrides.saveOverride).mockImplementation((_id, next) => {
      vi.mocked(integrationOverrides.loadOverride).mockReturnValue(next);
    });

    const res = await request(app)
      .put("/demo/integration/override")
      .send({ plugin: "jira-self-hosted" });

    expect(res.status).toBe(200);
    expect(integrationOverrides.saveOverride).toHaveBeenCalledWith("demo", {
      schemaVersion: 1,
      integration: { plugin: "jira-self-hosted" },
    });
    expect(res.body.effective.plugin).toBe("jira-self-hosted");
  });

  it("preserves the existing override.instance and clears stale sources", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: {
        plugin: "github-com",
        instance: "https://github.example",
        sources: { repos: ["org/a"] },
      },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("jira-self-hosted", "Jira"),
    ]);

    const res = await request(app)
      .put("/demo/integration/override")
      .send({ plugin: "jira-self-hosted" });

    expect(res.status).toBe(200);
    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.plugin).toBe("jira-self-hosted");
    expect(saved.integration.instance).toBe("https://github.example");
    expect(saved.integration.sources).toBeUndefined();
  });

  it("returns 400 when saveOverride throws an IntegrationOverrideError on plugin switch", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(integrationOverrides.saveOverride).mockImplementation(() => {
      throw new integrationOverrides.IntegrationOverrideError("schema busted", "SCHEMA", [
        { path: "integration.plugin", message: "Required" },
      ]);
    });

    const res = await request(app)
      .put("/demo/integration/override")
      .send({ plugin: "jira-self-hosted" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("schema busted");
    expect(res.body.code).toBe("SCHEMA");
    expect(res.body.fieldErrors).toEqual([{ path: "integration.plugin", message: "Required" }]);
  });
});

describe("POST /:projectId/integration/test", () => {
  function makePluginWithSchema(
    id: string,
    name = id,
    status: PluginRecord["status"] = "enabled",
  ): PluginRecord {
    return {
      id,
      manifest: {
        id,
        name,
        version: "1.0.0",
        description: "Test plugin",
        kind: "integration",
        roubo: "^1.0.0",
        entry: "dist/index.js",
        configSchema: {
          type: "object",
          properties: {
            instance: { type: "string", title: "Instance URL" },
            token: { type: "string", format: "password", title: "Personal access token" },
            allowSelfSignedTls: { type: "boolean", title: "Allow self-signed TLS" },
          },
        },
        permissions: {
          network: { hosts: [] },
          credentials: {
            slots: [{ slot: "token", scope: "read", description: "PAT used for API calls" }],
          },
          filesystem: { paths: [] },
          processes: false,
        },
      },
      manifestPath: "/tmp/manifest.yaml",
      pluginDir: "/tmp/plugin",
      source: "bundled",
      status,
      lastError: null,
      restartHistory: [],
      pid: null,
    };
  }

  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).post("/missing/integration/test").send({ config: {} });

    expect(res.status).toBe(404);
  });

  it("returns 400 when body lacks a config object", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).post("/demo/integration/test").send({});

    expect(res.status).toBe(400);
  });

  it("returns 503 when the project has no active integration plugin", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).post("/demo/integration/test").send({ config: {} });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no-active-integration");
  });

  it("returns 503 when the active plugin is not enabled", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePluginWithSchema("ghe", "GHE", "disabled"),
    ]);

    const res = await request(app).post("/demo/integration/test").send({ config: {} });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("plugin-not-enabled");
  });

  it("happy path: writes password fields to the credential store, calls validateConfig then getCurrentUser, returns ok+identity", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([makePluginWithSchema("ghe", "GHE")]);
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined) // validateConfig
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Jane Doe" }); // getCurrentUser

    const res = await request(app)
      .post("/demo/integration/test")
      .send({
        config: {
          instance: "https://ghe.acme.com",
          token: "ghp_secret_value",
          allowSelfSignedTls: false,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      identity: { externalId: "u-1", displayName: "Jane Doe" },
      categories: [{ category: "issues", label: "Issues", status: "ok" }],
    });

    // Credential persistence MUST happen before validateConfig is invoked
    // (NFR-002): the plugin reads it via host.credentials.get inside validateConfig.
    expect(credentialStore.set).toHaveBeenCalledWith("ghe", "token", "ghp_secret_value");
    const credentialSetOrder = vi.mocked(credentialStore.set).mock.invocationCallOrder[0];
    const validateConfigOrder = vi.mocked(pluginManager.invoke).mock.invocationCallOrder[0];
    expect(credentialSetOrder).toBeLessThan(validateConfigOrder);

    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      1,
      "ghe",
      "validateConfig",
      { config: expect.objectContaining({ instance: "https://ghe.acme.com" }) },
      expect.any(Object),
    );
    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      2,
      "ghe",
      "getCurrentUser",
      {},
      expect.any(Object),
    );
  });

  it("classifies a 401 message as auth failure (TC-060)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([makePluginWithSchema("ghe", "GHE")]);
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(new Error("401 Unauthorized"));

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { instance: "https://ghe.acme.com", token: "bad" } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.kind).toBe("auth");
    expect(res.body.error.message).toMatch(/401/);
  });

  it("classifies an ENOTFOUND message as a network error (TC-061)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "jira" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([makePluginWithSchema("jira", "Jira")]);
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(
      new Error("getaddrinfo ENOTFOUND jira.invalid"),
    );

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { instance: "https://jira.invalid" } });

    expect(res.body.ok).toBe(false);
    expect(res.body.error.kind).toBe("network");
    expect(res.body.error.message).toMatch(/ENOTFOUND/);
  });

  it("classifies a self-signed certificate message as a TLS error (TC-062)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "jira" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([makePluginWithSchema("jira", "Jira")]);
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(
      new Error("self-signed certificate in certificate chain"),
    );

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { instance: "https://jira.internal" } });

    expect(res.body.ok).toBe(false);
    expect(res.body.error.kind).toBe("tls");
  });

  it("falls back to kind:'other' for unrecognised plugin errors", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([makePluginWithSchema("ghe", "GHE")]);
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(new Error("kaboom"));

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { instance: "https://ghe.acme.com" } });

    expect(res.body.ok).toBe(false);
    expect(res.body.error.kind).toBe("other");
    expect(res.body.error.message).toBe("kaboom");
  });

  it("returns ok:false with kind:'other' when getCurrentUser returns an invalid shape", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([makePluginWithSchema("ghe", "GHE")]);
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ externalId: "" }); // missing displayName, empty externalId

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { instance: "https://ghe.acme.com" } });

    expect(res.body.ok).toBe(false);
    expect(res.body.error.kind).toBe("other");
  });

  it("probes per-category endpoints when sources have alert categories enabled (WU-041, FR-047)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        plugin: "github-com",
        sources: {
          Repository: [
            { externalId: "octo/widget", includeCodeQLAlerts: true, includeDependabotAlerts: true },
          ],
        },
      }),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePluginWithSchema("github-com", "GitHub"),
    ]);
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined) // validateConfig
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" }) // getCurrentUser
      .mockResolvedValueOnce({
        reports: [
          { category: "code-scanning", status: "ok", httpStatus: 200 },
          { category: "dependabot", status: "scope-missing", detail: "missing scope" },
        ],
      });

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { token: "ghp_secret" } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.categories).toEqual([
      { category: "issues", label: "Issues", status: "ok" },
      { category: "code-scanning", label: "Code Scanning alerts", status: "ok", httpStatus: 200 },
      {
        category: "dependabot",
        label: "Dependabot alerts",
        status: "scope-missing",
        detail: "missing scope",
      },
    ]);
    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      3,
      "github-com",
      "probeAlertCategories",
      {
        sources: [
          {
            kind: "repo",
            externalId: "octo/widget",
            includeCodeQLAlerts: true,
            includeDependabotAlerts: true,
          },
        ],
        enabledCategories: ["code-scanning", "dependabot"],
        timeoutMsPerProbe: 5000,
      },
      expect.objectContaining({ timeoutMs: 12000 }),
    );
  });

  it("returns Issues-only and skips the probe when no alert categories are enabled", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        plugin: "github-com",
        sources: { Repository: [{ externalId: "octo/widget" }] },
      }),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePluginWithSchema("github-com", "GitHub"),
    ]);
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" });

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { token: "ghp_secret" } });

    expect(res.body.ok).toBe(true);
    expect(res.body.categories).toEqual([{ category: "issues", label: "Issues", status: "ok" }]);
    expect(pluginManager.invoke).toHaveBeenCalledTimes(2);
  });

  it("treats MethodNotFound from probeAlertCategories as Issues-only", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        plugin: "github-com",
        sources: { Repository: [{ externalId: "octo/widget", includeCodeQLAlerts: true }] },
      }),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePluginWithSchema("github-com", "GitHub"),
    ]);
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" })
      .mockRejectedValueOnce(
        Object.assign(new Error("not implemented"), { code: "MethodNotFound" }),
      );

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { token: "ghp_secret" } });

    expect(res.body.ok).toBe(true);
    expect(res.body.categories).toEqual([{ category: "issues", label: "Issues", status: "ok" }]);
  });

  it("marks each enabled category as error when the probe throws (FR-047: overall test stays ok)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        plugin: "github-com",
        sources: {
          Repository: [
            {
              externalId: "octo/widget",
              includeCodeQLAlerts: true,
              includeSecretScanningAlerts: true,
            },
          ],
        },
      }),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePluginWithSchema("github-com", "GitHub"),
    ]);
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octo" })
      .mockRejectedValueOnce(new Error("plugin crashed"));

    const res = await request(app)
      .post("/demo/integration/test")
      .send({ config: { token: "ghp_secret" } });

    expect(res.body.ok).toBe(true);
    expect(res.body.categories).toEqual([
      { category: "issues", label: "Issues", status: "ok" },
      {
        category: "code-scanning",
        label: "Code Scanning alerts",
        status: "error",
        detail: "plugin crashed",
      },
      {
        category: "secret-scanning",
        label: "Secret Scanning alerts",
        status: "error",
        detail: "plugin crashed",
      },
    ]);
  });
});

describe("PUT /:projectId/integration/config", () => {
  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).put("/missing/integration/config").send({ instance: "x" });

    expect(res.status).toBe(404);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 409 when there is no active integration plugin yet", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    // loadOverride defaults to null

    const res = await request(app)
      .put("/demo/integration/config")
      .send({ instance: "https://ghe.acme.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no-active-integration");
  });

  it("rejects an unknown top-level key with 400", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "ghe" },
    });

    const res = await request(app)
      .put("/demo/integration/config")
      .send({ plugin: "something-else" });

    expect(res.status).toBe(400);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("merges instance + advanced + capturedUserId into the existing override (TC-038)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "ghe", sources: { repos: ["org/a"] } },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("ghe", "ghe", "enabled", {
        type: "object",
        properties: { allowSelfSignedTls: { type: "boolean" } },
      }),
    ]);
    vi.mocked(integrationOverrides.saveOverride).mockImplementation((_id, next) => {
      vi.mocked(integrationOverrides.loadOverride).mockReturnValue(next);
    });

    const res = await request(app)
      .put("/demo/integration/config")
      .send({
        instance: "https://ghe.acme.com",
        advanced: { allowSelfSignedTls: true },
        capturedUserId: { externalId: "u-1", displayName: "Jane Doe" },
      });

    expect(res.status).toBe(200);
    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration).toEqual({
      plugin: "ghe",
      sources: { repos: ["org/a"] },
      instance: "https://ghe.acme.com",
      advanced: { allowSelfSignedTls: true },
      capturedUserId: { externalId: "u-1", displayName: "Jane Doe" },
    });
  });

  it("strips stale advanced keys not in the active plugin's manifest schema before saving (issue #125)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "ghe" },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("ghe", "ghe", "enabled", {
        type: "object",
        properties: { allowSelfSignedTls: { type: "boolean" } },
      }),
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await request(app)
      .put("/demo/integration/config")
      .send({ advanced: { allowSelfSignedTls: true, legacyToggle: "x" } });

    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.advanced).toEqual({ allowSelfSignedTls: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("advanced.legacyToggle"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("source=persist-project"));
  });

  it("drops the advanced block entirely when every supplied key is stale (issue #125)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "github-com", advanced: { allowSelfSignedTls: true } },
    });
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("github-com", "github-com", "enabled", {
        type: "object",
        properties: { sources: { type: "array" } },
      }),
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await request(app)
      .put("/demo/integration/config")
      .send({ advanced: { sources: "" } });

    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.advanced).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("advanced.sources"));
  });

  it("replaces sources arrays wholesale (FR-023)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "ghe", sources: { repos: ["org/a", "org/b"] } },
    });

    await request(app)
      .put("/demo/integration/config")
      .send({ sources: { repos: ["org/c"] } });

    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.sources).toEqual({ repos: ["org/c"] });
  });

  it("persists excludedStatusCategories into the per-project override (FR-010, issue #435)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "jira-self-hosted" },
    });

    const res = await request(app)
      .put("/demo/integration/config")
      .send({ excludedStatusCategories: ["Done", "In Progress"] });

    expect(res.status).toBe(200);
    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.excludedStatusCategories).toEqual(["Done", "In Progress"]);
  });

  it("accepts an empty excludedStatusCategories array (exclude nothing)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "jira-self-hosted", excludedStatusCategories: ["Done"] },
    });

    const res = await request(app)
      .put("/demo/integration/config")
      .send({ excludedStatusCategories: [] });

    expect(res.status).toBe(200);
    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.excludedStatusCategories).toEqual([]);
  });

  it("rejects a non-string-array excludedStatusCategories with 400", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "jira-self-hosted" },
    });

    const res = await request(app)
      .put("/demo/integration/config")
      .send({ excludedStatusCategories: "Done" });

    expect(res.status).toBe(400);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when saveOverride throws an IntegrationOverrideError", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "ghe" }));
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "ghe" },
    });
    vi.mocked(integrationOverrides.saveOverride).mockImplementation(() => {
      throw new integrationOverrides.IntegrationOverrideError("bad", "SCHEMA");
    });

    const res = await request(app)
      .put("/demo/integration/config")
      .send({ instance: "https://ghe.acme.com" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SCHEMA");
  });
});

describe("GET /:projectId/integration/sources", () => {
  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/missing/integration/sources");

    expect(res.status).toBe(404);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns 409 when no active plugin is set", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).get("/demo/integration/sources");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no active/i);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns the multi-list shape produced by the active plugin", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    const fixture: SourceCandidatesResponse = {
      shape: "multi-list",
      items: [
        { externalId: "org/repo", label: "org/repo", icon: "repo" },
        { externalId: "proj-42", label: "Roadmap", icon: "project" },
      ],
    };
    vi.mocked(pluginManager.invoke).mockResolvedValue(fixture);

    const res = await request(app).get("/demo/integration/sources");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "listSourceCandidates", {
      config: expect.objectContaining({ plugin: "github-com" }),
    });
  });

  it("returns the categorized-multi-list shape produced by the active plugin", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    const fixture: SourceCandidatesResponse = {
      shape: "categorized-multi-list",
      categories: [
        { id: "boards", label: "Boards", items: [{ externalId: "b1", label: "Engineering" }] },
        { id: "epics", label: "Epics", items: [] },
      ],
    };
    vi.mocked(pluginManager.invoke).mockResolvedValue(fixture);

    const res = await request(app).get("/demo/integration/sources");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
  });

  it("returns 502 when the plugin throws", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("rate limited"));

    const res = await request(app).get("/demo/integration/sources");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/rate limited/);
  });

  it("returns 502 when the plugin returns an unknown shape", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockResolvedValue({ shape: "tree-grid", items: [] });

    const res = await request(app).get("/demo/integration/sources");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unknown shape/i);
  });

  it("returns 502 when a multi-list response is missing items", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockResolvedValue({ shape: "multi-list" });

    const res = await request(app).get("/demo/integration/sources");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/items array/i);
  });
});

describe("PUT /:projectId/integration/sources", () => {
  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app)
      .put("/missing/integration/sources")
      .send({ sources: { items: ["a"] } });

    expect(res.status).toBe(404);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when the body has no sources key", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).put("/demo/integration/sources").send({});

    expect(res.status).toBe(400);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("returns 400 when a value is not an array", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app)
      .put("/demo/integration/sources")
      .send({ sources: { items: "not-an-array" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be an array/i);
  });

  it("returns 400 when an object entry has a malformed alert flag (WU-030)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app)
      .put("/demo/integration/sources")
      .send({
        sources: {
          items: [{ externalId: "org/a", includeCodeQLAlerts: "yes" }],
        },
      });

    expect(res.status).toBe(400);
    expect(integrationOverrides.saveOverride).not.toHaveBeenCalled();
  });

  it("accepts object-form source entries with alert booleans and round-trips them (WU-030)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("github-com", "GitHub.com"),
    ]);
    vi.mocked(integrationOverrides.saveOverride).mockImplementation((_id, next) => {
      vi.mocked(integrationOverrides.loadOverride).mockReturnValue(next);
    });

    const res = await request(app)
      .put("/demo/integration/sources")
      .send({
        sources: {
          items: [
            {
              externalId: "org/a",
              includeCodeQLAlerts: true,
              includeDependabotAlerts: true,
            },
            "org/b",
          ],
        },
      });

    expect(res.status).toBe(200);
    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.sources).toEqual({
      items: [
        {
          externalId: "org/a",
          includeCodeQLAlerts: true,
          includeDependabotAlerts: true,
        },
        "org/b",
      ],
    });
  });

  it("preserves Jira project scope and per-kind modifiers on object entries (WU-003)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("jira-self-hosted", "Jira"),
    ]);
    vi.mocked(integrationOverrides.saveOverride).mockImplementation((_id, next) => {
      vi.mocked(integrationOverrides.loadOverride).mockReturnValue(next);
    });

    const res = await request(app)
      .put("/demo/integration/sources")
      .send({
        sources: {
          project: ["PLAT"],
          board: [{ externalId: "board:482", project: "PLAT", boardMode: "active-sprint" }],
          mine: [{ externalId: "mine", mineScope: "in-project", project: "PLAT" }],
        },
      });

    expect(res.status).toBe(200);
    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.sources).toEqual({
      project: ["PLAT"],
      board: [{ externalId: "board:482", project: "PLAT", boardMode: "active-sprint" }],
      mine: [{ externalId: "mine", mineScope: "in-project", project: "PLAT" }],
    });
  });

  it("writes the sources block into the override and returns the new state", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("github-com", "GitHub.com"),
    ]);
    vi.mocked(integrationOverrides.saveOverride).mockImplementation((_id, next) => {
      vi.mocked(integrationOverrides.loadOverride).mockReturnValue(next);
    });

    const res = await request(app)
      .put("/demo/integration/sources")
      .send({ sources: { items: ["org/a", "org/b"] } });

    expect(res.status).toBe(200);
    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.sources).toEqual({ items: ["org/a", "org/b"] });
    expect(res.body.effective.sources).toEqual({ items: ["org/a", "org/b"] });
  });

  it("clears the sources block when the body sends an empty object", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(integrationOverrides.loadOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "github-com", sources: { items: ["stale"] } },
    });

    const res = await request(app).put("/demo/integration/sources").send({ sources: {} });

    expect(res.status).toBe(200);
    const saved = vi.mocked(integrationOverrides.saveOverride).mock.calls[0][1];
    expect(saved.integration.sources).toBeUndefined();
    expect(saved.integration.plugin).toBe("github-com");
  });

  it("returns 400 when saveOverride throws an IntegrationOverrideError", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());
    vi.mocked(integrationOverrides.saveOverride).mockImplementation(() => {
      throw new integrationOverrides.IntegrationOverrideError("schema busted", "SCHEMA");
    });

    const res = await request(app)
      .put("/demo/integration/sources")
      .send({ sources: { items: ["x"] } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("schema busted");
    expect(res.body.code).toBe("SCHEMA");
  });
});

describe("GET /:projectId/integration/filter-facets", () => {
  function methodNotFound(method: string): Error & { code: string } {
    const err = new Error(`Method not found: ${method}`) as Error & { code: string };
    err.code = "MethodNotFound";
    return err;
  }

  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/missing/integration/filter-facets");

    expect(res.status).toBe(404);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns 409 when no active plugin is set", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).get("/demo/integration/filter-facets");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no active/i);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns the plugin's facet descriptors verbatim", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockResolvedValue([
      { id: "milestone", label: "Milestone", type: "enum-async" },
    ]);

    const res = await request(app).get("/demo/integration/filter-facets");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "milestone", label: "Milestone", type: "enum-async" }]);
    expect(pluginManager.invoke).toHaveBeenCalledWith(
      "github-com",
      "filterFacets",
      undefined,
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("returns the fixed common-facet fallback when the plugin omits filterFacets (TC-126)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockRejectedValue(methodNotFound("filterFacets"));

    const res = await request(app).get("/demo/integration/filter-facets");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "status", label: "Status", type: "enum" },
      { id: "label", label: "Label", type: "enum" },
      { id: "assignee", label: "Assignee", type: "enum" },
      { id: "type", label: "Type", type: "enum" },
    ]);
  });

  it("returns 502 when the plugin throws a non-MethodNotFound error", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("timed out"));

    const res = await request(app).get("/demo/integration/filter-facets");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/timed out/);
  });
});

describe("GET /:projectId/integration/facet-options", () => {
  function methodNotFound(method: string): Error & { code: string } {
    const err = new Error(`Method not found: ${method}`) as Error & { code: string };
    err.code = "MethodNotFound";
    return err;
  }

  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/missing/integration/facet-options?facetId=milestone");

    expect(res.status).toBe(404);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns 400 when facetId is missing", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));

    const res = await request(app).get("/demo/integration/facet-options");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/facetId/);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns 409 when no active plugin is set", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).get("/demo/integration/facet-options?facetId=milestone");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no active/i);
  });

  it("forwards facetId, resolved sources, and search to the plugin", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockResolvedValue([{ value: "v1.0", label: "v1.0" }]);

    const res = await request(app).get(
      "/demo/integration/facet-options?facetId=milestone&search=v1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ value: "v1.0", label: "v1.0" }]);
    expect(pluginManager.invoke).toHaveBeenCalledWith(
      "github-com",
      "getFacetOptions",
      { facetId: "milestone", sources: [], search: "v1" },
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("returns [] when the plugin omits getFacetOptions", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockRejectedValue(methodNotFound("getFacetOptions"));

    const res = await request(app).get("/demo/integration/facet-options?facetId=milestone");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 502 when the plugin throws a non-MethodNotFound error", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("rate limited"));

    const res = await request(app).get("/demo/integration/facet-options?facetId=milestone");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/rate limited/);
  });
});

describe("GET /:projectId/integration/source-options", () => {
  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/missing/integration/source-options?category=project");

    expect(res.status).toBe(404);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns 400 when the category is missing or unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );

    const missing = await request(app).get("/demo/integration/source-options");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/category/);

    const unknown = await request(app).get("/demo/integration/source-options?category=sprint");
    expect(unknown.status).toBe(400);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns 400 when scope is not valid JSON", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );

    const res = await request(app).get(
      "/demo/integration/source-options?category=board&scope=not-json",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scope/);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns 409 when no active plugin is set", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).get("/demo/integration/source-options?category=project");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no active/i);
  });

  it("forwards category, scope, search, and cursor to the plugin (TC-002)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [{ externalId: "board:1", label: "Alpha", icon: "board" }],
      nextCursor: "c2",
    });

    const scope = encodeURIComponent(JSON.stringify({ project: ["PLAT"] }));
    const res = await request(app).get(
      `/demo/integration/source-options?category=board&scope=${scope}&search=back&cursor=c1`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [{ externalId: "board:1", label: "Alpha", icon: "board" }],
      nextCursor: "c2",
    });
    expect(pluginManager.invoke).toHaveBeenCalledWith(
      "jira-self-hosted",
      "getSourceOptions",
      {
        category: "board",
        scope: { project: ["PLAT"] },
        search: "back",
        cursor: "c1",
        config: { plugin: "jira-self-hosted" },
      },
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it("returns 502 when the plugin throws", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("upstream down"));

    const res = await request(app).get("/demo/integration/source-options?category=project");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/upstream down/);
  });
});

describe("GET /:projectId/integration/sources (searchable-categorized shape)", () => {
  it("accepts and returns a searchable-categorized response", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      shape: "searchable-categorized",
      searchableCategories: [
        { id: "project", label: "Projects" },
        { id: "board", label: "Boards", scopedBy: "project" },
      ],
    });

    const res = await request(app).get("/demo/integration/sources");

    expect(res.status).toBe(200);
    expect(res.body.shape).toBe("searchable-categorized");
    expect(res.body.searchableCategories).toHaveLength(2);
  });

  it("rejects a searchable-categorized response missing the categories array (502)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(pluginManager.invoke).mockResolvedValue({ shape: "searchable-categorized" });

    const res = await request(app).get("/demo/integration/sources");

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/searchableCategories/);
  });
});

describe("GET /:projectId/integration/status-categories (issue #453)", () => {
  it("returns 404 when the project is unknown", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/missing/integration/status-categories");

    expect(res.status).toBe(404);
  });

  it("returns supported:false with no categories when no active plugin", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject());

    const res = await request(app).get("/demo/integration/status-categories");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: false, categories: [] });
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns supported:true with the plugin's discovered categories", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(pluginManager.invoke).mockResolvedValue(["To Do", "In Progress", "Done"]);

    const res = await request(app).get("/demo/integration/status-categories");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: true, categories: ["To Do", "In Progress", "Done"] });
    expect(pluginManager.invoke).toHaveBeenCalledWith("jira-self-hosted", "listStatusCategories", {
      config: { plugin: "jira-self-hosted" },
    });
  });

  it("falls back to supported:false when the plugin does not implement discovery", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.invoke).mockRejectedValue({ code: "MethodNotFound" });

    const res = await request(app).get("/demo/integration/status-categories");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: false, categories: [] });
  });

  it("falls back to supported:false on any plugin error", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("upstream down"));

    const res = await request(app).get("/demo/integration/status-categories");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: false, categories: [] });
  });

  it("falls back to supported:false when the override file is corrupt", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(integrationOverrides.loadOverride).mockImplementation(() => {
      throw new Error("corrupt override yaml");
    });

    const res = await request(app).get("/demo/integration/status-categories");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: false, categories: [] });
  });

  it("falls back to supported:false when the plugin returns a non-string[] payload", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ plugin: "jira-self-hosted" }),
    );
    vi.mocked(pluginManager.invoke).mockResolvedValue([{ name: "Done" }]);

    const res = await request(app).get("/demo/integration/status-categories");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: false, categories: [] });
  });
});
