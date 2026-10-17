import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/env.js");

import router from "./system.js";
import * as env from "../services/env.js";

const app = express();
app.use("/", router);

describe("GET /status", () => {
  it("reports a successful login-shell import", async () => {
    vi.mocked(env.getLoginShellImportStatus).mockReturnValue({ state: "ok" });

    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ loginShellImport: { state: "ok" } });
  });

  it("reports a failed login-shell import with its cause", async () => {
    vi.mocked(env.getLoginShellImportStatus).mockReturnValue({
      state: "failed",
      reason: "timeout",
      shell: "/bin/zsh",
      timeoutMs: 15_000,
      detail: "spawnSync /bin/zsh ETIMEDOUT",
    });

    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body.loginShellImport).toEqual({
      state: "failed",
      reason: "timeout",
      shell: "/bin/zsh",
      timeoutMs: 15_000,
      detail: "spawnSync /bin/zsh ETIMEDOUT",
    });
  });
});
