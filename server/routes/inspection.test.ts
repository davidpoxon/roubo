import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { ServiceError } from "../services/service-error.js";

vi.mock("../services/inspection-runner.js", () => ({
  startInspection: vi.fn(),
  getInspectionOutput: vi.fn(),
  stopInspection: vi.fn(),
}));

import router from "./inspection.js";
import * as inspectionRunner from "../services/inspection-runner.js";

const app = express();
app.use(express.json());
app.use("/", router);

describe("invalid bench id", () => {
  it("returns 400 for non-numeric bench id on POST", async () => {
    const res = await request(app).post("/project1/benches/abc/inspection").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 400 for non-numeric bench id on GET", async () => {
    const res = await request(app).get("/project1/benches/abc/inspection");
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric bench id on DELETE", async () => {
    const res = await request(app).delete("/project1/benches/abc/inspection");
    expect(res.status).toBe(400);
  });
});

describe("POST /:projectId/benches/:id/inspection", () => {
  it("starts a test run", async () => {
    const run = {
      id: "test-1",
      projectId: "project1",
      benchId: 1,
      status: "running",
      output: [],
      exitCode: null,
      startedAt: "2026-01-01",
    };
    vi.mocked(inspectionRunner.startInspection).mockReturnValue(run as any);

    const res = await request(app)
      .post("/project1/benches/1/inspection")
      .send({ filter: "my test" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("test-1");
    expect(inspectionRunner.startInspection).toHaveBeenCalledWith("project1", 1, "my test");
  });

  it("returns 409 when test already running", async () => {
    vi.mocked(inspectionRunner.startInspection).mockImplementation(() => {
      throw new ServiceError(409, "A test run is already active for this bench");
    });

    const res = await request(app).post("/project1/benches/1/inspection").send({});

    expect(res.status).toBe(409);
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(inspectionRunner.startInspection).mockImplementation(() => {
      throw new ServiceError(404, "Bench not found");
    });

    const res = await request(app).post("/project1/benches/1/inspection").send({});

    expect(res.status).toBe(404);
  });

  it("returns 400 when no testing config", async () => {
    vi.mocked(inspectionRunner.startInspection).mockImplementation(() => {
      throw new ServiceError(400, "No testing configuration for this project");
    });

    const res = await request(app).post("/project1/benches/1/inspection").send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /:projectId/benches/:id/inspection", () => {
  it("returns current test run", async () => {
    const run = {
      id: "test-1",
      status: "running",
      output: ["line 1"],
    };
    vi.mocked(inspectionRunner.getInspectionOutput).mockReturnValue({
      run: run as any,
      output: ["line 1"],
    });

    const res = await request(app).get("/project1/benches/1/inspection");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("test-1");
  });

  it("returns 404 when no test run exists", async () => {
    vi.mocked(inspectionRunner.getInspectionOutput).mockReturnValue(undefined);

    const res = await request(app).get("/project1/benches/1/inspection");
    expect(res.status).toBe(404);
  });

  it("passes since query param", async () => {
    vi.mocked(inspectionRunner.getInspectionOutput).mockReturnValue({
      run: { id: "test-1", output: ["line 2"] } as any,
      output: ["line 2"],
    });

    const res = await request(app).get("/project1/benches/1/inspection?since=1");
    expect(res.status).toBe(200);
    expect(inspectionRunner.getInspectionOutput).toHaveBeenCalledWith("project1", 1, 1);
  });
});

describe("DELETE /:projectId/benches/:id/inspection", () => {
  it("aborts a running test", async () => {
    vi.mocked(inspectionRunner.stopInspection).mockReturnValue(true);

    const res = await request(app).delete("/project1/benches/1/inspection");
    expect(res.status).toBe(204);
  });

  it("returns 404 when no active test", async () => {
    vi.mocked(inspectionRunner.stopInspection).mockReturnValue(false);

    const res = await request(app).delete("/project1/benches/1/inspection");
    expect(res.status).toBe(404);
  });
});
