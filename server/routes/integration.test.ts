import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { IntegrationOverride, PluginRecord, RegisteredProject } from "@roubo/shared";

vi.mock("../services/project-registry.js");
vi.mock("../services/plugin-manager.js");
vi.mock("../services/credential-store.js");
vi.mock("../services/integration-overrides.js", async () => {
  const actual = await vi.importActual<typeof import("../services/integration-overrides.js")>(
    "../services/integration-overrides.js",
  );
  return {
    ...actual,
    loadOverride: vi.fn(),
    saveOverride: vi.fn(),
  };
});

import router from "./integration.js";
import * as projectRegistry from "../services/project-registry.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as credentialStore from "../services/credential-store.js";
import * as integrationOverrides from "../services/integration-overrides.js";

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

  it("returns 400 when saveOverride throws an IntegrationOverrideError", async () => {
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
      expect.objectContaining({ instance: "https://ghe.acme.com" }),
      expect.any(Object),
    );
    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      2,
      "ghe",
      "getCurrentUser",
      expect.any(Object),
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
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
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
