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
}));

import router from "./plugins.js";
import * as pluginManager from "../services/plugin-manager.js";

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
