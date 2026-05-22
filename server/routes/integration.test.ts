import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { IntegrationOverride, PluginRecord, RegisteredProject } from "@roubo/shared";

vi.mock("../services/project-registry.js");
vi.mock("../services/plugin-manager.js");
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

  it("returns configured variant + plugin manifest name when the plugin is installed", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ plugin: "github-com" }));
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      makePlugin("github-com", "GitHub.com"),
    ]);

    const res = await request(app).get("/demo/integration");

    expect(res.status).toBe(200);
    expect(res.body.plugin).toEqual({
      id: "github-com",
      installed: true,
      status: "enabled",
      manifest: { name: "GitHub.com" },
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
