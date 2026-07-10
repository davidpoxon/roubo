import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { MissingPlanError } from "../lib/testbench-store.js";
import { BenchError } from "../services/bench-manager.js";

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../services/bench-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../services/bench-manager.js")>(
    "../services/bench-manager.js",
  );
  return {
    BenchError: actual.BenchError,
    getBench: vi.fn(),
    setFocusedSpecPath: vi.fn(),
  };
});

vi.mock("../lib/testbench-store.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/testbench-store.js")>(
    "../lib/testbench-store.js",
  );
  return {
    MissingPlanError: actual.MissingPlanError,
    UnsafePathError: actual.UnsafePathError,
    readPlanAndResults: vi.fn(),
    markObservation: vi.fn(),
    setStatusOverride: vi.fn(),
    appendNote: vi.fn(),
    reconcile: vi.fn(),
  };
});

vi.mock("../lib/testbench-spec-discovery.js", () => ({
  discoverSpecs: vi.fn(),
  validateManualPath: vi.fn(),
  resolveFocusedSpec: vi.fn(),
}));

vi.mock("../services/work-unit-loader.js", async () => {
  const actual = await vi.importActual<typeof import("../services/work-unit-loader.js")>(
    "../services/work-unit-loader.js",
  );
  return {
    WorkUnitsValidationError: actual.WorkUnitsValidationError,
    loadVerifyUnits: vi.fn(),
    buildWorkUnitCaseMap: vi.fn(() => new Map()),
  };
});

vi.mock("../services/gate-override-store.js", async () => {
  const actual = await vi.importActual<typeof import("../services/gate-override-store.js")>(
    "../services/gate-override-store.js",
  );
  return {
    GateOverrideStoreError: actual.GateOverrideStoreError,
    loadOverrides: vi.fn(),
  };
});

import router from "./testbench.js";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as testbenchStore from "../lib/testbench-store.js";
import * as discovery from "../lib/testbench-spec-discovery.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import * as gateOverrideStore from "../services/gate-override-store.js";
import { emptyGateOverrides } from "@roubo/shared/gate-overrides-contract";

const app = express();
app.use(express.json());
app.use("/", router);

const REPO = "/repo";
// The bench's own worktree root: the store IO roots here as of #493, so every
// store call passes WORKTREE (not REPO) as the root. The slug is still resolved
// against REPO, where the focused spec was picked.
const WORKTREE = "/worktree/bench-1";
const FOCUSED = "/repo/.specifications/testbench/test-cases.json";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    repoPath: REPO,
    config: {},
  } as never);
  vi.mocked(benchManager.getBench).mockReturnValue({
    id: 1,
    variant: "testbench",
    focusedSpecPath: FOCUSED,
    workspacePath: WORKTREE,
  } as never);
  vi.mocked(discovery.resolveFocusedSpec).mockReturnValue({
    slug: "testbench",
    resolvedPath: FOCUSED,
  });
});

describe("GET /:projectId/testbench/specs", () => {
  it("returns discovered specs and invalid specs", async () => {
    vi.mocked(discovery.discoverSpecs).mockReturnValue({
      specs: [
        {
          slug: "testbench",
          path: FOCUSED,
          caseCount: 3,
          verification: {
            classification: "needs-attention",
            statusCounts: {
              not_started: 3,
              in_progress: 0,
              passed: 0,
              failed: 0,
              blocked: 0,
            },
            resultsPresent: false,
            resultsValid: false,
            planHashMatch: false,
            recoveryReason: null,
            aggregationError: false,
          },
        },
      ],
      invalid: [
        {
          slug: "broken",
          path: "/repo/.specifications/broken/test-cases.json",
          errors: ["test-cases.json is not valid JSON"],
        },
      ],
    });
    const res = await request(app).get("/p1/testbench/specs");
    expect(res.status).toBe(200);
    expect(res.body.specs).toHaveLength(1);
    expect(res.body.invalid).toHaveLength(1);
    expect(res.body.invalid[0].slug).toBe("broken");
    expect(discovery.discoverSpecs).toHaveBeenCalledWith(REPO);
  });

  it("returns 404 for an unknown project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).get("/p1/testbench/specs");
    expect(res.status).toBe(404);
  });
});

describe("POST /:projectId/testbench/specs/validate", () => {
  it("returns 200 with the validation result on success", async () => {
    vi.mocked(discovery.validateManualPath).mockReturnValue({
      ok: true,
      slug: "testbench",
      caseCount: 2,
    });
    const res = await request(app).post("/p1/testbench/specs/validate").send({ path: FOCUSED });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, slug: "testbench", caseCount: 2 });
  });

  it("returns 400 with errors on validation failure", async () => {
    vi.mocked(discovery.validateManualPath).mockReturnValue({
      ok: false,
      errors: ["path escapes the project repository"],
    });
    const res = await request(app).post("/p1/testbench/specs/validate").send({ path: "/etc" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when path is missing from the body", async () => {
    const res = await request(app).post("/p1/testbench/specs/validate").send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /:projectId/benches/:id/testbench/plan", () => {
  it("returns the plan + results payload (fail-open)", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue({
      plan: { cases: [] } as never,
      results: null,
      stale: false,
      planHash: "abc",
      recovered: true,
    });
    const res = await request(app).get("/p1/benches/1/testbench/plan");
    expect(res.status).toBe(200);
    expect(res.body.planHash).toBe("abc");
    expect(res.body.recovered).toBe(true);
    expect(testbenchStore.readPlanAndResults).toHaveBeenCalledWith(WORKTREE, "testbench");
  });

  it("returns 400 for a non-numeric bench id", async () => {
    const res = await request(app).get("/p1/benches/abc/testbench/plan");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the bench is missing", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);
    const res = await request(app).get("/p1/benches/1/testbench/plan");
    expect(res.status).toBe(404);
  });

  it("returns 400 when the bench is not a testbench", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({ id: 1 } as never);
    const res = await request(app).get("/p1/benches/1/testbench/plan");
    expect(res.status).toBe(400);
  });

  // #493: an error-state bench with a blank workspacePath must fail cleanly (400),
  // never write to / read from a bogus root.
  it("returns 400 when the bench has no workspace path", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({
      id: 1,
      variant: "testbench",
      focusedSpecPath: FOCUSED,
      workspacePath: "",
    } as never);
    const res = await request(app).get("/p1/benches/1/testbench/plan");
    expect(res.status).toBe(400);
    expect(testbenchStore.readPlanAndResults).not.toHaveBeenCalled();
  });

  it("maps MissingPlanError to 404", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(() => {
      throw new MissingPlanError("no plan");
    });
    const res = await request(app).get("/p1/benches/1/testbench/plan");
    expect(res.status).toBe(404);
  });

  it("attaches RateLimit response headers (limiter is mounted)", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue({
      plan: { cases: [] } as never,
      results: null,
      stale: false,
      planHash: "abc",
      recovered: true,
    });
    const res = await request(app).get("/p1/benches/1/testbench/plan");
    expect(res.status).toBe(200);
    // express-rate-limit (draft-7) sets these headers when the limiter runs.
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("GET plan with ?gateIds= subset filter (FR-008, AC2)", () => {
  const fullPlan = {
    plan: {
      cases: [{ id: "TC-001" }, { id: "TC-002" }, { id: "TC-003" }, { id: "TC-004" }],
    },
    results: null,
    stale: false,
    planHash: "abc",
    recovered: false,
  };

  function gate(id: string, testCaseIds: string[]) {
    return {
      slug: "testbench",
      unit: {
        id,
        title: id,
        type: "task",
        kind: "verify",
        description: "",
        acceptance_criteria: [],
        depends_on: [],
        implements: { requirement_ids: [], user_story_ids: [], test_case_ids: testCaseIds },
      },
    };
  }

  beforeEach(() => {
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(fullPlan as never);
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      gate("WU-100", ["TC-001", "TC-002"]),
      gate("WU-200", ["TC-003"]),
    ] as never);
    // Default: no operator regroupings recorded, so effective == raw.
    vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue(emptyGateOverrides());
    vi.mocked(workUnitLoader.buildWorkUnitCaseMap).mockReturnValue(new Map());
  });

  it("returns the unchanged full plan with no marker when ?gateIds is absent", async () => {
    const res = await request(app).get("/p1/benches/1/testbench/plan");
    expect(res.status).toBe(200);
    expect(res.body.plan.cases).toHaveLength(4);
    expect(res.body.filteredToGateIds).toBeUndefined();
    expect(workUnitLoader.loadVerifyUnits).not.toHaveBeenCalled();
  });

  it("narrows the plan to the union of the named gates' test_case_ids and adds the marker", async () => {
    const res = await request(app).get("/p1/benches/1/testbench/plan?gateIds=WU-100,WU-200");
    expect(res.status).toBe(200);
    expect(res.body.plan.cases.map((c: { id: string }) => c.id)).toEqual([
      "TC-001",
      "TC-002",
      "TC-003",
    ]);
    expect(res.body.filteredToGateIds).toEqual(["WU-100", "WU-200"]);
    expect(workUnitLoader.loadVerifyUnits).toHaveBeenCalledWith(WORKTREE, "testbench");
  });

  it("filters to a single gate's cases", async () => {
    const res = await request(app).get("/p1/benches/1/testbench/plan?gateIds=WU-100");
    expect(res.status).toBe(200);
    expect(res.body.plan.cases.map((c: { id: string }) => c.id)).toEqual(["TC-001", "TC-002"]);
    expect(res.body.filteredToGateIds).toEqual(["WU-100"]);
  });

  it("treats an unknown gate id as contributing nothing", async () => {
    const res = await request(app).get("/p1/benches/1/testbench/plan?gateIds=WU-999");
    expect(res.status).toBe(200);
    expect(res.body.plan.cases).toHaveLength(0);
    expect(res.body.filteredToGateIds).toEqual(["WU-999"]);
  });

  it("400 for a present-but-invalid work-units.json in the filter path", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockImplementation(() => {
      throw new workUnitLoader.WorkUnitsValidationError("testbench", ["bad"]);
    });
    const res = await request(app).get("/p1/benches/1/testbench/plan?gateIds=WU-100");
    expect(res.status).toBe(400);
  });

  // #434: a synthetic operator-merged gate id (MERGED:...) matches no raw
  // work-unit id, so the subset filter must resolve the EFFECTIVE (override-
  // applied) gates. With a recorded merge of WU-100 + WU-200, the merged batch
  // resolves to the deduped union of both source gates' cases, not zero.
  it("resolves a synthetic merged gate id to the deduped union of its source gates' cases", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      gate("WU-100", ["TC-001", "TC-002"]),
      gate("WU-200", ["TC-002", "TC-003"]),
    ] as never);
    vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue({
      ...emptyGateOverrides(),
      ops: [{ op: "merge", gateIds: ["WU-100", "WU-200"] }],
    });
    // The synthetic id contains a "+", which a real client URL-encodes (a raw "+"
    // in a query string decodes to a space); encode it the same way here.
    const mergedId = "MERGED:WU-100+WU-200";
    const res = await request(app).get(
      `/p1/benches/1/testbench/plan?gateIds=${encodeURIComponent(mergedId)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.plan.cases.map((c: { id: string }) => c.id)).toEqual([
      "TC-001",
      "TC-002",
      "TC-003",
    ]);
    expect(res.body.filteredToGateIds).toEqual([mergedId]);
  });

  // #434: resolving effective gates loads the project's overrides document, which
  // throws GateOverrideStoreError on a corrupt / invalid persisted doc. That is a
  // bad-request-shaped misconfiguration (400), not a 500, mirroring gates.ts.
  it("400 for a corrupt/invalid persisted gate-overrides document in the filter path", async () => {
    vi.mocked(gateOverrideStore.loadOverrides).mockImplementation(() => {
      throw new gateOverrideStore.GateOverrideStoreError("corrupt overrides document", "SCHEMA", [
        "bad",
      ]);
    });
    const res = await request(app).get("/p1/benches/1/testbench/plan?gateIds=WU-100");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SCHEMA");
  });
});

describe("PUT mark observation", () => {
  const url = "/p1/benches/1/testbench/cases/TC-001/observations/O1";

  it("marks an observation and returns the CaseResult", async () => {
    vi.mocked(testbenchStore.markObservation).mockResolvedValue({
      derivedStatus: "passed",
    } as never);
    const res = await request(app).put(url).send({ result: "pass" });
    expect(res.status).toBe(200);
    expect(res.body.derivedStatus).toBe("passed");
    expect(testbenchStore.markObservation).toHaveBeenCalledWith(
      WORKTREE,
      "testbench",
      "TC-001",
      "O1",
      "pass",
    );
  });

  it("returns 400 for an invalid result value", async () => {
    const res = await request(app).put(url).send({ result: "maybe" });
    expect(res.status).toBe(400);
    expect(testbenchStore.markObservation).not.toHaveBeenCalled();
  });

  // #508: result: null clears (un-sets) the mark and passes null to the store.
  it("clears a mark when result is null", async () => {
    vi.mocked(testbenchStore.markObservation).mockResolvedValue({
      derivedStatus: "not_started",
    } as never);
    const res = await request(app).put(url).send({ result: null });
    expect(res.status).toBe(200);
    expect(res.body.derivedStatus).toBe("not_started");
    expect(testbenchStore.markObservation).toHaveBeenCalledWith(
      WORKTREE,
      "testbench",
      "TC-001",
      "O1",
      null,
    );
  });
});

describe("PUT set status override", () => {
  const url = "/p1/benches/1/testbench/cases/TC-001/status";

  it("sets an override", async () => {
    vi.mocked(testbenchStore.setStatusOverride).mockResolvedValue({
      statusOverride: { status: "blocked" },
    } as never);
    const res = await request(app).put(url).send({ override: "blocked" });
    expect(res.status).toBe(200);
    expect(testbenchStore.setStatusOverride).toHaveBeenCalledWith(
      WORKTREE,
      "testbench",
      "TC-001",
      "blocked",
    );
  });

  it("clears an override with null", async () => {
    vi.mocked(testbenchStore.setStatusOverride).mockResolvedValue({} as never);
    const res = await request(app).put(url).send({ override: null });
    expect(res.status).toBe(200);
    expect(testbenchStore.setStatusOverride).toHaveBeenCalledWith(
      WORKTREE,
      "testbench",
      "TC-001",
      null,
    );
  });

  it("returns 400 for an invalid status", async () => {
    const res = await request(app).put(url).send({ override: "nonsense" });
    expect(res.status).toBe(400);
  });
});

describe("POST append note", () => {
  const url = "/p1/benches/1/testbench/cases/TC-001/notes";

  it("appends a note and returns 201", async () => {
    vi.mocked(testbenchStore.appendNote).mockResolvedValue({
      id: "n1",
      text: "looks good",
    } as never);
    const res = await request(app).post(url).send({ text: "looks good" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("n1");
  });

  it("returns 400 on empty text", async () => {
    const res = await request(app).post(url).send({ text: "   " });
    expect(res.status).toBe(400);
    expect(testbenchStore.appendNote).not.toHaveBeenCalled();
  });

  it("returns 400 when text is missing", async () => {
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(400);
  });
});

describe("POST reconcile", () => {
  const url = "/p1/benches/1/testbench/reconcile";
  const classification = { added: ["TC-002"], unchanged: [], changed: [], removed: ["TC-099"] };

  it("returns the preview without confirm", async () => {
    vi.mocked(testbenchStore.reconcile).mockResolvedValue({ classification, applied: false });
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.classification.removed).toEqual(["TC-099"]);
    expect(testbenchStore.reconcile).toHaveBeenCalledWith(WORKTREE, "testbench", {
      confirm: undefined,
      purgeOrphans: undefined,
    });
  });

  it("applies on confirm", async () => {
    vi.mocked(testbenchStore.reconcile).mockResolvedValue({ classification, applied: true });
    const res = await request(app).post(url).send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(testbenchStore.reconcile).toHaveBeenCalledWith(WORKTREE, "testbench", {
      confirm: true,
      purgeOrphans: undefined,
    });
  });

  it("passes purgeOrphans through", async () => {
    vi.mocked(testbenchStore.reconcile).mockResolvedValue({ classification, applied: true });
    const res = await request(app).post(url).send({ confirm: true, purgeOrphans: true });
    expect(res.status).toBe(200);
    expect(testbenchStore.reconcile).toHaveBeenCalledWith(WORKTREE, "testbench", {
      confirm: true,
      purgeOrphans: true,
    });
  });

  it("returns 400 for a non-boolean confirm", async () => {
    const res = await request(app).post(url).send({ confirm: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("PUT re-point focus", () => {
  const url = "/p1/benches/1/testbench/focus";

  it("re-points and returns the updated bench", async () => {
    vi.mocked(benchManager.setFocusedSpecPath).mockReturnValue({
      id: 1,
      variant: "testbench",
      focusedSpecPath: "/repo/.specifications/other/test-cases.json",
    } as never);
    const res = await request(app)
      .put(url)
      .send({ focusedSpecPath: "/repo/.specifications/other/test-cases.json" });
    expect(res.status).toBe(200);
    expect(res.body.focusedSpecPath).toBe("/repo/.specifications/other/test-cases.json");
    expect(benchManager.setFocusedSpecPath).toHaveBeenCalledWith(
      "p1",
      1,
      "/repo/.specifications/other/test-cases.json",
    );
  });

  it("returns 400 on empty focusedSpecPath", async () => {
    const res = await request(app).put(url).send({ focusedSpecPath: "" });
    expect(res.status).toBe(400);
    expect(benchManager.setFocusedSpecPath).not.toHaveBeenCalled();
  });

  it("maps a BenchError INVALID_FOCUS to 400", async () => {
    vi.mocked(benchManager.setFocusedSpecPath).mockImplementation(() => {
      throw new BenchError("Invalid focusedSpecPath", "INVALID_FOCUS");
    });
    const res = await request(app).put(url).send({ focusedSpecPath: "/etc/passwd" });
    expect(res.status).toBe(400);
  });

  it("maps a BenchError NOT_FOUND to 404", async () => {
    vi.mocked(benchManager.setFocusedSpecPath).mockImplementation(() => {
      throw new BenchError("Bench not found", "NOT_FOUND");
    });
    const res = await request(app)
      .put(url)
      .send({ focusedSpecPath: "/repo/.specifications/other/test-cases.json" });
    expect(res.status).toBe(404);
  });
});
