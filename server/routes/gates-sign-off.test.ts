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

// The gate write handlers share a single module-level express-rate-limit instance
// (limit 20 / 60s, keyed by client IP), and every write request across this whole
// file counts against that one window since the router is imported once. The
// merged + split + fix-issue write-path tests would otherwise push past the cap
// and flip a later test to 429. Wrap the real limiter with a high cap so the
// draft-7 RateLimit headers are still attached while removing the shared-budget
// fragility (mirrors gates.test.ts). No test in this file asserts a 429.
vi.mock("express-rate-limit", async () => {
  const actual = await vi.importActual<typeof import("express-rate-limit")>("express-rate-limit");
  const realRateLimit = actual.default;
  return {
    ...actual,
    default: (options: Parameters<typeof realRateLimit>[0]) =>
      realRateLimit({ ...options, limit: 100_000 }),
  };
});

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../services/work-unit-loader.js", async () => {
  const actual = await vi.importActual<typeof import("../services/work-unit-loader.js")>(
    "../services/work-unit-loader.js",
  );
  const loadVerifyUnits = vi.fn();
  // effectiveGates now loads via loadVerifyUnitsWithDiagnostics (#371); delegate to
  // the mocked loadVerifyUnits with no invalid specs so the existing tests that set
  // loadVerifyUnits drive the sign-off / reopen / GET handlers unchanged.
  const loadVerifyUnitsWithDiagnostics = vi.fn((repoPath: string, slug?: string) => ({
    loaded: loadVerifyUnits(repoPath, slug),
    invalidSpecs: [],
  }));
  return {
    WorkUnitsValidationError: actual.WorkUnitsValidationError,
    loadVerifyUnits,
    loadVerifyUnitsWithDiagnostics,
    buildWorkUnitCaseMap: vi.fn(() => new Map()),
    // The blockedBy derivation (#433) reads the full per-slug unit graph; default
    // to an empty graph so these sign-off / reopen / GET tests derive no blockers.
    loadAllUnitsForSlug: vi.fn(() => []),
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
import { mintMergeGateId, mintSplitGateId } from "../lib/gate-overrides.js";
import * as testbenchStore from "../lib/testbench-store.js";
import { fileFixIssueAndBlock } from "../services/fix-issue-filer.js";
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

// The operator-merged gate spanning WU-040 + WU-060 (issue #435). Its synthetic id
// has no tracker of its own; each SOURCE gate carries a real filed tracker ref, so
// sign-off / reopen / signed-off fan out over the two sources.
const MERGED_ID = mintMergeGateId(["WU-040", "WU-060"]); // MERGED:WU-040+WU-060
const MERGED_PATH = encodeURIComponent(MERGED_ID);

// Seed two tracked source gates plus a recorded merge over them, all cases passing,
// so the effective merged gate evaluates `passed`. `sources` lets a test drop a
// source's tracker or vary its cases.
function passedMergedGate(sources?: VerifyUnit[]) {
  const units = sources ?? [
    gateWithTracker("WU-040", "o/r#451", ["TC-024"]),
    gateWithTracker("WU-060", "o/r#452", ["TC-025"]),
  ];
  vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue(units.map((u) => loaded("alpha", u)));
  vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue({
    ...emptyGateOverrides(),
    ops: [{ op: "merge", gateIds: ["WU-040", "WU-060"] }],
  });
  vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
    planAndResults([planCase("TC-024", 1), planCase("TC-025", 1)], {
      "TC-024": caseResult("passed"),
      "TC-025": caseResult("passed"),
    }) as never,
  );
}

// The operator-split source gate WU-040 (covers WU-101 + WU-102) split into two
// parts A/B (issue #445). The synthetic split parts have no tracker of their own;
// the SOURCE gate carries the real filed tracker ref, so sign-off / reopen /
// signed-off / fix-issue fan out over that single source for every part. All
// parts share the one source: signing off any part closes the source issue.
const SPLIT_A_ID = mintSplitGateId("WU-040", "A"); // SPLIT:WU-040:A
const SPLIT_A_PATH = encodeURIComponent(SPLIT_A_ID);

// A tracked source gate carrying covers (gateWithTracker alone sets no covers).
function trackedSourceWithCovers(
  id: string,
  ref: string,
  testCaseIds: string[],
  covers: string[],
): VerifyUnit {
  const tracker: Tracker = { system: "github", ref, url: "https://x", blocked_by_refs: [] };
  return { ...gate(id, testCaseIds, covers), tracker };
}

// Seed one source gate plus a recorded split over it, both parts' cases passing,
// so each effective split part evaluates `passed`. `source` lets a test drop the
// source's tracker. The WU- -> TC- case map is mocked so the parts partition the
// source's covers and gating set exactly (else applyGateOverrides drops the split).
function passedSplitGate(source?: VerifyUnit) {
  const sourceUnit =
    source ??
    trackedSourceWithCovers("WU-040", "o/r#451", ["TC-024", "TC-025"], ["WU-101", "WU-102"]);
  vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([loaded("alpha", sourceUnit)]);
  vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue({
    ...emptyGateOverrides(),
    ops: [
      {
        op: "split",
        gateId: "WU-040",
        parts: [
          { label: "A", coversWorkUnitIds: ["WU-101"] },
          { label: "B", coversWorkUnitIds: ["WU-102"] },
        ],
      },
    ],
  });
  vi.mocked(workUnitLoader.buildWorkUnitCaseMap).mockReturnValue(
    new Map([
      ["WU-101", ["TC-024"]],
      ["WU-102", ["TC-025"]],
    ]),
  );
  vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
    planAndResults([planCase("TC-024", 1), planCase("TC-025", 1)], {
      "TC-024": caseResult("passed"),
      "TC-025": caseResult("passed"),
    }) as never,
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
    expect(res.body.gates).toHaveLength(1);
    expect(res.body.gates[0]).toMatchObject({ gateId: "WU-040", signedOff: true });
  });
});

describe("GET signedOff qualifies a contract-conformant bare tracker.ref (issue #1006)", () => {
  // A passed gate whose tracker is contract-conformant: a BARE `ref` (issue
  // number) with the full owner/repo carried in `url`. Before the fix the route
  // passed "1033" verbatim to getIssue and the bundled GitHub plugin rejected it
  // with `missing "#"`; now it must qualify to "o/r#1033" first.
  function passedBareRefGate() {
    const tracker: Tracker = {
      system: "github",
      ref: "1033",
      url: "https://github.com/o/r/issues/1033",
      blocked_by_refs: [],
    };
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", { ...gate("WU-040", ["TC-024"]), tracker }),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1)], { "TC-024": caseResult("passed") }) as never,
    );
  }

  beforeEach(() => {
    passedBareRefGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
  });

  it("calls getIssue with the QUALIFIED owner/repo#<n> externalId, not the bare ref", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);

    const res = await request(app).get("/p1/gates/WU-040");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "passed", signedOff: true });
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "o/r#1033",
    });
    // The bare ref must never reach the plugin (it would crash with `missing "#"`).
    expect(pluginManager.invoke).not.toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "1033",
    });
  });
});

describe("merged gate sign-off / reopen / signedOff (issue #435)", () => {
  it("signs off a passed merged gate by closing EVERY source gate's tracker issue", async () => {
    passedMergedGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    // withSignedOff re-reads each (now closed) source tracker issue.
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);

    const res = await request(app).post(`/p1/gates/${MERGED_PATH}/sign-off`);

    expect(res.status).toBe(200);
    expect(closeGate).toHaveBeenCalledTimes(2);
    expect(closeGate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "WU-040" }));
    expect(closeGate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "WU-060" }));
    expect(res.body).toMatchObject({ gateId: MERGED_ID, status: "passed", signedOff: true });
  });

  it("reopens a merged gate by reopening EVERY source gate's tracker issue", async () => {
    passedMergedGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "open" } as never);

    const res = await request(app).delete(`/p1/gates/${MERGED_PATH}/sign-off`);

    expect(res.status).toBe(200);
    expect(reopenGate).toHaveBeenCalledTimes(2);
    expect(reopenGate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "WU-040" }));
    expect(reopenGate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "WU-060" }));
    expect(res.body).toMatchObject({ gateId: MERGED_ID, signedOff: false });
  });

  it("GET derives signedOff:true only when ALL source issues are done", async () => {
    passedMergedGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);

    const res = await request(app).get(`/p1/gates/${MERGED_PATH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "passed", signedOff: true });
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "o/r#451",
    });
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "o/r#452",
    });
  });

  it("GET derives signedOff:false when only SOME source issues are done", async () => {
    passedMergedGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    // First source issue closed, second still open -> not fully signed off.
    vi.mocked(pluginManager.invoke).mockImplementation((_pluginId, _op, params) =>
      Promise.resolve({
        currentState:
          (params as { externalId: string }).externalId === "o/r#451" ? "closed" : "open",
      } as never),
    );

    const res = await request(app).get(`/p1/gates/${MERGED_PATH}`);
    expect(res.status).toBe(200);
    expect(res.body.signedOff).toBe(false);
  });

  it("degrades loudly with 409 when a source gate has no tracker issue, without closing any", async () => {
    passedMergedGate([
      gateWithTracker("WU-040", "o/r#451", ["TC-024"]),
      gate("WU-060", ["TC-025"]), // no tracker
    ]);
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);

    const res = await request(app).post(`/p1/gates/${MERGED_PATH}/sign-off`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no tracker issue/i);
    expect(closeGate).not.toHaveBeenCalled();
  });

  it("is fail-closed: 409 when the merged gate is not passed, without closing any source", async () => {
    passedMergedGate();
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1), planCase("TC-025", 1)], {
        "TC-024": caseResult("passed"),
        "TC-025": caseResult("not_started"),
      }) as never,
    );

    const res = await request(app).post(`/p1/gates/${MERGED_PATH}/sign-off`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not 'passed'|cannot be signed off/i);
    expect(closeGate).not.toHaveBeenCalled();
  });

  it("surfaces a TrackerActionError from a source close (partial progress accepted)", async () => {
    passedMergedGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    // First source closes, second is refused by the plugin.
    vi.mocked(closeGate)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TrackerActionError("not consented", "not-consented"));

    const res = await request(app).post(`/p1/gates/${MERGED_PATH}/sign-off`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not-consented");
    expect(closeGate).toHaveBeenCalledTimes(2);
  });
});

describe("split gate sign-off / reopen / signedOff (issue #445)", () => {
  it("signs off a passed split gate by closing the SOURCE gate's tracker issue", async () => {
    passedSplitGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    // withSignedOff re-reads the (now closed) source tracker issue.
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);

    const res = await request(app).post(`/p1/gates/${SPLIT_A_PATH}/sign-off`);

    expect(res.status).toBe(200);
    // The synthetic split part has no tracker of its own: sign-off fans out over the
    // one real source gate (WU-040), closing its filed issue exactly once.
    expect(closeGate).toHaveBeenCalledTimes(1);
    expect(closeGate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "WU-040" }));
    expect(res.body).toMatchObject({ gateId: SPLIT_A_ID, status: "passed", signedOff: true });
  });

  it("reopens a split gate by reopening the SOURCE gate's tracker issue", async () => {
    passedSplitGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "open" } as never);

    const res = await request(app).delete(`/p1/gates/${SPLIT_A_PATH}/sign-off`);

    expect(res.status).toBe(200);
    expect(reopenGate).toHaveBeenCalledTimes(1);
    expect(reopenGate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "WU-040" }));
    expect(res.body).toMatchObject({ gateId: SPLIT_A_ID, signedOff: false });
  });

  it("GET derives signedOff from the source issue", async () => {
    passedSplitGate();
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);

    const res = await request(app).get(`/p1/gates/${SPLIT_A_PATH}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "passed", signedOff: true });
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "o/r#451",
    });
  });

  it("degrades loudly with 409 when the source gate has no tracker issue, without closing", async () => {
    // Source gate carries covers but no tracker, so every split part is untracked.
    passedSplitGate(gate("WU-040", ["TC-024", "TC-025"], ["WU-101", "WU-102"]));
    vi.mocked(resolveActivePlugin).mockReturnValue(ACTIVE);

    const res = await request(app).post(`/p1/gates/${SPLIT_A_PATH}/sign-off`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no tracker issue/i);
    expect(closeGate).not.toHaveBeenCalled();
  });

  it("is fail-closed: 409 when the split part is not passed, without closing", async () => {
    passedSplitGate();
    // Part A gates only TC-024; mark it not_started so part A is not passable.
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1), planCase("TC-025", 1)], {
        "TC-024": caseResult("not_started"),
        "TC-025": caseResult("passed"),
      }) as never,
    );

    const res = await request(app).post(`/p1/gates/${SPLIT_A_PATH}/sign-off`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not 'passed'|cannot be signed off/i);
    expect(closeGate).not.toHaveBeenCalled();
  });

  it("404 for an unknown split part id", async () => {
    passedSplitGate();
    const res = await request(app).post(
      `/p1/gates/${encodeURIComponent("SPLIT:WU-040:Z")}/sign-off`,
    );
    expect(res.status).toBe(404);
  });
});

describe("fix-issue filing fans out over source gates (issue #435/#445)", () => {
  it("files a fix issue against the split gate's SOURCE tracker ref rather than 409ing", async () => {
    passedSplitGate();
    // A failed gating case on part A so a fix issue is warranted.
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1), planCase("TC-025", 1)], {
        "TC-024": caseResult("failed"),
        "TC-025": caseResult("passed"),
      }) as never,
    );
    vi.mocked(fileFixIssueAndBlock).mockResolvedValue({
      fixIssueRef: "o/r#500",
      gateRef: "o/r#451",
      failedCaseId: "TC-024",
      linkStatus: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(app)
      .post(`/p1/gates/${SPLIT_A_PATH}/fix-issues`)
      .send({ failedCaseId: "TC-024", notes: "Login button is inert." });

    expect(res.status).toBe(201);
    // Not a 409: the split part is blockable via its single source gate's tracker
    // ref, and there is no second source so no additionalGateRefs is passed.
    expect(fileFixIssueAndBlock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        repoFullName: "o/r",
        gateRef: "o/r#451",
        failedCaseId: "TC-024",
      }),
    );
    expect(vi.mocked(fileFixIssueAndBlock).mock.calls[0][1]).not.toHaveProperty(
      "additionalGateRefs",
    );
  });

  it("files ONE fix issue blocking EVERY source ref for a merged gate (additionalGateRefs)", async () => {
    passedMergedGate();
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1), planCase("TC-025", 1)], {
        "TC-024": caseResult("failed"),
        "TC-025": caseResult("passed"),
      }) as never,
    );
    vi.mocked(fileFixIssueAndBlock).mockResolvedValue({
      fixIssueRef: "o/r#500",
      gateRef: "o/r#451",
      failedCaseId: "TC-024",
      linkStatus: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(app)
      .post(`/p1/gates/${MERGED_PATH}/fix-issues`)
      .send({ failedCaseId: "TC-024", notes: "Login button is inert." });

    expect(res.status).toBe(201);
    // One fix issue blocks BOTH source gates: gateRef is the first source, the rest
    // ride along as additionalGateRefs (mirrors "sign-off closes every source").
    expect(fileFixIssueAndBlock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        repoFullName: "o/r",
        gateRef: "o/r#451",
        additionalGateRefs: ["o/r#452"],
        failedCaseId: "TC-024",
      }),
    );
  });

  it("409 when a merged gate's source has no tracker, without filing", async () => {
    passedMergedGate([
      gateWithTracker("WU-040", "o/r#451", ["TC-024"]),
      gate("WU-060", ["TC-025"]), // no tracker
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-024", 1), planCase("TC-025", 1)], {
        "TC-024": caseResult("failed"),
        "TC-025": caseResult("passed"),
      }) as never,
    );

    const res = await request(app)
      .post(`/p1/gates/${MERGED_PATH}/fix-issues`)
      .send({ failedCaseId: "TC-024", notes: "Login button is inert." });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no tracker issue/i);
    expect(fileFixIssueAndBlock).not.toHaveBeenCalled();
  });
});
