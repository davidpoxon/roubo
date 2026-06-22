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
  return {
    WorkUnitsValidationError: actual.WorkUnitsValidationError,
    loadVerifyUnits: vi.fn(),
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
  };
});

import router from "./gates.js";
import * as projectRegistry from "../services/project-registry.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import { WorkUnitsValidationError } from "../services/work-unit-loader.js";
import * as testbenchStore from "../lib/testbench-store.js";
import { MissingPlanError } from "../lib/testbench-store.js";
import type { LoadedVerifyUnit } from "../services/work-unit-loader.js";
import type { VerifyUnit } from "../lib/gate-evaluator.js";
import type { Case, CaseResult } from "@roubo/shared/testbench-contracts";

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
      expect(r.body).toHaveLength(2);
      expect(r.body[0]).toMatchObject({ gateId: "WU-100", status: "passed" });
      expect(r.body[1]).toMatchObject({ gateId: "WU-200", status: "passed" });
    });
  });

  it("returns [] when there are no gates", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([]);
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("404 when the project is not registered", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as never);
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(404);
  });

  it("400 for a present-but-invalid work-units.json", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockImplementation(() => {
      throw new WorkUnitsValidationError("alpha", ["bad"]);
    });
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(400);
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
