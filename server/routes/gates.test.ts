import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The gate write handlers share a single module-level express-rate-limit instance
// (limit 20 / 60s, keyed by client IP), and every write request across this whole
// file counts against that one window since the router is imported once. The
// suite would otherwise sit at the cap, so adding any write-path test (here: the
// #427 symlink-escape regressions) would flip a later test to 429. Wrap the real
// limiter with a high cap so the draft-7 RateLimit headers are still attached
// (the "rate limiting" describe asserts only that the limiter is mounted) while
// removing the shared-budget fragility. No test asserts a 429.
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
    // The blockedBy derivation (#433) reads the full per-slug unit graph. Default
    // to an empty graph so existing tests derive no blockers; the #433 tests set
    // a fixture graph per call.
    loadAllUnitsForSlug: vi.fn(() => []),
  };
});

// The signed-off signal (#830) and the blockedBy clears-on-sign-off case (#433)
// flow through the active integration plugin. Mock both so a passed + tracked gate
// can be made "signed off" deterministically; default resolveActivePlugin -> null
// keeps every other test at signedOff=false without touching the real plugin path.
vi.mock("../services/active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(() => null),
}));

vi.mock("../services/plugin-manager.js", () => ({
  invoke: vi.fn(),
}));

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

// #432: gate evaluation now resolves the results root from a live TestBench bench
// focused on the gate's slug (reading the same worktree the TestBench surface
// writes marks to), falling back to the project repoPath. Mock the bench-manager
// and spec-discovery collaborators the resolver consults. Both default to the
// fallback shape (no benches), so every pre-existing test still evaluates against
// the project repoPath unchanged.
vi.mock("../services/bench-manager.js", () => ({
  getBenches: vi.fn(() => []),
}));

vi.mock("../lib/testbench-spec-discovery.js", () => ({
  resolveFocusedSpec: vi.fn(),
}));

import router from "./gates.js";
import * as projectRegistry from "../services/project-registry.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import * as gateOverrideStore from "../services/gate-override-store.js";
import { emptyGateOverrides } from "@roubo/shared/gate-overrides-contract";
import * as testbenchStore from "../lib/testbench-store.js";
import { MissingPlanError } from "../lib/testbench-store.js";
import * as benchManager from "../services/bench-manager.js";
import * as specDiscovery from "../lib/testbench-spec-discovery.js";
import type { Bench } from "@roubo/shared";
import * as fixIssueFiler from "../services/fix-issue-filer.js";
import * as activePlugin from "../services/active-plugin.js";
import * as pluginManager from "../services/plugin-manager.js";
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
  // Default (#432): no TestBench benches, so gate evaluation falls back to the
  // project repoPath. vi.clearAllMocks() clears call history but not a leaked
  // mockReturnValue, so this must be re-asserted per test to keep a positive-case
  // test from bleeding a testbench bench into a later one.
  vi.mocked(benchManager.getBenches).mockReturnValue([]);
  // Default: no active integration, so a passed + tracked gate stays signedOff
  // false unless a test opts into the plugin path. Re-set each test so a prior
  // test's override never leaks (clearAllMocks does not reset return values).
  vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
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

  // #427 (mirrors TC-052): a valid-slug `.specifications/<slug>` symlink that
  // points outside the repo passes the lexical resolveWithin check but is caught
  // by the realpath barrier at the evidence sink, so nothing is written into the
  // outside dir and no issue is filed for the rejected write. The evidence value
  // is MULTI-SEGMENT ("logs/secrets.txt") on purpose: `dir` is then a not-yet-
  // existing subdirectory under the symlinked slug, so the barrier must run BEFORE
  // mkdirSync or the recursive mkdir would follow the symlink and create a
  // directory (`outside/logs`) OUTSIDE repoPath before the check could fire.
  it("rejects a symlinked spec dir escaping the repo and creates nothing outside (#427)", async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-evidence-repo-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gates-evidence-outside-"));
    try {
      vi.mocked(projectRegistry.getProject).mockReturnValue({
        repoPath: repoDir,
        config: {},
      } as never);
      const specs = path.join(repoDir, ".specifications");
      fs.mkdirSync(specs, { recursive: true });
      // `alpha` is a valid slug (SPEC_SLUG_RE) but a symlink to outside the repo.
      fs.symlinkSync(outside, path.join(specs, "alpha"), "dir");

      const before = fs.readdirSync(outside);
      const res = await request(app).post("/p1/gates/WU-040/fix-issues").send({
        failedCaseId: "TC-024",
        notes: "Login button is inert.",
        evidence: "logs/secrets.txt",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/escapes/i);
      // Nothing (neither the intermediate `logs` directory nor the evidence file)
      // was created in the outside directory, and no issue is filed for the
      // rejected write. `readdirSync(outside)` unchanged proves mkdirSync never ran
      // outside the repo before the barrier threw.
      expect(fs.readdirSync(outside)).toEqual(before);
      expect(fs.existsSync(path.join(outside, "logs"))).toBe(false);
      expect(fs.existsSync(path.join(outside, "logs", "secrets.txt"))).toBe(false);
      expect(fixIssueFiler.fileFixIssueAndBlock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // #427 no-false-reject guard: when the repo root legitimately sits under a
  // symlinked prefix (e.g. macOS /var/folders -> /private/var), the realpath-to-
  // realpath comparison keeps the evidence write inside the root, so it must still
  // succeed rather than being wrongly rejected.
  it("writes evidence when the repo root sits under a symlinked prefix (no false reject, #427)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gates-evidence-symroot-"));
    try {
      const realParent = path.join(base, "real-parent");
      fs.mkdirSync(realParent);
      const linkParent = path.join(base, "link-parent");
      fs.symlinkSync(realParent, linkParent, "dir");
      const repoDir = path.join(linkParent, "repo");
      fs.mkdirSync(repoDir);

      vi.mocked(projectRegistry.getProject).mockReturnValue({
        repoPath: repoDir,
        config: {},
      } as never);
      vi.mocked(fixIssueFiler.fileFixIssueAndBlock).mockResolvedValue({
        fixIssueRef: "o/r#452",
        gateRef: "o/r#451",
        failedCaseId: "TC-024",
        linkStatus: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await request(app).post("/p1/gates/WU-040/fix-issues").send({
        failedCaseId: "TC-024",
        notes: "Login button is inert.",
        evidence: "evidence.txt",
      });

      expect(res.status).toBe(201);
      const written = path.join(repoDir, ".specifications", "alpha", "evidence.txt");
      expect(fs.readFileSync(written, "utf8")).toBe("Login button is inert.");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
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

// #432: a TestBench writes observation marks under its OWN worktree
// (bench.workspacePath/.specifications/<slug>/test-results.json, #493), but a gate
// is project-level. Before the fix, gate evaluation always read the registered
// project repoPath, so an in-UI mark never reached the gate and an all-passed
// batch stayed pending forever. The fix resolves the results root from a live
// TestBench focused on the gate's slug and reads from that worktree instead.
describe("gate evaluation reads results from a focused TestBench worktree (#432)", () => {
  const WORKTREE = "/workspaces/testbench-1";

  function testbench(slug: string): Bench {
    return {
      variant: "testbench",
      workspacePath: WORKTREE,
      focusedSpecPath: `${WORKTREE}/.specifications/${slug}/test-cases.json`,
    } as never;
  }

  it("flips the gate Pending->Passed when the focused worktree has the marks the project repo lacks", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-040", ["TC-019", "TC-024"], ["WU-031", "WU-032"])),
    ]);
    // A live TestBench focused on `alpha`, living in its own worktree.
    vi.mocked(benchManager.getBenches).mockReturnValue([testbench("alpha")]);
    vi.mocked(specDiscovery.resolveFocusedSpec).mockReturnValue({
      slug: "alpha",
      resolvedPath: `${WORKTREE}/.specifications/alpha/test-cases.json`,
    });
    // The worktree copy is all-passed (the operator's in-UI marks); the project
    // repo copy is still not_started (never manually copied over). The gate must
    // read the worktree copy.
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation((root: string) => {
      const cases = [planCase("TC-019", 1), planCase("TC-024", 1)];
      if (root === WORKTREE) {
        return planAndResults(cases, {
          "TC-019": caseResult("passed"),
          "TC-024": caseResult("passed"),
        }) as never;
      }
      return planAndResults(cases, {
        "TC-019": caseResult("not_started"),
        "TC-024": caseResult("not_started"),
      }) as never;
    });

    const res = await request(app).get("/p1/gates/WU-040");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("passed");
    expect(res.body.unresolvedCaseIds).toEqual([]);
    // Proof it sourced the worktree, not the project repo.
    expect(testbenchStore.readPlanAndResults).toHaveBeenCalledWith(WORKTREE, "alpha");
    expect(testbenchStore.readPlanAndResults).not.toHaveBeenCalledWith(REPO, "alpha");
  });

  it("falls back to the project repoPath when no focused TestBench matches the slug (no regression)", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-040", ["TC-019"], ["WU-031"])),
    ]);
    // A TestBench exists but focuses a DIFFERENT slug, so it must not be consulted
    // for `alpha`: evaluation reads the project repo.
    vi.mocked(benchManager.getBenches).mockReturnValue([testbench("beta")]);
    vi.mocked(specDiscovery.resolveFocusedSpec).mockReturnValue({
      slug: "beta",
      resolvedPath: `${WORKTREE}/.specifications/beta/test-cases.json`,
    });
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation((root: string) => {
      if (root === REPO) {
        return planAndResults([planCase("TC-019", 1)], {
          "TC-019": caseResult("passed"),
        }) as never;
      }
      throw new Error(`unexpected results root ${root}`);
    });

    const res = await request(app).get("/p1/gates/WU-040");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("passed");
    expect(testbenchStore.readPlanAndResults).toHaveBeenCalledWith(REPO, "alpha");
    expect(testbenchStore.readPlanAndResults).not.toHaveBeenCalledWith(WORKTREE, "alpha");
  });

  it("skips a TestBench whose focusedSpecPath is malformed and falls back (fail-closed)", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-040", ["TC-019"], ["WU-031"])),
    ]);
    vi.mocked(benchManager.getBenches).mockReturnValue([testbench("alpha")]);
    // A malformed / escaping focusedSpecPath throws: the bench is skipped, not fatal.
    vi.mocked(specDiscovery.resolveFocusedSpec).mockImplementation(() => {
      throw new Error("focusedSpecPath escapes the project repository");
    });
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation((root: string) => {
      if (root === REPO) {
        return planAndResults([planCase("TC-019", 1)], {
          "TC-019": caseResult("passed"),
        }) as never;
      }
      throw new Error(`unexpected results root ${root}`);
    });

    const res = await request(app).get("/p1/gates/WU-040");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("passed");
    expect(testbenchStore.readPlanAndResults).toHaveBeenCalledWith(REPO, "alpha");
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

// A gate carrying a milestone (phase), so the overview can title its card by
// phase rather than by bare id (#433).
function gateWithMilestone(
  id: string,
  milestone: string,
  testCaseIds: string[],
  covers: string[] = [],
): VerifyUnit {
  return { ...gate(id, testCaseIds, covers), milestone };
}

describe("GET /:projectId/gates milestone + gatingCaseIds projection (#433)", () => {
  it("projects the gate's milestone and its full narrowed gatingCaseIds", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gateWithMilestone("WU-100", "Phase 1: Evaluator", ["TC-001", "TC-002"])),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-001", 1), planCase("TC-002", 1)], {
        "TC-001": caseResult("passed"),
        "TC-002": caseResult("passed"),
      }) as never,
    );
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    expect(res.body.gates[0]).toMatchObject({
      gateId: "WU-100",
      milestone: "Phase 1: Evaluator",
      status: "passed",
      // The full gating set is projected even on a passed gate, so the overview's
      // count traces to the same set the evaluator gates on.
      gatingCaseIds: ["TC-001", "TC-002"],
      blockedBy: [],
    });
  });

  it("projects milestone: null when the gate unit carries none (e.g. synthetic gate)", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-100", ["TC-001"])),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      planAndResults([planCase("TC-001", 1)], { "TC-001": caseResult("passed") }) as never,
    );
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    expect(res.body.gates[0].milestone).toBeNull();
  });

  it("narrows gatingCaseIds by the default policy (excludes L3/L4)", async () => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", gate("WU-100", ["TC-001", "TC-002"])),
    ]);
    vi.mocked(testbenchStore.readPlanAndResults).mockReturnValue(
      // TC-002 is L4: tracked but excluded from the gating set.
      planAndResults([planCase("TC-001", 1), planCase("TC-002", 4)], {
        "TC-001": caseResult("passed"),
        "TC-002": caseResult("not_started"),
      }) as never,
    );
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    expect(res.body.gates[0].gatingCaseIds).toEqual(["TC-001"]);
  });
});

describe("GET /:projectId/gates blockedBy derivation (#433, FR-001)", () => {
  // Two verify gates in one spec: the downstream gate's own depends_on names the
  // upstream gate, so the derivation resolves WU-GATE-1 as its upstream blocker.
  const upstream = gateWithTracker("WU-GATE-1", "o/r#10", ["TC-UP"]);
  const downstream: VerifyUnit = {
    ...gate("WU-GATE-2", ["TC-DOWN"], ["WU-D"]),
    depends_on: ["WU-GATE-1"],
  };

  beforeEach(() => {
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", upstream),
      loaded("alpha", downstream),
    ]);
    vi.mocked(workUnitLoader.loadAllUnitsForSlug).mockReturnValue([upstream, downstream] as never);
  });

  it("lists an upstream gate in blockedBy while it is not signed off", async () => {
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-UP", 1), planCase("TC-DOWN", 1)], {
          "TC-UP": caseResult("not_started"),
          "TC-DOWN": caseResult("not_started"),
        }) as never,
    );
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    const down = res.body.gates.find((g: { gateId: string }) => g.gateId === "WU-GATE-2");
    expect(down.blockedBy).toEqual(["WU-GATE-1"]);
    // The upstream gate has no upstream of its own.
    const up = res.body.gates.find((g: { gateId: string }) => g.gateId === "WU-GATE-1");
    expect(up.blockedBy).toEqual([]);
  });

  it("clears the upstream from blockedBy once it is signed off (AC2)", async () => {
    // Upstream passes and its tracker issue is closed -> signedOff true.
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-UP", 1), planCase("TC-DOWN", 1)], {
          "TC-UP": caseResult("passed"),
          "TC-DOWN": caseResult("not_started"),
        }) as never,
    );
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
      pluginId: "github-com",
      integrationId: "github-com",
      pageSize: 50,
    } as never);
    vi.mocked(pluginManager.invoke).mockResolvedValue({ currentState: "closed" } as never);

    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    const up = res.body.gates.find((g: { gateId: string }) => g.gateId === "WU-GATE-1");
    expect(up.signedOff).toBe(true);
    const down = res.body.gates.find((g: { gateId: string }) => g.gateId === "WU-GATE-2");
    // The upstream is signed off, so it no longer blocks the downstream phase.
    expect(down.blockedBy).toEqual([]);
  });

  it("derives an upstream blocker from a covered unit's depends_on (graph path)", async () => {
    // The downstream gate's own depends_on is empty; the blocker is reached through
    // a unit it covers (WU-D depends_on WU-GATE-1) via the local unit graph.
    const upstreamG = gate("WU-GATE-1", ["TC-UP"]);
    const downstreamG: VerifyUnit = { ...gate("WU-GATE-2", ["TC-DOWN"], ["WU-D"]), depends_on: [] };
    const coveredUnit = {
      id: "WU-D",
      title: "Delivery D",
      type: "feature",
      description: "",
      acceptance_criteria: [],
      depends_on: ["WU-GATE-1"],
      implements: { requirement_ids: [], user_story_ids: [], test_case_ids: [] },
    };
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", upstreamG),
      loaded("alpha", downstreamG),
    ]);
    vi.mocked(workUnitLoader.loadAllUnitsForSlug).mockReturnValue([
      upstreamG,
      downstreamG,
      coveredUnit,
    ] as never);
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-UP", 1), planCase("TC-DOWN", 1)], {
          "TC-UP": caseResult("not_started"),
          "TC-DOWN": caseResult("not_started"),
        }) as never,
    );
    const res = await request(app).get("/p1/gates");
    expect(res.status).toBe(200);
    const down = res.body.gates.find((g: { gateId: string }) => g.gateId === "WU-GATE-2");
    expect(down.blockedBy).toEqual(["WU-GATE-1"]);
  });
});

describe("GET /:projectId/gates/:gateId blockedBy uses sibling sign-off state (#433)", () => {
  it("carries the downstream gate's blockedBy from the sibling upstream gate", async () => {
    const upstream = gate("WU-GATE-1", ["TC-UP"]);
    const downstream: VerifyUnit = {
      ...gate("WU-GATE-2", ["TC-DOWN"]),
      depends_on: ["WU-GATE-1"],
    };
    vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue([
      loaded("alpha", upstream),
      loaded("alpha", downstream),
    ]);
    vi.mocked(workUnitLoader.loadAllUnitsForSlug).mockReturnValue([upstream, downstream] as never);
    vi.mocked(testbenchStore.readPlanAndResults).mockImplementation(
      () =>
        planAndResults([planCase("TC-UP", 1), planCase("TC-DOWN", 1)], {
          "TC-UP": caseResult("not_started"),
          "TC-DOWN": caseResult("not_started"),
        }) as never,
    );
    const res = await request(app).get("/p1/gates/WU-GATE-2");
    expect(res.status).toBe(200);
    expect(res.body.gateId).toBe("WU-GATE-2");
    expect(res.body.blockedBy).toEqual(["WU-GATE-1"]);
  });
});
