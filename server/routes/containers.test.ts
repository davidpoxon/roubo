import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/docker.js");

import router from "./containers.js";
import * as dockerService from "../services/docker.js";

const app = express();
app.use(express.json());
app.use("/", router);

describe("GET /", () => {
  it("returns 200 with containers", async () => {
    const containers = [
      { name: "db-1", status: "running", project: "roubo-project-bench-1" },
      { name: "db-2", status: "stopped", project: "roubo-project-bench-2" },
    ];
    vi.mocked(dockerService.listDatabaseContainers).mockResolvedValue(containers as any);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(containers);
  });

  it("returns 500 on error", async () => {
    vi.mocked(dockerService.listDatabaseContainers).mockRejectedValue(
      new Error("Docker not available"),
    );

    const res = await request(app).get("/");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Docker not available");
  });
});
