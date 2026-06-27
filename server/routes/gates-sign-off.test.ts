// Sign-off / reopen route tests for the verify gate (issue #830, FR-007/FR-008,
// US-005, NFR-001, NFR-005). Kept in a separate file from gates.test.ts so this
// router instance (and its module-level rate limiters) is fresh under Vitest's
// per-file isolation: the sign-off / reopen write requests here have their own
// rate-limit budget and never accumulate against gates.test.ts's writes.
//
// closeGate / reopenGate are mocked: the privileged tracker close is exercised in
// tracker-action-gateway.test.ts and gate-lifecycle-coordinator.test.ts. Here we
// assert the route's guards (fail-closed 409, loud-degrade 409, TrackerActionError
// mapping) and that GET projects the server-derived `signedOff` signal.

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

vi.mock("../services/tracker-action-gateway.js", async () => {
  const actual = await vi.importActual<typeof import("../services/tracker-action-gateway.js")>(
    "../services/tracker-action-gateway.js",
  );
  return {
    TrackerActionError: actual.TrackerActionError,
    closeGate: vi.fn(async () => undefined),
    reopenGate: vi.fn(async () => undefined),
  };
});

vi.mock("../services/active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(() => null),
}));

vi.mock("../services/plugin-manager.js", () => ({
  invoke: vi.fn(),
}));

import router from "./gates.js";
import * as projectRegistry from "../services/project-registry.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import * as gateOverrideStore from "../services/gate-override-store.js";
import { emptyGateOverrides } from "@roubo/shared/gate-overrides-contract";
import * as testbenchStore from "../lib/testbench-store.js";
import { TrackerActionError, closeGate, reopenGate } from "../services/tracker-action-gateway.js";
import { resolveActivePlugin } from "../services/active-plugin.js";
import * as pluginManager from "../services/plugin-manager.js";
import type { LoadedVerifyUnit } from "../services/work-unit-loader.js";
import type { VerifyUnit } from "../lib/gate-evaluator.js";
import type { Case, CaseResult } from "@roubo/shared/testbench-contracts";
import type { Tracker } from "@roubo/shared/work-units-contract";
import type { ActivePlugin } from "../services/active-plugin.js";

const app = express();
app.use(express.json());
app.use("/", router);

const REPO = "/repo";
const PLAN_HASH = "plan-hash-v1";
const ACTIVE: ActivePlugin = { pluginId: "github-com", integrationId: "github-com", pageSize: 50 };

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

function gateWithTracker(id: string, ref: string, testCaseIds: string[] = ["TC-024"]): VerifyUnit {
  const tracker: Tracker = { system: "github", ref, url: "https://x", blocked_by_refs: [] };
  return { ...gate(id, testCaseIds), tracker };
}

function loaded(slug: string, unit: VerifyUnit): LoadedVerifyUnit {
  return { slug, unit };
}

function planCase(id: string, level: number, type = "functional"): Case {
  return { id, title: id, description: "", level, type, steps: [] } as never;
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

// A passed gate carrying a GitHub tracker ref: its single L1 gating case passes.
function passedTrackedGate() {
  vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
    loaded("alpha", gateWithTracker("WU-040", "o/r#451", ["TC-024"])),
  ]);
  vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
    planAndResults([planCase("TC-024", 1)], { "TC-024": caseResult("passed") }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectRegistry.getProject).mockReturnValue({ repoPath: REPO, config: {} } as never);
  vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue(emptyGateOverrides());
  vi.mocked(workUnitLoader.buildWorkUnitCaseMap).mockReturnValue(new Map());
  // Default seams: no active integration, close / reopen succeed as no-ops.
  vi.mocked(resolveActivePlugin).mockReturnValue(null);
  vi.mocked(pluginManager.invoke).mockReset();
  vi.mocked(closeGate).mockResolvedValue(undefined);
  vi.mocked(reopenGate).mockResolvedValue(undefined);
});

describe("POST /:projectId/gates/:gateId/sign-off (#830)", () => {
  beforeEach(passedTrackedGate);

  it("closes the gate's tracker issue and returns signedOff:true on success (AC, NFR-001)", async () => {
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    // After closeGate runs, withSignedOff re-reads the (now closed) tracker issue.
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);

    const res = await request(app).post("/p1/gates/WU-040/sign-off");

    expect(res.status).toBe(200);
    expect(closeGate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "WU-040" }));
    expect(res.body).toMatchObject({ gateId: "WU-040", status: "passed", signedOff: true });
  });

  it("is fail-closed: 409 when the gate's status is not passed, without closing", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1)], { "TC-024": caseResult("not_started") }) as never,
    );

    const res = await request(app).post("/p1/gates/WU-040/sign-off");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not 'passed'|cannot be signed off/i);
    expect(closeGate).not.toHaveBeenCalled();
  });

  it("degrades loudly with 409 when the gate has no tracker issue", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-040", ["TC-024"])),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1)], { "TC-024": caseResult("passed") }) as never,
    );

    const res = await request(app).post("/p1/gates/WU-040/sign-off");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no tracker issue/i);
    expect(closeGate).not.toHaveBeenCalled();
  });

  it("404 for an unknown gate id", async () => {
    const res = await request(app).post("/p1/gates/WU-999/sign-off");
    expect(res.status).toBe(404);
  });

  it("maps TrackerActionError no-active-integration to 409", async () => {
    vi.mocked(closeGate).mockRejectedValueOnce(
      new TrackerActionError("no integration", "no-active-integration"),
    );
    const res = await request(app).post("/p1/gates/WU-040/sign-off");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no-active-integration");
  });

  it("maps TrackerActionError not-consented to 409", async () => {
    vi.mocked(closeGate).mockRejectedValueOnce(
      new TrackerActionError("not consented", "not-consented"),
    );
    const res = await request(app).post("/p1/gates/WU-040/sign-off");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not-consented");
  });

  it("maps TrackerActionError capability-absent to 422", async () => {
    vi.mocked(closeGate).mockRejectedValueOnce(
      new TrackerActionError("no transition capability", "capability-absent"),
    );
    const res = await request(app).post("/p1/gates/WU-040/sign-off");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("capability-absent");
  });
});

describe("DELETE /:projectId/gates/:gateId/sign-off reopen (#830)", () => {
  beforeEach(passedTrackedGate);

  it("reopens the gate's tracker issue and returns signedOff:false", async () => {
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    // After reopen, withSignedOff re-reads the (now open) tracker issue.
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "open" } as never);

    const res = await request(app).delete("/p1/gates/WU-040/sign-off");

    expect(res.status).toBe(200);
    expect(reopenGate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "WU-040" }));
    expect(res.body).toMatchObject({ gateId: "WU-040", signedOff: false });
  });

  it("does NOT require status === passed (reopens a non-passed gate)", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1)], { "TC-024": caseResult("not_started") }) as never,
    );

    const res = await request(app).delete("/p1/gates/WU-040/sign-off");

    expect(res.status).toBe(200);
    expect(reopenGate).toHaveBeenCalled();
    expect(res.body.signedOff).toBe(false);
  });

  it("degrades loudly with 409 when the gate has no tracker issue, without reopening", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-040", ["TC-024"])),
    ]);

    const res = await request(app).delete("/p1/gates/WU-040/sign-off");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no tracker issue/i);
    expect(reopenGate).not.toHaveBeenCalled();
  });

  it("404 for an unknown gate id", async () => {
    const res = await request(app).delete("/p1/gates/WU-999/sign-off");
    expect(res.status).toBe(404);
  });

  it("maps a TrackerActionError from reopenGate via handleError (not-consented -> 409)", async () => {
    vi.mocked(reopenGate).mockRejectedValueOnce(
      new TrackerActionError("not consented", "not-consented"),
    );
    const res = await request(app).delete("/p1/gates/WU-040/sign-off");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not-consented");
  });
});

describe("GET /:projectId/gates/:gateId derives signedOff from the tracker issue (#830)", () => {
  beforeEach(() => {
    passedTrackedGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
  });

  it("signedOff:true for a passed gate whose tracker issue is closed", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);
    const res = await request(app).get("/p1/gates/WU-040");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "passed", signedOff: true });
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "o/r#451",
    });
  });

  it("signedOff:false for a passed gate whose tracker issue is still open", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "open" } as never);
    const res = await request(app).get("/p1/gates/WU-040");
    expect(res.status).toBe(200);
    expect(res.body.signedOff).toBe(false);
  });

  it("signedOff:false WITHOUT any plugin RPC for a non-passed gate (bounds RPCs)", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1)], { "TC-024": caseResult("not_started") }) as never,
    );
    const res = await request(app).get("/p1/gates/WU-040");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "pending", signedOff: false });
    expect(pluginManager.invoke).not.toHaveBeenCalled();
    expect(resolveActivePlugin).not.toHaveBeenCalled();
  });

  it("signedOff:false and fail-closed (no 500) when the getIssue RPC throws", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("network down"));
    const res = await request(app).get("/p1/gates/WU-040");
    expect(res.status).toBe(200);
    expect(res.body.signedOff).toBe(false);
  });

  it("signedOff:false (no RPC) for a passed gate when no integration is active", async () => {
    vi.mocked(resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).get("/p1/gates/WU-040");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "passed", signedOff: false });
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("the list endpoint also projects signedOff for each gate", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ gateId: "WU-040", signedOff: true });
  });
});
