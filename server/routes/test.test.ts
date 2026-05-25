import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/plugin-manager.js", () => ({
  shutdown: vi.fn().mockResolvedValue(undefined),
  initialize: vi.fn().mockResolvedValue(undefined),
  __test: {
    resetConnectionStatusCache: vi.fn(),
  },
}));

vi.mock("../services/project-registry.js", () => ({
  initialize: vi.fn(),
  __test: {
    reset: vi.fn(),
  },
}));

vi.mock("../services/migrate.js", () => ({
  __test: {
    reset: vi.fn(),
  },
}));

vi.mock("../services/github-oauth.js", () => ({
  __test: {
    reset: vi.fn(),
  },
}));

import router from "./test.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as migrate from "../services/migrate.js";
import * as githubOauth from "../services/github-oauth.js";

const app = express();
app.use(express.json());
app.use("/test", router);

const originalRouboE2E = process.env.ROUBO_E2E;

beforeAll(() => {
  delete process.env.ROUBO_E2E;
});

afterAll(() => {
  if (originalRouboE2E === undefined) {
    delete process.env.ROUBO_E2E;
  } else {
    process.env.ROUBO_E2E = originalRouboE2E;
  }
});

beforeEach(() => {
  delete process.env.ROUBO_E2E;
});

describe("POST /test/__reset", () => {
  // TC-177: production-disabled behaviour. The route must be a no-op 404
  // whenever the gate env var isn't set, so that production HTTP probes
  // can't accidentally wipe live state.
  it("returns 404 when ROUBO_E2E is unset", async () => {
    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    expect(migrate.__test.reset).not.toHaveBeenCalled();
    expect(githubOauth.__test.reset).not.toHaveBeenCalled();
    expect(pluginManager.__test.resetConnectionStatusCache).not.toHaveBeenCalled();
    expect(pluginManager.shutdown).not.toHaveBeenCalled();
    expect(projectRegistry.__test.reset).not.toHaveBeenCalled();
    expect(projectRegistry.initialize).not.toHaveBeenCalled();
    expect(pluginManager.initialize).not.toHaveBeenCalled();
  });

  it("returns 404 when ROUBO_E2E is set to a value other than '1'", async () => {
    process.env.ROUBO_E2E = "true";

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(404);
    expect(pluginManager.shutdown).not.toHaveBeenCalled();
  });

  // TC-183 (singleton side): when the gate is on, every reset hook fires in
  // the documented order. Order matters because project-registry must be
  // reloaded before plugin-manager re-initializes (plugin discovery sees the
  // new project set).
  it("returns 200 and resets all singletons when ROUBO_E2E=1", async () => {
    process.env.ROUBO_E2E = "1";

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(migrate.__test.reset).toHaveBeenCalledTimes(1);
    expect(githubOauth.__test.reset).toHaveBeenCalledTimes(1);
    expect(pluginManager.__test.resetConnectionStatusCache).toHaveBeenCalledTimes(1);
    expect(pluginManager.shutdown).toHaveBeenCalledTimes(1);
    expect(projectRegistry.__test.reset).toHaveBeenCalledTimes(1);
    expect(projectRegistry.initialize).toHaveBeenCalledTimes(1);
    expect(pluginManager.initialize).toHaveBeenCalledTimes(1);

    const order = [
      vi.mocked(migrate.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(githubOauth.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.__test.resetConnectionStatusCache).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.shutdown).mock.invocationCallOrder[0],
      vi.mocked(projectRegistry.__test.reset).mock.invocationCallOrder[0],
      vi.mocked(projectRegistry.initialize).mock.invocationCallOrder[0],
      vi.mocked(pluginManager.initialize).mock.invocationCallOrder[0],
    ];
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });

  it("returns 500 with the error message when a reset step throws", async () => {
    process.env.ROUBO_E2E = "1";
    vi.mocked(pluginManager.shutdown).mockRejectedValueOnce(new Error("boom"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).post("/test/__reset");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "boom" });
    expect(consoleSpy).toHaveBeenCalledWith("/test/__reset failed:", "boom");
  });
});
