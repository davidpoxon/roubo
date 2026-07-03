import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../services/work-unit-loader.js", async () => {
  const actual = await vi.importActual<typeof import("../services/work-unit-loader.js")>(
    "../services/work-unit-loader.js",
  );
  const loadVerifyUnits = vi.fn();
  // By default the diagnostics variant delegates to the mocked loadVerifyUnits and
  // reports no invalid specs, so every existing test that sets loadVerifyUnits
  // drives effectiveGates unchanged. The #371 tests override this per call
  // (mockReturnValueOnce) to inject invalidSpecs without leaking to later tests.
  const loadVerifyUnitsWithDiagnostics = vi.fn((repoPath: string, slug?: string) => ({
    loaded: loadVerifyUnits(repoPath, slug),
    invalidSpecs: [],
  }));
  return {
    WorkUnitsValidationError: actual.WorkUnitsValidationError,
    loadVerifyUnits,
    loadVerifyUnitsWithDiagnostics,
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
    saveOverrides: vi.fn(),
    removeOverrides: vi.fn(),
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
    appendNote: vi.fn(async () => ({ id: "n1" })),
  };
});

vi.mock("../services/fix-issue-filer.js", async () => {
  const actual = await vi.importActual<typeof import("../services/fix-issue-filer.js")>(
    "../services/fix-issue-filer.js",
  );
  return {
    EmptyNotesError: actual.EmptyNotesError,
    fileFixIssueAndBlock: vi.fn(),
  };
});

import router from "./gates.js";
import * as projectRegistry from "../services/project-registry.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import * as gateOverrideStore from "../services/gate-override-store.js";
import { emptyGateOverrides } from "@roubo/shared/gate-overrides-contract";
import * as testbenchStore from "../lib/testbench-store.js";
import { MissingPlanError } from "../lib/testbench-store.js";
import * as fixIssueFiler from "../services/fix-issue-filer.js";
import { TrackerActionError } from "../services/tracker-action-gateway.js";
import type { LoadedVerifyUnit } from "../services/work-unit-loader.js";
import type { VerifyUnit } from "../lib/gate-evaluator.js";
import type { Case, CaseResult } from "@roubo/shared/testbench-contracts";
import type { Tracker } from "@roubo/shared/work-units-contract";

const app = express();
app.use(express.json());
app.use("/", router);

const REPO = "/repo";
const PLAN_HASH = "plan-hash-v1";

function gate(id: string, testCaseIds: string[], covers: string[] = []): VerifyUnit {
  return {
    id,
    title: `Verify ${id}`,
    type: "task",
    kind: "verify",
    description: "gate",
    acceptance_criteria: [],
    depends_on: [],
    covers,
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: testCaseIds },
  };
}

function loaded(slug: string, unit: VerifyUnit): LoadedVerifyUnit {
  return { slug, unit };
}

// A gate carrying a GitHub tracker ref, so it can be a block target for a fix
// issue (the fix-issues route derives repoFullName from the gate's tracker.ref).
function gateWithTracker(id: string, ref: string, testCaseIds: string[] = ["TC-024"]): VerifyUnit {
  const tracker: Tracker = { system: "github", ref, url: "https://x", blocked_by_refs: [] };
  return { ...gate(id, testCaseIds), tracker };
}

function planCase(id: string, level: number, type = "functional"): Case {
  return {
    id,
    title: id,
    description: "",
    level,
    type,
    steps: [],
  } as never;
}

function caseResult(derivedStatus: string): CaseResult {
  return { observationMarks: {}, derivedStatus, notes: [] } as never;
}

function planAndResults(cases: Case[], caseResults: Record<string, CaseResult> | null) {
  return {
    plan: { cases } as never,
    results: caseResults === null ? null : { caseResults, updatedAt: "2026-01-01T00:00:00.000Z" },
    stale: false,
    planHash: PLAN_HASH,
    recovered: caseResults === null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    repoPath: REPO,
    config: {},
  } as never);
  // Default: no operator overrides recorded. Individual tests override this.
  vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue(emptyGateOverrides());
  vi.mocked(workUnitLoader.buildWorkUnitCaseMap).mockReturnValue(new Map());
});

describe("GET /:projectId/gates", () => {
  it("returns a GateState per verify unit", () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-100", ["TC-001"], ["WU-001"])),
      loaded("alpha", gate("WU-200", ["TC-002"], ["WU-002"])),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-001", 1), planCase("TC-002", 1)], {
          "TC-001": caseResult("passed"),
          "TC-002": caseResult("passed"),
        }) as never,
    );

    const res = request(app).get("/p1/gates");
    return res.then((r) => {
      expect(r.status).toBe(200);
      expect(r.body.gates).toHaveLength(2);
      expect(r.body.gates[0]).toMatchObject({ gateId: "WU-100", status: "passed" });
      expect(r.body.gates[1]).toMatchObject({ gateId: "WU-200", status: "passed" });
      // All specs valid: no skipped-spec diagnostics (#371).
      expect(r.body.invalidSpecs).toEqual([]);
    });
  });

  it("returns empty gates + empty invalidSpecs when there are no gates", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([]);
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gates: [], invalidSpecs: [] });
  });

  it("404 when the project is not registered", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as never);
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(404);
  });

  // #371: a present-but-invalid work-units.json on the all-specs path is no longer
  // a 400. The load surfaces it as an `invalidSpecs` diagnostic (200) so the client
  // can warn the operator, while the valid specs' gates still load (the #328/#802
  // resilience is preserved).
  it("surfaces invalidSpecs (200, not 400) for a broken spec while valid gates still load", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnitsWithDiagnostics).mockReturnValueOnce({
      loaded: [loaded("alpha", gate("WU-100", ["TC-001"], ["WU-001"]))],
      invalidSpecs: [{ slug: "broken", errors: ['work-units.json for spec "broken" failed'] }],
    });
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-001", 1)], {
          "TC-001": caseResult("passed"),
        }) as never,
    );
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    expect(res.body.gates).toHaveLength(1);
    expect(res.body.gates[0]).toMatchObject({ gateId: "WU-100", status: "passed" });
    expect(res.body.invalidSpecs).toEqual([
      { slug: "broken", errors: ['work-units.json for spec "broken" failed'] },
    ]);
  });
});

describe("GET /:projectId/gates/:gateId", () => {
  beforeEach(() => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-100", ["TC-001", "TC-002"], ["WU-001", "WU-002"])),
    ]);
  });

  it("404 for an unknown gate id", async () => {
    const res = await request(app).get("/p1/gates/WU-999");
    expect(res.status).toBe(404);
  });

  it("a non-passed (pending) gate carries unresolvedCaseIds and coveringUnitIds", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-001", 1), planCase("TC-002", 1)], {
        "TC-001": caseResult("passed"),
        "TC-002": caseResult("not_started"),
      }) as never,
    );
    const res = await request(app).get("/p1/gates/WU-100");
    expect(res.status).toBe(200);
    expect(res.body.gateId).toBe("WU-100");
    expect(res.body.status).toBe("pending");
    expect(res.body.unresolvedCaseIds).toEqual(["TC-002"]);
    expect(res.body.coveringUnitIds).toEqual(["WU-001", "WU-002"]);
  });

  it("excludes L3/L4 cases from the gating set (AC3)", async () => {
    // TC-002 is L4: it is tracked but excluded from the gate, so even though it is
    // not_started the gate passes on the L1 case alone.
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-001", 1), planCase("TC-002", 4)], {
        "TC-001": caseResult("passed"),
        "TC-002": caseResult("not_started"),
      }) as never,
    );
    const res = await request(app).get("/p1/gates/WU-100");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("passed");
    expect(res.body.unresolvedCaseIds).toEqual([]);
  });

  it("fails closed to stale (never passed) when the spec has no plan", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(() => {
      throw new MissingPlanError("no plan");
    });
    const res = await request(app).get("/p1/gates/WU-100");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stale");
    expect(res.body.unresolvedCaseIds).toEqual(["TC-001", "TC-002"]);
    expect(res.body.coveringUnitIds).toEqual(["WU-001", "WU-002"]);
  });

  it("reads as stale when no results are recorded yet (never passed)", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-001", 1), planCase("TC-002", 1)], null) as never,
    );
    const res = await request(app).get("/p1/gates/WU-100");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stale");
  });

  it("reads as stale (never passed) when recorded results are stale (plan changed since verification)", async () => {
    // Every gating case is passed in the recorded results, but the stored plan
    // hash no longer matches the live plan, so the store flags it stale. The gate
    // must read stale, not passed: a batch verified against an out-of-date plan
    // is unverified against the current one (NFR-007 fail-closed, never a
    // false-pass). This is the regression the route's planHash handling guards.
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue({
      ...planAndResults([planCase("TC-001", 1), planCase("TC-002", 1)], {
        "TC-001": caseResult("passed"),
        "TC-002": caseResult("passed"),
      }),
      stale: true,
    } as never);
    const res = await request(app).get("/p1/gates/WU-100");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stale");
    expect(res.body.unresolvedCaseIds).toEqual(["TC-001", "TC-002"]);
  });
});

describe("rate limiting", () => {
  beforeEach(() => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([]);
  });

  it("attaches RateLimit response headers on the list route (limiter is mounted)", async () => {
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    // express-rate-limit (draft-7) sets these headers when the limiter runs.
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });

  it("attaches RateLimit response headers on the detail route (limiter is mounted)", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-100", ["TC-001"])),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-001", 1)], { "TC-001": caseResult("passed") }) as never,
    );
    const res = await request(app).get("/p1/gates/WU-100");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("POST /:projectId/gates/merge", () => {
  // Two pending gates ready to merge (TC-022 shape).
  beforeEach(() => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("PHASE-2", ["TC-019", "TC-020"], ["WU-031", "WU-032"])),
      loaded("alpha", gate("PHASE-3", ["TC-030"], ["WU-050"])),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-019", 1), planCase("TC-020", 1), planCase("TC-030", 1)], {
          "TC-019": caseResult("not_started"),
        }) as never,
    );
  });

  it("merges two pending gates and persists the op (AC1, TC-022)", async () => {
    const res = await request(app)
      .post("/p1/gates/merge")
      .send({ gateIds: ["PHASE-2", "PHASE-3"] });
    expect(res.status).toBe(200);
    expect(gateOverrideStore.saveOverrides).toHaveBeenCalledOnce();
    const saved = vi.mocked(gateOverrideStore.saveOverrides).mock.calls[0][1];
    expect(saved.ops).toEqual([{ op: "merge", gateIds: ["PHASE-2", "PHASE-3"] }]);
    // The recomputed list has one combined gate, sources gone.
    const ids = res.body.map((g: { gateId: string }) => g.gateId);
    expect(ids).not.toContain("PHASE-2");
    expect(ids).not.toContain("PHASE-3");
    expect(ids).toHaveLength(1);
  });

  it("400 when fewer than two gate ids are given", async () => {
    const res = await request(app)
      .post("/p1/gates/merge")
      .send({ gateIds: ["PHASE-2"] });
    expect(res.status).toBe(400);
    expect(gateOverrideStore.saveOverrides).not.toHaveBeenCalled();
  });

  it("400 for an unknown gate id", async () => {
    const res = await request(app)
      .post("/p1/gates/merge")
      .send({ gateIds: ["PHASE-2", "GHOST"] });
    expect(res.status).toBe(400);
    expect(gateOverrideStore.saveOverrides).not.toHaveBeenCalled();
  });

  it("409 when an involved gate is signed off (passed) (AC3)", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-019", 1), planCase("TC-020", 1), planCase("TC-030", 1)], {
          "TC-019": caseResult("passed"),
          "TC-020": caseResult("passed"),
          "TC-030": caseResult("passed"),
        }) as never,
    );
    const res = await request(app)
      .post("/p1/gates/merge")
      .send({ gateIds: ["PHASE-2", "PHASE-3"] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/signed off|passed/i);
    expect(gateOverrideStore.saveOverrides).not.toHaveBeenCalled();
  });
});

describe("POST /:projectId/gates/split", () => {
  // One pending gate covering WU-031..034 (TC-023 shape).
  beforeEach(() => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded(
        "alpha",
        gate(
          "PHASE-2",
          ["TC-019", "TC-020", "TC-024", "TC-025"],
          ["WU-031", "WU-032", "WU-033", "WU-034"],
        ),
      ),
    ]);
    vi.mocked(workUnitLoader.buildWorkUnitCaseMap).mockReturnValue(
      new Map<string, string[]>([
        ["WU-031", ["TC-019"]],
        ["WU-032", ["TC-020"]],
        ["WU-033", ["TC-024"]],
        ["WU-034", ["TC-025"]],
      ]),
    );
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults(
          [
            planCase("TC-019", 1),
            planCase("TC-020", 1),
            planCase("TC-024", 1),
            planCase("TC-025", 1),
          ],
          { "TC-019": caseResult("not_started") },
        ) as never,
    );
  });

  it("splits a pending gate into two and persists the op (AC2, TC-023)", async () => {
    const res = await request(app)
      .post("/p1/gates/split")
      .send({
        gateId: "PHASE-2",
        parts: [
          { label: "A", coversWorkUnitIds: ["WU-031", "WU-032"] },
          { label: "B", coversWorkUnitIds: ["WU-033", "WU-034"] },
        ],
      });
    expect(res.status).toBe(200);
    expect(gateOverrideStore.saveOverrides).toHaveBeenCalledOnce();
    const ids = res.body.map((g: { gateId: string }) => g.gateId);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("PHASE-2");
  });

  it("400 when the parts do not partition the source covers (loss)", async () => {
    const res = await request(app)
      .post("/p1/gates/split")
      .send({
        gateId: "PHASE-2",
        parts: [
          { label: "A", coversWorkUnitIds: ["WU-031"] },
          { label: "B", coversWorkUnitIds: ["WU-032"] },
        ],
      });
    expect(res.status).toBe(400);
    expect(gateOverrideStore.saveOverrides).not.toHaveBeenCalled();
  });

  it("400 for fewer than two parts", async () => {
    const res = await request(app)
      .post("/p1/gates/split")
      .send({ gateId: "PHASE-2", parts: [{ label: "A", coversWorkUnitIds: ["WU-031"] }] });
    expect(res.status).toBe(400);
  });

  it("409 when the gate is signed off (passed) (AC3)", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults(
          [
            planCase("TC-019", 1),
            planCase("TC-020", 1),
            planCase("TC-024", 1),
            planCase("TC-025", 1),
          ],
          {
            "TC-019": caseResult("passed"),
            "TC-020": caseResult("passed"),
            "TC-024": caseResult("passed"),
            "TC-025": caseResult("passed"),
          },
        ) as never,
    );
    const res = await request(app)
      .post("/p1/gates/split")
      .send({
        gateId: "PHASE-2",
        parts: [
          { label: "A", coversWorkUnitIds: ["WU-031", "WU-032"] },
          { label: "B", coversWorkUnitIds: ["WU-033", "WU-034"] },
        ],
      });
    expect(res.status).toBe(409);
    expect(gateOverrideStore.saveOverrides).not.toHaveBeenCalled();
  });
});

describe("DELETE /:projectId/gates/overrides", () => {
  it("resets the operator regroupings (204)", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([]);
    const res = await request(app).delete("/p1/gates/overrides");
    expect(res.status).toBe(204);
    expect(gateOverrideStore.removeOverrides).toHaveBeenCalledWith("p1");
  });

  it("404 when the project is not registered", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as never);
    const res = await request(app).delete("/p1/gates/overrides");
    expect(res.status).toBe(404);
  });
});

describe("POST /:projectId/gates/:gateId/fix-issues", () => {
  beforeEach(() => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gateWithTracker("WU-040", "o/r#451")),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1)], { "TC-024": caseResult("failed") }) as never,
    );
  });

  it("201 with a complete record on full success, recording the note (TC-045, TC-046)", async () => {
    vi.mocked(fixIssueFiler.fileFixIssueAndBlock).mockResolvedValue({
      fixIssueRef: "o/r#452",
      gateRef: "o/r#451",
      failedCaseId: "TC-024",
      linkStatus: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/p1/gates/WU-040/fix-issues")
      .send({ failedCaseId: "TC-024", notes: "Login button is inert." });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ fixIssueRef: "o/r#452", linkStatus: "complete" });
    // The verifier's notes are appended to the gate's spec results (path-confined).
    expect(testbenchStore.appendNote).toHaveBeenCalledWith(
      REPO,
      "alpha",
      "TC-024",
      "Login button is inert.",
    );
    // The filer is handed the gate ref and the repo derived from it.
    expect(fixIssueFiler.fileFixIssueAndBlock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ repoFullName: "o/r", gateRef: "o/r#451", failedCaseId: "TC-024" }),
    );
  });

  it("207 with link_pending when the link step failed after create (TC-052)", async () => {
    vi.mocked(fixIssueFiler.fileFixIssueAndBlock).mockResolvedValue({
      fixIssueRef: "o/r#452",
      gateRef: "o/r#451",
      failedCaseId: "TC-024",
      linkStatus: "link_pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/p1/gates/WU-040/fix-issues")
      .send({ failedCaseId: "TC-024", notes: "Login button is inert." });

    expect(res.status).toBe(207);
    expect(res.body).toMatchObject({ fixIssueRef: "o/r#452", linkStatus: "link_pending" });
  });

  it("a link-only retry (existingFixRef) skips the note append and returns 201 (TC-052)", async () => {
    vi.mocked(fixIssueFiler.fileFixIssueAndBlock).mockResolvedValue({
      fixIssueRef: "o/r#452",
      gateRef: "o/r#451",
      failedCaseId: "TC-024",
      linkStatus: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/p1/gates/WU-040/fix-issues")
      .send({ failedCaseId: "TC-024", notes: "Login button is inert.", existingFixRef: "o/r#452" });

    expect(res.status).toBe(201);
    expect(testbenchStore.appendNote).not.toHaveBeenCalled();
    expect(fixIssueFiler.fileFixIssueAndBlock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ existingFixRef: "o/r#452" }),
    );
  });

  it("422 and no tracker call when notes are empty (TC-053)", async () => {
    const res = await request(app)
      .post("/p1/gates/WU-040/fix-issues")
      .send({ failedCaseId: "TC-024", notes: "   " });

    expect(res.status).toBe(422);
    expect(fixIssueFiler.fileFixIssueAndBlock).not.toHaveBeenCalled();
    expect(testbenchStore.appendNote).not.toHaveBeenCalled();
  });

  it("rejects a path-escaping evidence write before any tracker call (TC-049)", async () => {
    const res = await request(app).post("/p1/gates/WU-040/fix-issues").send({
      failedCaseId: "TC-024",
      notes: "Login button is inert.",
      evidence: "../../outside-workspace/secrets.txt",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/escapes/i);
    // No issue is filed for a rejected write.
    expect(fixIssueFiler.fileFixIssueAndBlock).not.toHaveBeenCalled();
  });

  it("422 when the active integration plugin lacks the capability (TC-049 degrade)", async () => {
    vi.mocked(fixIssueFiler.fileFixIssueAndBlock).mockRejectedValue(
      new TrackerActionError("no supportsBlockingLinks", "capability-absent"),
    );

    const res = await request(app)
      .post("/p1/gates/WU-040/fix-issues")
      .send({ failedCaseId: "TC-024", notes: "Login button is inert." });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("capability-absent");
  });

  it("409 when no active integration is configured", async () => {
    vi.mocked(fixIssueFiler.fileFixIssueAndBlock).mockRejectedValue(
      new TrackerActionError("no integration", "no-active-integration"),
    );

    const res = await request(app)
      .post("/p1/gates/WU-040/fix-issues")
      .send({ failedCaseId: "TC-024", notes: "Login button is inert." });

    expect(res.status).toBe(409);
  });

  it("404 for an unknown gate id", async () => {
    const res = await request(app)
      .post("/p1/gates/WU-999/fix-issues")
      .send({ failedCaseId: "TC-024", notes: "x" });
    expect(res.status).toBe(404);
  });

  it("409 when the gate has no tracker issue to block, and 400 for a missing failedCaseId", async () => {
    // No-tracker gate: a fix issue cannot be wired to a gate with no block target.
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-040", ["TC-024"])),
    ]);
    const noTracker = await request(app)
      .post("/p1/gates/WU-040/fix-issues")
      .send({ failedCaseId: "TC-024", notes: "x" });
    expect(noTracker.status).toBe(409);
    expect(fixIssueFiler.fileFixIssueAndBlock).not.toHaveBeenCalled();

    // Missing failedCaseId: a 400 input validation failure (re-mount a tracked
    // gate so the request reaches the body validation).
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gateWithTracker("WU-040", "o/r#451")),
    ]);
    const missingId = await request(app).post("/p1/gates/WU-040/fix-issues").send({ notes: "x" });
    expect(missingId.status).toBe(400);
  });
});

describe("GET /:projectId/gates with overrides applied", () => {
  it("returns the effective (regrouped) gates after a recorded merge", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("PHASE-2", ["TC-019"], ["WU-031"])),
      loaded("alpha", gate("PHASE-3", ["TC-030"], ["WU-050"])),
    ]);
    vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue({
      ...emptyGateOverrides(),
      ops: [{ op: "merge", gateIds: ["PHASE-2", "PHASE-3"] }],
    });
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-019", 1), planCase("TC-030", 1)], {
          "TC-019": caseResult("not_started"),
        }) as never,
    );
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    const ids = res.body.gates.map((g: { gateId: string }) => g.gateId);
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain("PHASE-2");
  });
});
