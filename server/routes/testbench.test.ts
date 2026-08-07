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
    MissingCaseFileError: actual.MissingCaseFileError,
    CaseNotFoundError: actual.CaseNotFoundError,
    CaseLifecycleConflictError: actual.CaseLifecycleConflictError,
    readPlanAndResults: vi.fn(),
    markObservation: vi.fn(),
    setStatusOverride: vi.fn(),
    setCaseLifecycle: vi.fn(),
    appendNote: vi.fn(),
    reconcile: vi.fn(),
  };
});

vi.mock("../lib/testbench-spec-discovery.js", () => ({
  discoverSpecs: vi.fn(),
  validateManualPath: vi.fn(),
  resolveFocusedSpec: vi.fn(),
  computeLifecycle: vi.fn(),
}));

// #773: the manifest write is mocked at the module boundary so the route tests
// stay filesystem-free; the writer's own suite covers the merge-write itself.
// The two error classes are kept real, because handleError maps them by
// instanceof.
vi.mock("../lib/testbench-spec-lifecycle-write.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/testbench-spec-lifecycle-write.js")>(
    "../lib/testbench-spec-lifecycle-write.js",
  );
  return {
    ManifestUnreadableError: actual.ManifestUnreadableError,
    SpecFolderNotFoundError: actual.SpecFolderNotFoundError,
    writeSpecLifecycle: vi.fn(),
  };
});

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
import * as lifecycleWrite from "../lib/testbench-spec-lifecycle-write.js";
import { UnsafePathError } from "../lib/safe-path.js";
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
// #770 (SATCA-FR-018): the fail-open lifecycle shape the plan route attaches.
// Absence of a record is the live state, so this is what an unarchived spec reads.
const LIVE_LIFECYCLE = {
  archived: false,
  reason: null,
  supersededBy: null,
  recordError: null,
};

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
  // #770: the plan route attaches the focused spec's lifecycle; default to live.
  vi.mocked(discovery.computeLifecycle).mockReturnValue(LIVE_LIFECYCLE);
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
          lifecycle: {
            archived: false,
            reason: null,
            supersededBy: null,
            recordError: null,
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

// #773, SATCA-FR-020/FR-021/FR-028.
describe("PUT /:projectId/testbench/specs/:slug/lifecycle", () => {
  // A discovery result naming two sibling specs, so a supersession pointer has
  // somewhere real to point.
  function discoveredSlugs(slugs: string[]): void {
    vi.mocked(discovery.discoverSpecs).mockReturnValue({
      specs: slugs.map((slug) => ({
        slug,
        path: `/repo/.specifications/${slug}/test-cases.json`,
        caseCount: 1,
        verification: {
          classification: "needs-attention",
          statusCounts: { not_started: 1, in_progress: 0, passed: 0, failed: 0, blocked: 0 },
          resultsPresent: false,
          resultsValid: false,
          planHashMatch: false,
          recoveryReason: null,
          aggregationError: false,
        },
        lifecycle: { archived: false, reason: null, supersededBy: null, recordError: null },
      })),
      invalid: [],
    });
  }

  it("archives a spec against the PROJECT repoPath and returns the re-read state", async () => {
    vi.mocked(discovery.computeLifecycle).mockReturnValue({
      archived: true,
      reason: "Shipped in #212",
      supersededBy: null,
      recordError: null,
    });

    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: { archived: true, reason: "Shipped in #212" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      archived: true,
      reason: "Shipped in #212",
      supersededBy: null,
      recordError: null,
    });
    // The project repoPath, NOT a bench worktree: the picker is project-scoped.
    expect(lifecycleWrite.writeSpecLifecycle).toHaveBeenCalledWith(REPO, "testbench", {
      archived: true,
      reason: "Shipped in #212",
    });
  });

  it("clears the record when lifecycle is null (the reversal)", async () => {
    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(LIVE_LIFECYCLE);
    expect(lifecycleWrite.writeSpecLifecycle).toHaveBeenCalledWith(REPO, "testbench", null);
  });

  it("rejects a record the published schema does not accept", async () => {
    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: { archived: false } });

    expect(res.status).toBe(400);
    expect(lifecycleWrite.writeSpecLifecycle).not.toHaveBeenCalled();
  });

  it("rejects an unrecognised key inside the record", async () => {
    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: { archived: true, retired: true } });

    expect(res.status).toBe(400);
    expect(lifecycleWrite.writeSpecLifecycle).not.toHaveBeenCalled();
  });

  it("rejects a body missing the lifecycle key entirely", async () => {
    const res = await request(app).put("/p1/testbench/specs/testbench/lifecycle").send({});
    expect(res.status).toBe(400);
    expect(lifecycleWrite.writeSpecLifecycle).not.toHaveBeenCalled();
  });

  it("accepts a supersededBy naming an existing sibling spec", async () => {
    discoveredSlugs(["testbench", "successor"]);

    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: { archived: true, supersededBy: "successor" } });

    expect(res.status).toBe(200);
    expect(lifecycleWrite.writeSpecLifecycle).toHaveBeenCalledWith(REPO, "testbench", {
      archived: true,
      supersededBy: "successor",
    });
  });

  it("rejects a supersededBy that names no spec in the project (FR-028)", async () => {
    discoveredSlugs(["testbench", "successor"]);

    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: { archived: true, supersededBy: "not-a-real-spec" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not-a-real-spec");
    expect(lifecycleWrite.writeSpecLifecycle).not.toHaveBeenCalled();
  });

  it("rejects a spec superseding itself", async () => {
    discoveredSlugs(["testbench"]);

    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: { archived: true, supersededBy: "testbench" } });

    expect(res.status).toBe(400);
    expect(lifecycleWrite.writeSpecLifecycle).not.toHaveBeenCalled();
  });

  it("returns 400 for an unsafe slug", async () => {
    vi.mocked(lifecycleWrite.writeSpecLifecycle).mockImplementation(() => {
      throw new UnsafePathError("Invalid spec slug: ..");
    });

    const res = await request(app)
      .put("/p1/testbench/specs/..%2F..%2Fetc/lifecycle")
      .send({ lifecycle: { archived: true } });

    expect(res.status).toBe(400);
  });

  it("returns 404 when the spec folder does not exist", async () => {
    vi.mocked(lifecycleWrite.writeSpecLifecycle).mockImplementation(() => {
      throw new lifecycleWrite.SpecFolderNotFoundError("No spec folder");
    });

    const res = await request(app)
      .put("/p1/testbench/specs/ghost/lifecycle")
      .send({ lifecycle: { archived: true } });

    expect(res.status).toBe(404);
  });

  it("returns 409 when an existing manifest cannot be parsed", async () => {
    vi.mocked(lifecycleWrite.writeSpecLifecycle).mockImplementation(() => {
      throw new lifecycleWrite.ManifestUnreadableError("manifest.json is not valid JSON");
    });

    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: { archived: true } });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("not valid JSON");
  });

  it("returns 404 for an unknown project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app)
      .put("/p1/testbench/specs/testbench/lifecycle")
      .send({ lifecycle: { archived: true } });

    expect(res.status).toBe(404);
    expect(lifecycleWrite.writeSpecLifecycle).not.toHaveBeenCalled();
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

  // #770 (SATCA-FR-018): the response carries the focused spec's read-only
  // lifecycle state, read from the BENCH's own workspace (not the project repo
  // discovery walks), so an open panel can say the spec it shows is archived.
  describe("focused-spec lifecycle (#770)", () => {
    beforeEach(() => {
      vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue({
        plan: { cases: [] } as never,
        results: null,
        stale: false,
        planHash: "abc",
        recovered: false,
      });
    });

    it("reports a live spec, reading the bench worktree and not the project repo", async () => {
      const res = await request(app).get("/p1/benches/1/testbench/plan");
      expect(res.status).toBe(200);
      expect(res.body.lifecycle).toEqual(LIVE_LIFECYCLE);
      expect(discovery.computeLifecycle).toHaveBeenCalledWith(WORKTREE, "testbench");
    });

    it("reports an archived spec with its recorded reason", async () => {
      vi.mocked(discovery.computeLifecycle).mockReturnValue({
        archived: true,
        reason: "Shipped in #212",
        supersededBy: null,
        recordError: null,
      });
      const res = await request(app).get("/p1/benches/1/testbench/plan");
      expect(res.status).toBe(200);
      expect(res.body.lifecycle).toEqual({
        archived: true,
        reason: "Shipped in #212",
        supersededBy: null,
        recordError: null,
      });
    });

    it("carries the superseding slug when one is recorded", async () => {
      vi.mocked(discovery.computeLifecycle).mockReturnValue({
        archived: true,
        reason: null,
        supersededBy: "billing-v2",
        recordError: null,
      });
      const res = await request(app).get("/p1/benches/1/testbench/plan");
      expect(res.status).toBe(200);
      expect(res.body.lifecycle.supersededBy).toBe("billing-v2");
    });

    it("attaches the lifecycle on the ?gateIds= filtered branch too", async () => {
      vi.mocked(discovery.computeLifecycle).mockReturnValue({
        archived: true,
        reason: null,
        supersededBy: null,
        recordError: null,
      });
      vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([]);
      vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue(emptyGateOverrides());
      vi.mocked(workUnitLoader.buildWorkUnitCaseMap).mockReturnValue(new Map());
      const res = await request(app).get("/p1/benches/1/testbench/plan?gateIds=WU-100");
      expect(res.status).toBe(200);
      expect(res.body.lifecycle.archived).toBe(true);
      expect(res.body.filteredToGateIds).toEqual(["WU-100"]);
    });
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

// #772 (SATCA-FR-019/FR-021): the case lifecycle write path. The store seam is
// mocked here; the writer's own filesystem, path-safety, and conflict behaviour
// is covered in server/lib/testbench-lifecycle-write.test.ts.
describe("PUT set case lifecycle", () => {
  const url = "/p1/benches/1/testbench/cases/TC-001/lifecycle";
  const FINGERPRINT = "a".repeat(64);

  it("records a retirement and returns the updated case", async () => {
    vi.mocked(testbenchStore.setCaseLifecycle).mockReturnValue({
      case: { id: "TC-001", lifecycle: { state: "retired", reason: "gone" } },
      caseFileFingerprint: "b".repeat(64),
      schemaVersion: "1.2.0",
    } as never);
    const res = await request(app)
      .put(url)
      .set("If-Match", FINGERPRINT)
      .send({ lifecycle: { state: "retired", reason: "gone" } });

    expect(res.status).toBe(200);
    expect(res.body.case.id).toBe("TC-001");
    expect(testbenchStore.setCaseLifecycle).toHaveBeenCalledWith(
      WORKTREE,
      "testbench",
      "TC-001",
      { state: "retired", reason: "gone" },
      FINGERPRINT,
    );
  });

  it("restores a case with a null lifecycle", async () => {
    vi.mocked(testbenchStore.setCaseLifecycle).mockReturnValue({
      case: { id: "TC-001" },
      caseFileFingerprint: "b".repeat(64),
      schemaVersion: "1.2.0",
    } as never);
    const res = await request(app).put(url).set("If-Match", FINGERPRINT).send({ lifecycle: null });

    expect(res.status).toBe(200);
    expect(testbenchStore.setCaseLifecycle).toHaveBeenCalledWith(
      WORKTREE,
      "testbench",
      "TC-001",
      null,
      FINGERPRINT,
    );
  });

  it("returns 400 without an If-Match precondition", async () => {
    const res = await request(app)
      .put(url)
      .send({ lifecycle: { state: "retired", reason: "x" } });
    expect(res.status).toBe(400);
    expect(testbenchStore.setCaseLifecycle).not.toHaveBeenCalled();
  });

  it("returns 400 for a retirement with no reason", async () => {
    const res = await request(app)
      .put(url)
      .set("If-Match", FINGERPRINT)
      .send({ lifecycle: { state: "retired", reason: "" } });
    expect(res.status).toBe(400);
    expect(testbenchStore.setCaseLifecycle).not.toHaveBeenCalled();
  });

  it("returns 400 for a supersession with no replacement", async () => {
    const res = await request(app)
      .put(url)
      .set("If-Match", FINGERPRINT)
      .send({ lifecycle: { state: "superseded" } });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown lifecycle state", async () => {
    const res = await request(app)
      .put(url)
      .set("If-Match", FINGERPRINT)
      .send({ lifecycle: { state: "archived" } });
    expect(res.status).toBe(400);
  });

  it("maps an unknown case id to 404", async () => {
    vi.mocked(testbenchStore.setCaseLifecycle).mockImplementation(() => {
      throw new testbenchStore.CaseNotFoundError('Case "TC-001" is not in spec "testbench"');
    });
    const res = await request(app).put(url).set("If-Match", FINGERPRINT).send({ lifecycle: null });
    expect(res.status).toBe(404);
  });

  it("maps a missing case file to 404", async () => {
    vi.mocked(testbenchStore.setCaseLifecycle).mockImplementation(() => {
      throw new testbenchStore.MissingCaseFileError("No test-cases.json");
    });
    const res = await request(app).put(url).set("If-Match", FINGERPRINT).send({ lifecycle: null });
    expect(res.status).toBe(404);
  });

  it("maps a concurrent modification to 409 carrying the current fingerprint", async () => {
    vi.mocked(testbenchStore.setCaseLifecycle).mockImplementation(() => {
      throw new testbenchStore.CaseLifecycleConflictError(
        "test-cases.json changed on disk. Reload the spec and try again.",
        "c".repeat(64),
      );
    });
    const res = await request(app)
      .put(url)
      .set("If-Match", FINGERPRINT)
      .send({ lifecycle: { state: "retired", reason: "gone" } });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("case-file-conflict");
    expect(res.body.caseFileFingerprint).toBe("c".repeat(64));
    expect(res.body.error).toMatch(/reload/i);
  });

  it("maps an unsafe slug to 400", async () => {
    vi.mocked(testbenchStore.setCaseLifecycle).mockImplementation(() => {
      throw new testbenchStore.UnsafePathError("Invalid spec slug: ../evil");
    });
    const res = await request(app).put(url).set("If-Match", FINGERPRINT).send({ lifecycle: null });
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

// #774 (SATCA-FR-028/FR-029): the replacement picker's read-only candidate
// endpoint. It returns the requested spec's cases plus the TRANSITIVE CLOSURE of
// their pointer graph, so the client can preview a candidate pointer with the
// same shared resolver the gate uses. Rooted at the BENCH's own workspace, like
// the plan route.
describe("GET /:projectId/benches/:id/testbench/replacement-candidates", () => {
  const url = "/p1/benches/1/testbench/replacement-candidates";

  function discovered(entries: { slug: string; caseCount?: number; archived?: boolean }[]): void {
    vi.mocked(discovery.discoverSpecs).mockReturnValue({
      specs: entries.map(({ slug, caseCount = 1, archived = false }) => ({
        slug,
        path: `/worktree/bench-1/.specifications/${slug}/test-cases.json`,
        caseCount,
        verification: {
          classification: "needs-attention",
          statusCounts: {
            not_started: caseCount,
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
        lifecycle: { archived, reason: null, supersededBy: null, recordError: null },
      })),
      invalid: [],
    });
  }

  // Plans keyed by slug, in the shape readPlanAndResults returns. A slug with no
  // entry throws, which is how a spec that cannot be read is exercised.
  function plansOnDisk(plans: Record<string, { cases: unknown[] }>): void {
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation((_root, slug) => {
      const plan = plans[slug];
      if (!plan) throw new MissingPlanError(`No test-cases.json for spec "${slug}"`);
      return { plan, results: null, stale: false, planHash: "h", recovered: false } as never;
    });
  }

  const CASE = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Case ${id}`,
    area: "reconcile",
    level: 1,
    type: "functional",
    steps: [],
    ...extra,
  });

  beforeEach(() => {
    discovered([{ slug: "testbench", caseCount: 2 }, { slug: "verify-gate" }]);
    plansOnDisk({
      testbench: {
        cases: [
          CASE("TC-001"),
          CASE("TC-002", {
            lifecycle: { state: "superseded", replacement: "verify-gate:VG-TC-004" },
          }),
        ],
      },
      "verify-gate": { cases: [CASE("VG-TC-004")] },
    });
  });

  it("returns the focused spec's cases plus every spec its pointers reach", async () => {
    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body.originSlug).toBe("testbench");
    expect(res.body.slug).toBe("testbench");
    // The cross-spec pointer pulled verify-gate into the closure, so the client
    // can resolve the chain rather than reporting "target spec not supplied".
    expect(Object.keys(res.body.plans).sort()).toEqual(["testbench", "verify-gate"]);
    expect(res.body.plans.testbench.specSlug).toBe("testbench");
    // Trimmed to what a picker row needs; steps are not shipped.
    expect(res.body.plans.testbench.cases[0]).toEqual({
      id: "TC-001",
      title: "Case TC-001",
      area: "reconcile",
      level: 1,
    });
    expect(res.body.plans.testbench.cases[1].lifecycle).toEqual({
      state: "superseded",
      replacement: "verify-gate:VG-TC-004",
    });
    expect(res.body.specs).toEqual([
      { slug: "testbench", caseCount: 2, archived: false },
      { slug: "verify-gate", caseCount: 1, archived: false },
    ]);
    // Read from the BENCH's workspace, not the project repo.
    expect(discovery.discoverSpecs).toHaveBeenCalledWith(WORKTREE);
    expect(testbenchStore.readPlanAndResults).toHaveBeenCalledWith(WORKTREE, "testbench");
  });

  it("lists another spec's cases on request, keeping the origin spec supplied", async () => {
    const res = await request(app).get(`${url}?slug=verify-gate`);

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("verify-gate");
    expect(res.body.originSlug).toBe("testbench");
    // The origin spec is always in the closure: the resolution the picker
    // previews starts from a case that lives there.
    expect(Object.keys(res.body.plans).sort()).toEqual(["testbench", "verify-gate"]);
    expect(res.body.plans["verify-gate"].cases.map((c: { id: string }) => c.id)).toEqual([
      "VG-TC-004",
    ]);
  });

  it("carries an archived spec's record, and only archived specs have one", async () => {
    discovered([
      { slug: "testbench", caseCount: 2 },
      { slug: "verify-gate", archived: true },
    ]);
    vi.mocked(discovery.computeLifecycle).mockImplementation((_root, slug) =>
      slug === "verify-gate"
        ? {
            archived: true,
            reason: "folded in",
            supersededBy: "integration-plugins",
            recordError: null,
          }
        : LIVE_LIFECYCLE,
    );

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    // Absence is the live state, so testbench has no entry at all.
    expect(res.body.specLifecycles).toEqual({
      "verify-gate": {
        archived: true,
        reason: "folded in",
        supersededBy: "integration-plugins",
      },
    });
    // The archived spec's cases are still offered; it is the resolver that
    // refuses to land in it, not the loader that hides it.
    expect(res.body.plans["verify-gate"].cases).toHaveLength(1);
    expect(res.body.specs[1].archived).toBe(true);
  });

  it("404s for a slug this workspace does not have, without reading it", async () => {
    const res = await request(app).get(`${url}?slug=nope`);
    expect(res.status).toBe(404);
    expect(testbenchStore.readPlanAndResults).not.toHaveBeenCalledWith(WORKTREE, "nope");
  });

  it("refuses a traversal slug before any filesystem read", async () => {
    const res = await request(app).get(`${url}?slug=${encodeURIComponent("../../etc")}`);
    expect(res.status).toBe(404);
    expect(testbenchStore.readPlanAndResults).not.toHaveBeenCalledWith(WORKTREE, "../../etc");
  });

  it("fails open per spec: an unreadable spec in the closure is simply absent", async () => {
    plansOnDisk({
      testbench: {
        cases: [
          CASE("TC-002", {
            lifecycle: { state: "superseded", replacement: "verify-gate:VG-TC-004" },
          }),
        ],
      },
      // verify-gate deliberately omitted: its plan read throws.
    });

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.plans)).toEqual(["testbench"]);
  });

  it("404s for an unknown project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
  });
});
