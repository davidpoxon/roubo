import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { PluginRecord } from "@roubo/shared";

vi.mock("../services/plugin-manager.js", () => ({
  HOST_API_VERSION: "1.0.0",
  listInstalled: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  restart: vi.fn(),
  readLogs: vi.fn(),
  uninstall: vi.fn(),
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
    expect(res.body.hostApiVersion).toBe("1.0.0");
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
