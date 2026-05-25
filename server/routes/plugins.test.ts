import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { PluginRecord } from "@roubo/shared";

vi.mock("../services/plugin-manager.js", () => ({
  HOST_API_VERSION: "1.1.0",
  listInstalled: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  restart: vi.fn(),
  readLogs: vi.fn(),
  uninstall: vi.fn(),
  invoke: vi.fn(),
  getConnectionStatus: vi.fn(),
  invalidateConnectionStatus: vi.fn(),
}));

vi.mock("../services/integration-overrides.js", async () => {
  const actual = await vi.importActual<typeof import("../services/integration-overrides.js")>(
    "../services/integration-overrides.js",
  );
  return {
    ...actual,
    loadGlobalOverride: vi.fn(),
    saveGlobalOverride: vi.fn(),
  };
});

vi.mock("../services/integration-test.js", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  persistSecretFields: vi.fn(),
  runIntegrationTest: vi.fn(),
}));

vi.mock("../services/plugin-activation.js", () => ({
  ensurePluginActivated: vi.fn().mockResolvedValue(undefined),
  forgetProjectActivation: vi.fn(),
  forgetPluginActivation: vi.fn(),
}));

vi.mock("../services/plugin-installer.js", async () => {
  class InstallError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return {
    InstallError,
    isValidStagingToken: (t: string) => TOKEN_RE.test(t),
    previewFromGitUrl: vi.fn(),
    previewFromLocalPath: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
});

import router from "./plugins.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as pluginInstaller from "../services/plugin-installer.js";
import * as integrationOverrides from "../services/integration-overrides.js";
import * as integrationTest from "../services/integration-test.js";

const app = express();
app.use(express.json());
app.use("/", router);

function record(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "github-com",
    manifest: null,
    manifestPath: "/p/github-com/roubo-plugin.yaml",
    pluginDir: "/p/github-com",
    source: "bundled",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 1234,
    ...overrides,
  };
}

describe("GET /", () => {
  it("returns hostApiVersion and installed plugins", async () => {
    const recs = [record(), record({ id: "ghe", source: "user", status: "disabled" })];
    vi.mocked(pluginManager.listInstalled).mockReturnValue(recs);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.hostApiVersion).toBe("1.1.0");
    expect(res.body.plugins).toHaveLength(2);
    expect(res.body.plugins[0].id).toBe("github-com");
  });

  it("returns empty plugin list when nothing is installed", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.plugins).toEqual([]);
  });
});

describe("POST /:id/enable", () => {
  beforeEach(() => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record()]);
    vi.mocked(pluginManager.enable).mockResolvedValue(undefined);
  });

  it("calls pluginManager.enable and returns 204", async () => {
    const res = await request(app).post("/github-com/enable");
    expect(res.status).toBe(204);
    expect(pluginManager.enable).toHaveBeenCalledWith("github-com");
  });

  it("returns 404 when plugin is unknown", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).post("/github-com/enable");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/unknown plugin/i);
  });

  it("returns 400 when id is not kebab-case", async () => {
    const res = await request(app).post("/Bad_Id/enable");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid plugin id/i);
  });

  it("returns 409 when the supervisor rejects the transition", async () => {
    vi.mocked(pluginManager.enable).mockRejectedValue(new Error("incompatible host"));
    const res = await request(app).post("/github-com/enable");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("incompatible host");
  });
});

describe("POST /:id/disable", () => {
  beforeEach(() => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record()]);
    vi.mocked(pluginManager.disable).mockResolvedValue(undefined);
  });

  it("calls pluginManager.disable and returns 204", async () => {
    const res = await request(app).post("/github-com/disable");
    expect(res.status).toBe(204);
    expect(pluginManager.disable).toHaveBeenCalledWith("github-com");
  });

  it("returns 404 when plugin is unknown", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).post("/github-com/disable");
    expect(res.status).toBe(404);
  });
});

describe("POST /:id/restart", () => {
  beforeEach(() => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record({ status: "errored" })]);
    vi.mocked(pluginManager.restart).mockResolvedValue(undefined);
  });

  it("calls pluginManager.restart and returns 204", async () => {
    const res = await request(app).post("/github-com/restart");
    expect(res.status).toBe(204);
    expect(pluginManager.restart).toHaveBeenCalledWith("github-com");
  });

  it("returns 409 when restart fails (e.g. no valid manifest)", async () => {
    vi.mocked(pluginManager.restart).mockRejectedValue(new Error("no valid manifest"));
    const res = await request(app).post("/github-com/restart");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no valid manifest/);
  });
});

describe("DELETE /:id", () => {
  beforeEach(() => {
    vi.mocked(pluginManager.uninstall).mockReset();
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record({ source: "user" })]);
    vi.mocked(pluginManager.uninstall).mockResolvedValue(undefined);
  });

  it("calls pluginManager.uninstall and returns 204", async () => {
    const res = await request(app).delete("/github-com");
    expect(res.status).toBe(204);
    expect(pluginManager.uninstall).toHaveBeenCalledWith("github-com");
  });

  it("returns 400 when id is not kebab-case", async () => {
    const res = await request(app).delete("/Bad_Id");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid plugin id/i);
    expect(pluginManager.uninstall).not.toHaveBeenCalled();
  });

  it("returns 404 when plugin is unknown", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).delete("/github-com");
    expect(res.status).toBe(404);
    expect(pluginManager.uninstall).not.toHaveBeenCalled();
  });

  it("returns 409 when the plugin is bundled (or otherwise refuses)", async () => {
    vi.mocked(pluginManager.uninstall).mockRejectedValue(
      new Error("Bundled plugins cannot be uninstalled: github-com"),
    );
    const res = await request(app).delete("/github-com");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/bundled plugins cannot be uninstalled/i);
  });

  it("returns 409 when the plugin is the active integration for a project", async () => {
    vi.mocked(pluginManager.uninstall).mockRejectedValue(
      new Error('Plugin "github-com" is the active integration for project(s): proj-a'),
    );
    const res = await request(app).delete("/github-com");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active integration for project/i);
  });
});

describe("GET /:id/logs", () => {
  beforeEach(() => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record()]);
    vi.mocked(pluginManager.readLogs).mockResolvedValue([
      { ts: "2026-05-22T00:00:00.000Z", source: "stdout", text: "hello" },
      { ts: "2026-05-22T00:00:01.000Z", source: "stderr", level: "error", text: "boom" },
    ]);
  });

  it("returns parsed log lines for current.log by default", async () => {
    const res = await request(app).get("/github-com/logs");
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0]).toMatchObject({ source: "stdout", text: "hello" });
    expect(pluginManager.readLogs).toHaveBeenCalledWith("github-com", "current", 500);
  });

  it("returns previous.log when file=previous", async () => {
    const res = await request(app).get("/github-com/logs?file=previous");
    expect(res.status).toBe(200);
    expect(pluginManager.readLogs).toHaveBeenCalledWith("github-com", "previous", 500);
  });

  it("returns 400 when file is invalid", async () => {
    const res = await request(app).get("/github-com/logs?file=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file must be/i);
  });

  it("returns 400 when lines is not a positive integer", async () => {
    const res = await request(app).get("/github-com/logs?lines=0");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lines/i);
  });

  it("returns 400 when lines exceeds the cap", async () => {
    const res = await request(app).get("/github-com/logs?lines=99999");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lines/i);
  });

  it("accepts a custom lines count within the cap", async () => {
    const res = await request(app).get("/github-com/logs?lines=10");
    expect(res.status).toBe(200);
    expect(pluginManager.readLogs).toHaveBeenCalledWith("github-com", "current", 10);
  });

  it("returns 404 when plugin is unknown", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).get("/github-com/logs");
    expect(res.status).toBe(404);
  });

  it("returns 500 when readLogs throws", async () => {
    vi.mocked(pluginManager.readLogs).mockRejectedValue(new Error("disk read failed"));
    const res = await request(app).get("/github-com/logs");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("disk read failed");
  });
});

describe("POST /install", () => {
  beforeEach(() => {
    vi.mocked(pluginInstaller.previewFromGitUrl).mockReset();
    vi.mocked(pluginInstaller.previewFromLocalPath).mockReset();
  });

  it("rejects an unknown source value", async () => {
    const res = await request(app).post("/install").send({ source: "ftp", value: "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid-input");
  });

  it("rejects an empty value", async () => {
    const res = await request(app).post("/install").send({ source: "git", value: "" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid-input");
  });

  it("dispatches to previewFromGitUrl and returns the preview", async () => {
    vi.mocked(pluginInstaller.previewFromGitUrl).mockResolvedValue({
      stagingToken: "11111111-1111-1111-1111-111111111111",
      manifest: stubManifest(),
      source: { type: "git", url: "https://github.com/x/y.git" },
    });
    const res = await request(app)
      .post("/install")
      .send({ source: "git", value: "https://github.com/x/y.git" });
    expect(res.status).toBe(200);
    expect(res.body.stagingToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.manifest.id).toBe("echo");
    expect(pluginInstaller.previewFromGitUrl).toHaveBeenCalledWith("https://github.com/x/y.git");
  });

  it("dispatches to previewFromLocalPath for source=local", async () => {
    vi.mocked(pluginInstaller.previewFromLocalPath).mockResolvedValue({
      stagingToken: "22222222-2222-2222-2222-222222222222",
      manifest: stubManifest(),
      source: { type: "local", path: "/tmp/p" },
    });
    const res = await request(app).post("/install").send({ source: "local", value: "/tmp/p" });
    expect(res.status).toBe(200);
    expect(pluginInstaller.previewFromLocalPath).toHaveBeenCalledWith("/tmp/p");
  });

  it("maps clone-failed to 400 with the message verbatim (TC-058)", async () => {
    vi.mocked(pluginInstaller.previewFromGitUrl).mockRejectedValue(
      new pluginInstaller.InstallError(
        "clone-failed",
        "Could not clone repository. git exited with code 128: Repository not found.",
      ),
    );
    const res = await request(app)
      .post("/install")
      .send({ source: "git", value: "https://github.com/missing/missing.git" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("clone-failed");
    expect(res.body.error).toMatch(/Repository not found/);
  });

  it("maps missing-manifest to 400 (TC-059)", async () => {
    vi.mocked(pluginInstaller.previewFromLocalPath).mockRejectedValue(
      new pluginInstaller.InstallError(
        "missing-manifest",
        "No roubo-plugin.yaml found in /tmp/empty",
      ),
    );
    const res = await request(app).post("/install").send({ source: "local", value: "/tmp/empty" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing-manifest");
  });

  it("maps incompatible-host to 400", async () => {
    vi.mocked(pluginInstaller.previewFromGitUrl).mockRejectedValue(
      new pluginInstaller.InstallError("incompatible-host", "host too old"),
    );
    const res = await request(app)
      .post("/install")
      .send({ source: "git", value: "https://github.com/x/y.git" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("incompatible-host");
  });

  it("maps duplicate-id to 409", async () => {
    vi.mocked(pluginInstaller.previewFromGitUrl).mockRejectedValue(
      new pluginInstaller.InstallError("duplicate-id", "already installed"),
    );
    const res = await request(app)
      .post("/install")
      .send({ source: "git", value: "https://github.com/x/y.git" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("duplicate-id");
  });
});

describe("POST /install/:token/confirm", () => {
  beforeEach(() => {
    vi.mocked(pluginInstaller.commit).mockReset();
  });

  it("rejects a token that fails the uuid shape check", async () => {
    const res = await request(app).post("/install/not-a-uuid/confirm");
    expect(res.status).toBe(400);
    expect(pluginInstaller.commit).not.toHaveBeenCalled();
  });

  it("returns 201 with the plugin record on success", async () => {
    vi.mocked(pluginInstaller.commit).mockResolvedValue(
      stubRecord({ id: "echo", status: "enabled", source: "user" }),
    );
    const res = await request(app).post("/install/11111111-1111-1111-1111-111111111111/confirm");
    expect(res.status).toBe(201);
    expect(res.body.plugin.id).toBe("echo");
    expect(res.body.plugin.status).toBe("enabled");
  });

  it("maps unknown-token to 404", async () => {
    vi.mocked(pluginInstaller.commit).mockRejectedValue(
      new pluginInstaller.InstallError("unknown-token", "no such token"),
    );
    const res = await request(app).post("/install/11111111-1111-1111-1111-111111111111/confirm");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("unknown-token");
  });
});

describe("POST /install/:token/cancel", () => {
  beforeEach(() => {
    vi.mocked(pluginInstaller.cancel).mockReset();
  });

  it("returns 204 and calls cancel", async () => {
    vi.mocked(pluginInstaller.cancel).mockResolvedValue();
    const res = await request(app).post("/install/11111111-1111-1111-1111-111111111111/cancel");
    expect(res.status).toBe(204);
    expect(pluginInstaller.cancel).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
  });

  it("rejects an invalid token shape", async () => {
    const res = await request(app).post("/install/garbage/cancel");
    expect(res.status).toBe(400);
    expect(pluginInstaller.cancel).not.toHaveBeenCalled();
  });
});

function stubManifest() {
  return {
    id: "echo",
    name: "Echo",
    version: "0.0.0",
    description: "x",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "./index.js",
    permissions: {
      network: { hosts: [] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
    },
  };
}

function stubRecord(overrides: Partial<PluginRecord>): PluginRecord {
  return {
    id: "echo",
    manifest: null,
    manifestPath: "/p/echo/roubo-plugin.yaml",
    pluginDir: "/p/echo",
    source: "user",
    status: "disabled",
    lastError: null,
    restartHistory: [],
    pid: null,
    ...overrides,
  };
}

describe("GET /:id/integration", () => {
  beforeEach(() => {
    vi.mocked(integrationOverrides.loadGlobalOverride).mockReturnValue(null);
  });

  it("returns 400 for an invalid plugin id", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).get("/INVALID/integration");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the plugin is not installed", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).get("/missing/integration");
    expect(res.status).toBe(404);
  });

  it("returns the effective config plus the plugin manifest snippet", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      record({ manifest: stubManifest(), id: "github-com" }),
    ]);
    vi.mocked(integrationOverrides.loadGlobalOverride).mockReturnValue({
      schemaVersion: 1,
      integration: { plugin: "github-com", instance: "from-global" },
    });

    const res = await request(app).get("/github-com/integration");
    expect(res.status).toBe(200);
    expect(res.body.effective).toEqual({ plugin: "github-com", instance: "from-global" });
    expect(res.body.plugin.id).toBe("github-com");
    expect(res.body.plugin.installed).toBe(true);
    expect(res.body.plugin.manifest?.name).toBe("Echo");
  });

  it("returns the bare plugin field when no global override exists yet", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      record({ manifest: stubManifest(), id: "github-com" }),
    ]);

    const res = await request(app).get("/github-com/integration");
    expect(res.status).toBe(200);
    expect(res.body.effective).toEqual({ plugin: "github-com" });
  });
});

describe("POST /:id/integration/test", () => {
  beforeEach(() => {
    vi.mocked(integrationTest.persistSecretFields).mockReset();
    vi.mocked(integrationTest.runIntegrationTest).mockReset();
  });

  it("rejects bad pluginId shape with 400", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).post("/Bad_Id/integration/test").send({ config: {} });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the plugin is not installed", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).post("/missing/integration/test").send({ config: {} });
    expect(res.status).toBe(404);
  });

  it("returns 503 plugin-not-enabled when the plugin is disabled", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      record({ id: "github-com", manifest: stubManifest(), status: "disabled" }),
    ]);
    const res = await request(app).post("/github-com/integration/test").send({ config: {} });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("plugin-not-enabled");
  });

  it("rejects an invalid body", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      record({ id: "github-com", manifest: stubManifest() }),
    ]);
    const res = await request(app).post("/github-com/integration/test").send({ wrong: "field" });
    expect(res.status).toBe(400);
  });

  it("persists secret fields, runs the integration test, and returns the result", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      record({ id: "github-com", manifest: stubManifest() }),
    ]);
    vi.mocked(integrationTest.persistSecretFields).mockResolvedValue();
    vi.mocked(integrationTest.runIntegrationTest).mockResolvedValue({
      ok: true,
      identity: { displayName: "alice", externalId: "1" },
    });

    const res = await request(app)
      .post("/github-com/integration/test")
      .send({ config: { token: "secret" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(integrationTest.persistSecretFields).toHaveBeenCalledWith(
      "github-com",
      expect.objectContaining({ id: "echo" }),
      { token: "secret" },
    );
  });

  it("returns 500 if persisting secret fields fails", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      record({ id: "github-com", manifest: stubManifest() }),
    ]);
    vi.mocked(integrationTest.persistSecretFields).mockRejectedValue(new Error("keyring down"));

    const res = await request(app).post("/github-com/integration/test").send({ config: {} });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("credential-store-failed");
  });
});

describe("PUT /:id/integration/config", () => {
  beforeEach(() => {
    vi.mocked(integrationOverrides.loadGlobalOverride).mockReturnValue(null);
    vi.mocked(integrationOverrides.saveGlobalOverride).mockReset();
    vi.mocked(pluginManager.listInstalled).mockReturnValue([
      record({ id: "github-com", manifest: stubManifest() }),
    ]);
  });

  it("rejects a body that includes `sources` (per-project only)", async () => {
    const res = await request(app)
      .put("/github-com/integration/config")
      .send({ instance: "x", sources: { repos: ["a/b"] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sources/);
    expect(integrationOverrides.saveGlobalOverride).not.toHaveBeenCalled();
  });

  it("rejects an empty/unknown body with 400", async () => {
    const res = await request(app).put("/github-com/integration/config").send({ bogus: 1 });
    expect(res.status).toBe(400);
    expect(integrationOverrides.saveGlobalOverride).not.toHaveBeenCalled();
  });

  it("saves instance + advanced + capturedUserId and stamps `plugin: id`", async () => {
    const res = await request(app)
      .put("/github-com/integration/config")
      .send({
        instance: "https://example",
        advanced: { token: "t" },
        capturedUserId: { displayName: "alice", externalId: "1" },
      });
    expect(res.status).toBe(200);
    expect(integrationOverrides.saveGlobalOverride).toHaveBeenCalledWith(
      "github-com",
      expect.objectContaining({
        schemaVersion: 1,
        integration: expect.objectContaining({
          plugin: "github-com",
          instance: "https://example",
          advanced: { token: "t" },
          capturedUserId: { displayName: "alice", externalId: "1" },
        }),
      }),
    );
  });

  it("returns 404 for an unknown plugin", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).put("/missing/integration/config").send({ instance: "x" });
    expect(res.status).toBe(404);
  });
});

describe("GET /:id/connection-status (WU-050)", () => {
  beforeEach(() => {
    vi.mocked(pluginManager.getConnectionStatus).mockReset();
    vi.mocked(pluginManager.invalidateConnectionStatus).mockReset();
    vi.mocked(integrationOverrides.loadGlobalOverride).mockReturnValue(null);
  });

  it("returns 400 for an invalid id", async () => {
    const res = await request(app).get("/Bad_Id/connection-status");
    expect(res.status).toBe(400);
    expect(pluginManager.getConnectionStatus).not.toHaveBeenCalled();
    expect(pluginManager.invalidateConnectionStatus).not.toHaveBeenCalled();
  });

  it("returns 404 when plugin is unknown", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([]);
    const res = await request(app).get("/github-com/connection-status");
    expect(res.status).toBe(404);
    expect(pluginManager.getConnectionStatus).not.toHaveBeenCalled();
  });

  it("returns { state: 'disabled' } for a disabled plugin without invoking the manager", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record({ status: "disabled" })]);
    const res = await request(app).get("/github-com/connection-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "disabled" });
    expect(pluginManager.getConnectionStatus).not.toHaveBeenCalled();
    expect(pluginManager.invalidateConnectionStatus).not.toHaveBeenCalled();
  });

  it("invalidates the cache then returns the fresh ConnectionStatus for an enabled plugin", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record({ status: "enabled" })]);
    const status = {
      state: "connected" as const,
      checkedAt: "2026-05-26T09:00:00.000Z",
    };
    vi.mocked(pluginManager.getConnectionStatus).mockResolvedValue(status);

    const res = await request(app).get("/github-com/connection-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(status);
    expect(pluginManager.invalidateConnectionStatus).toHaveBeenCalledWith("github-com");
    expect(pluginManager.getConnectionStatus).toHaveBeenCalledTimes(1);
    expect(pluginManager.getConnectionStatus).toHaveBeenCalledWith(
      "github-com",
      expect.objectContaining({ plugin: "github-com" }),
    );
    expect(
      vi.mocked(pluginManager.invalidateConnectionStatus).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(pluginManager.getConnectionStatus).mock.invocationCallOrder[0]);
  });

  it("returns the errored state surfaced by getConnectionStatus", async () => {
    vi.mocked(pluginManager.listInstalled).mockReturnValue([record({ status: "enabled" })]);
    vi.mocked(pluginManager.getConnectionStatus).mockResolvedValue({
      state: "errored",
      detail: "RPC timeout",
      checkedAt: "2026-05-26T09:00:00.000Z",
    });

    const res = await request(app).get("/github-com/connection-status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("errored");
    expect(res.body.detail).toBe("RPC timeout");
  });
});
