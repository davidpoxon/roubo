// The stage route of a gate sitting (SB-FR-025, SB-US-009): POST
// /testbench/cases/:caseId/stage reads the case's state recipe from the pin
// checkout, guards it against the pin commit, and replays it there. The pin
// checkout is a real folder and the steps run for real; only the project, the
// bench and the focused spec's slug are faked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import {
  STATE_RECIPE_SCHEMA_ID,
  STATE_RECIPE_SCHEMA_VERSION,
  type StateRecipe,
} from "@roubo/shared/state-recipe-contract";

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../services/bench-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../services/bench-manager.js")>(
    "../services/bench-manager.js",
  );
  return { BenchError: actual.BenchError, getBench: vi.fn() };
});

vi.mock("../lib/testbench-spec-discovery.js", () => ({
  discoverSpecs: vi.fn(),
  validateManualPath: vi.fn(),
  resolveFocusedSpec: vi.fn(),
  computeLifecycle: vi.fn(),
}));

import router from "./testbench.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as discovery from "../lib/testbench-spec-discovery.js";

const app = express();
app.use(express.json());
app.use("/", router);

const SLUG = "fixture-spec";
const CASE_ID = "FX-TC-001";
const PIN_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const STAGE = `/demo/benches/1/testbench/cases/${CASE_ID}/stage`;

let tmp: string;
let pin: string;
let bench: Bench;

function recipe(overrides: Partial<StateRecipe> = {}): StateRecipe {
  return {
    $schema: STATE_RECIPE_SCHEMA_ID,
    schemaVersion: STATE_RECIPE_SCHEMA_VERSION,
    caseId: CASE_ID,
    unitId: "FX-UNIT-B",
    commit: PIN_COMMIT,
    requires: [],
    steps: [
      { kind: "command", command: "printf staged > state.txt" },
      { kind: "copy-file", from: "state.txt", to: "seed/state-copy.txt" },
      { kind: "open-url", url: "http://localhost:5173/benches/1" },
    ],
    observation: { description: "The banner reads staged", url: "http://localhost:5173/" },
    ...overrides,
  };
}

function writeRecipe(content: unknown): void {
  const dir = path.join(pin, ".specifications", SLUG, "state-recipes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${CASE_ID}.json`), JSON.stringify(content, null, 2));
}

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-stage-")));
  pin = path.join(tmp, "bench-1-pin");
  fs.mkdirSync(pin, { recursive: true });
  bench = {
    id: 1,
    projectId: "demo",
    variant: "testbench",
    focusedSpecPath: `/repo/.specifications/${SLUG}/test-cases.json`,
    workspacePath: path.join(tmp, "bench-1"),
    gatePin: {
      gateId: "gate-after-b",
      workspacePath: pin,
      commit: PIN_COMMIT,
      createdAt: "2026-10-16T09:00:00Z",
    },
  } as unknown as Bench;
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    repoPath: "/repo",
    config: {},
  } as never);
  vi.mocked(benchManager.getBench).mockImplementation(() => bench);
  vi.mocked(discovery.resolveFocusedSpec).mockReturnValue({
    slug: SLUG,
    resolvedPath: `/repo/.specifications/${SLUG}/test-cases.json`,
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("POST /:projectId/benches/:id/testbench/cases/:caseId/stage", () => {
  it("SB-TC-062 stages a case with a state recipe: 200 with the step report after replaying it in the pin checkout", async () => {
    writeRecipe(recipe());
    const res = await request(app).post(STAGE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      caseId: CASE_ID,
      unitId: "FX-UNIT-B",
      commit: PIN_COMMIT,
      observation: { description: "The banner reads staged" },
      steps: [
        { index: 0, kind: "command", status: "passed" },
        { index: 1, kind: "copy-file", status: "passed" },
        {
          index: 2,
          kind: "open-url",
          status: "passed",
          url: "http://localhost:5173/benches/1",
        },
      ],
    });
    // The staged state is in the pinned checkout.
    expect(fs.readFileSync(path.join(pin, "state.txt"), "utf8")).toBe("staged");
    expect(fs.readFileSync(path.join(pin, "seed", "state-copy.txt"), "utf8")).toBe("staged");
  });

  it("SB-TC-062 accepts a recipe whose commit abbreviates the pin commit", async () => {
    writeRecipe(recipe({ commit: PIN_COMMIT.slice(0, 7) }));
    const res = await request(app).post(STAGE);
    expect(res.status).toBe(200);
  });

  it("SB-TC-062 a case without a recipe opens cold: 404 RECIPE_NOT_FOUND", async () => {
    const res = await request(app).post(STAGE);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("RECIPE_NOT_FOUND");
    expect(res.body.error).toContain("opens cold");
  });

  it("SB-TC-062 a recipe recorded at another commit is refused with 409 naming the pin commit", async () => {
    writeRecipe(recipe({ commit: OTHER_COMMIT }));
    const res = await request(app).post(STAGE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RECIPE_COMMIT_MISMATCH");
    expect(res.body.pinCommit).toBe(PIN_COMMIT);
    expect(res.body.error).toContain(PIN_COMMIT);
    // Nothing ran.
    expect(fs.existsSync(path.join(pin, "state.txt"))).toBe(false);
  });

  it("SB-TC-062 a failing step answers 422 with the step report and skips the steps after it", async () => {
    writeRecipe(
      recipe({
        steps: [
          { kind: "command", command: "printf staged > state.txt" },
          { kind: "command", command: "echo seed failed >&2; exit 3" },
          { kind: "open-url", url: "http://localhost:5173/benches/1" },
        ],
      }),
    );
    const res = await request(app).post(STAGE);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("RECIPE_STEP_FAILED");
    expect(res.body.caseId).toBe(CASE_ID);
    expect(res.body.steps).toEqual([
      expect.objectContaining({ index: 0, kind: "command", status: "passed" }),
      expect.objectContaining({ index: 1, kind: "command", status: "failed" }),
      { index: 2, kind: "open-url", status: "skipped" },
    ]);
    expect(res.body.steps[1].detail).toContain("exited 3, expected 0: seed failed");
  });

  it("answers 409 NO_GATE_PIN when the bench has no gate pin to replay in", async () => {
    bench = { ...bench, gatePin: undefined } as Bench;
    const res = await request(app).post(STAGE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_GATE_PIN");
  });

  it("answers 400 RECIPE_INVALID with the field errors for a recipe of an unknown step kind", async () => {
    writeRecipe({ ...recipe(), steps: [{ kind: "launch-rocket" }] });
    const res = await request(app).post(STAGE);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RECIPE_INVALID");
    expect(res.body.errors.join("\n")).toContain("steps.0.kind");
  });

  it("answers 400 for a case id that would leave the recipe folder", async () => {
    const res = await request(app).post("/demo/benches/1/testbench/cases/..%2F..%2Fx/stage");
    expect(res.status).toBe(400);
  });

  it("answers 404 for a bench that does not exist", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);
    const res = await request(app).post(STAGE);
    expect(res.status).toBe(404);
    expect(res.body.code).toBeUndefined();
  });
});
