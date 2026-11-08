// GET /:projectId/specbench/specs/:slug/summary: the units-and-gates summary
// that the Set up Spec Bench dialog shows (SB-FR-001, SB-TC-006 step 2).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

import * as projectRegistry from "../services/project-registry.js";
import router from "./specbench-specs.js";

let repo: string;
let app: express.Express;

function unit(id: string, kind?: "verify" | "e2e") {
  return {
    id,
    title: `Unit ${id}`,
    type: kind === "verify" ? "task" : "feature",
    ...(kind && { kind }),
    description: `Unit ${id}`,
    acceptance_criteria: ["It works"],
    milestone: "Phase 1",
    labels: [],
    estimate: 1,
    depends_on: [],
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: ["TC-001"] },
  };
}

function writeWorkUnits(slug: string, body: unknown): void {
  const folder = path.join(repo, ".specifications", slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "work-units.json"), JSON.stringify(body));
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specbench-specs-")));
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    id: "demo",
    repoPath: repo,
    config: {},
  } as unknown as ReturnType<typeof projectRegistry.getProject>);
  app = express();
  app.use("/api/projects", router);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("GET /:projectId/specbench/specs/:slug/summary", () => {
  it("SB-TC-006: counts the spec's delivery units and its verify gates", async () => {
    writeWorkUnits("fixture-spec", {
      $schema: "https://roubo.dev/schema/work-units/v1.0.0.json",
      schemaVersion: "1.0.0",
      specSlug: "fixture-spec",
      units: [
        unit("A"),
        unit("B"),
        unit("G1", "verify"),
        unit("C"),
        unit("G2", "verify"),
        unit("D", "e2e"),
      ],
    });
    const res = await request(app).get("/api/projects/demo/specbench/specs/fixture-spec/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "fixture-spec", units: 4, gates: 2 });
  });

  it("answers 0 units and 0 gates for a spec with no work-units.json", async () => {
    fs.mkdirSync(path.join(repo, ".specifications", "bare"), { recursive: true });
    const res = await request(app).get("/api/projects/demo/specbench/specs/bare/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "bare", units: 0, gates: 0 });
  });

  it("answers 400 for a work-units.json that does not validate", async () => {
    writeWorkUnits("broken", { units: "nope" });
    const res = await request(app).get("/api/projects/demo/specbench/specs/broken/summary");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WORK_UNITS_INVALID");
  });

  it("answers 400 for a slug outside the allowlist", async () => {
    const res = await request(app).get("/api/projects/demo/specbench/specs/..%2Fetc/summary");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SLUG");
  });

  it("answers 404 for a project that is not registered", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).get("/api/projects/nope/specbench/specs/fixture-spec/summary");
    expect(res.status).toBe(404);
  });
});
