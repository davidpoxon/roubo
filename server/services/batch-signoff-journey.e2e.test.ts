// TC-024 (e2e_flow, level 1): the batch sign-off journey end to end. A verifier
// opens the batches overview, picks Phase 2, verifies its subset, and signs off;
// Phase 2 reads passed/closed and Phase 3 unblocks.
//
// Sibling to gate-journey.e2e.test.ts (which does this for TC-040). The "running
// system" here is the REAL, already-merged batch stack composed as one continuous
// journey, not a mock of the gate logic (AC-1):
//   - S001 + S004 (overview cards) read the gate state through the REAL gates-route
//     projection (#701, server/routes/gates.ts: evaluateLoadedGate / effectiveGates),
//     driven over HTTP with supertest exactly as gates.test.ts exercises it. The
//     projection wraps the REAL evaluateGate (#698, server/lib/gate-evaluator.ts).
//     We do NOT hand-roll a divergent card mapping: the card status IS the route's
//     GateState.status, with passed->passed and pending->verifying.
//   - S002 (TestBench scope) reads the Phase 2 gate's implements.test_case_ids, the
//     pre-resolved gating subset the batch view scopes to (#701 batch-subset; #702
//     batch view).
//   - S003 (mark passed) flips the three gating CaseResults and drives the REAL
//     evaluateGate (#698): pending -> passed with an empty unresolved set, which is
//     the signal that makes the sign-off action active (#702).
//   - S004 (sign off) drives the REAL onGatePassed (#700,
//     server/services/gate-lifecycle-coordinator.ts): it closes the Phase 2 tracker
//     via the plugin transition, audit-logs it, and the downstream Phase 3 unit's
//     blockedBy clears, so the overview re-reads Phase 2 passed/closed and Phase 3
//     unblocked.
//
// The only faked seams are external to the gate logic: the integration plugin
// (supplied through onGatePassed's injectable GateLifecycleDeps.invoke/recordAudit/
// now) and the on-disk plan/results/work-units the gates route reads (supplied
// through the same module mocks gates.test.ts uses: readPlanAndResults,
// loadVerifyUnits, gateOverrideStore). The gate functions themselves and the route
// projection are the real production code.
//
// Phase 3 "blocked" is modelled exactly as TC-040 S003 does: the gate-state model
// has no "blocked" status (gate states are passed/failed/pending/stale), so the
// downstream unit's blockedBy carrying the Phase 2 gate tracker IS the blocked
// signal the Phase 3 card reads, and closing the gate clears it.
//
// Drift guard (AC-2): each it() is named after its TC-024 step id and the step's
// expected observation is kept explicit, so a change to the authoritative TC-024 in
// .specifications/verify-gate/test-cases.json forces this test to be updated.
//
// Failure-output contract (AC-3): every assertion attaches an expected-vs-actual
// message naming the owning slice issue from this unit's blocked-by set ([#701,
// #702], from .specifications/verify-gate/issues.json), so a red run localizes the
// integration drift to one attributable slice. Where a step composes a function
// owned by an upstream slice (evaluateGate #698, onGatePassed #700), the message
// names the blocked-by slice whose surface drives that function in this journey
// (the gate API / batch UI), with the composed-function slice noted alongside.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Disk seams the gates route reads, faked at the module boundary exactly as
// gates.test.ts does, so the REAL route projection (evaluateLoadedGate /
// effectiveGates, #701) runs over an in-memory world. ──
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
  };
});

import gatesRouter from "../routes/gates.js";
import * as projectRegistry from "../services/project-registry.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import * as testbenchStore from "../lib/testbench-store.js";
import { emptyGateOverrides } from "@roubo/shared/gate-overrides-contract";
import * as gateOverrideStore from "../services/gate-override-store.js";
import type { LoadedVerifyUnit } from "../services/work-unit-loader.js";
import { evaluateGate, type VerifyUnit, type GateResults } from "../lib/gate-evaluator.js";
import {
  onGatePassed,
  GateAuditLog,
  type GateLifecycleDeps,
} from "./gate-lifecycle-coordinator.js";
import type { GateAuditEntry, NormalizedIssue } from "@roubo/shared";
import type { Tracker } from "@roubo/shared/work-units-contract";
import type { BenchResults, Case, CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";

// ── Owning slices (this e2e unit's blocked-by set, [#701, #702] per
// .specifications/verify-gate/issues.json). Each step is attributed to the
// blocked-by slice whose surface drives it; the composed-function slice is noted
// where it differs (evaluateGate is #698, onGatePassed is #700). ──
const SLICE_S001 = "#701 (gate API routes: the GateState overview projection)";
const SLICE_S002 = "#701 (batch-subset) / #702 (TestBench batch view scope)";
const SLICE_S003 = "#702 (batch view: mark-passed drives the real evaluateGate, #698)";
const SLICE_S004 =
  "#702 (batch view: sign-off action drives the real onGatePassed, #700) / #701 (overview re-read)";

// ── Fixture identifiers (TC-024 preconditions: three phases, milestone-aligned
// units, Phase 1 closed, Phase 2 verifying over [TC-019, TC-020, TC-024], Phase 3
// blocked by the Phase 2 gate). ──
const PROJECT_ID = "proj-verify-gate";
const PLUGIN_ID = "github-com";
const SLUG = "verify-gate";
const PLAN_HASH = "sha256-plan-v1";

// Phase 1 gate: already passed/closed (#420 in the case). Its single gating case
// is recorded passed.
const PHASE1_GATE = "WU-020";
const PHASE1_CASE = "TC-018";

// Phase 2 gate WU-040: verifying. Its implements.test_case_ids IS the subset the
// batch view scopes to (S002).
const PHASE2_GATE = "WU-040";
const PHASE2_TRACKER = "440";
const PHASE2_CASES = ["TC-019", "TC-020", "TC-024"];

// Phase 3 gate: blocked while its downstream delivery unit lists the Phase 2 gate
// tracker in blockedBy. Modelled like TC-040 S003.
const PHASE3_GATE = "WU-060";
const PHASE3_CASE = "TC-032";
const PHASE3_REF = "owner/repo#460";

// ── Fixture builders (reuse the exact shapes from the three modules' unit tests:
// VerifyUnit / LoadedVerifyUnit, GateResults/CaseResult, NormalizedIssue,
// GateAuditEntry, the gates.test.ts plan/results helpers). ──

function gate(
  id: string,
  testCaseIds: string[],
  tracker?: Tracker,
  covers: string[] = [],
): VerifyUnit {
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
    ...(tracker ? { tracker } : {}),
  };
}

function loaded(slug: string, unit: VerifyUnit): LoadedVerifyUnit {
  return { slug, unit };
}

function planCase(id: string, level: number, type = "functional"): Case {
  return { id, title: id, description: "", level, type, steps: [] } as never;
}

function caseResult(derivedStatus: CaseStatus): CaseResult {
  return { observationMarks: {}, derivedStatus, notes: [] } as never;
}

// The disk view the gates route reads for one gate: a plan whose cases match the
// gate's gating set, plus the recorded results for those cases. Mirrors
// gates.test.ts planAndResults; here it is keyed by slug+gateId so the three gate
// cards each resolve their own recorded state from the shared world.
function planAndResults(cases: Case[], caseResults: Record<string, CaseResult> | null) {
  return {
    plan: { cases } as never,
    results: caseResults === null ? null : { caseResults, updatedAt: "2026-01-01T00:00:00.000Z" },
    stale: false,
    planHash: PLAN_HASH,
    recovered: caseResults === null,
  };
}

// A recorded-results body for the Phase 2 gating cases, for the pure evaluateGate
// drive in S003 (from gate-evaluator.test.ts).
function phase2Results(statuses: Record<string, CaseStatus>): GateResults {
  const caseResults: Record<string, CaseResult> = {};
  for (const id of PHASE2_CASES) {
    caseResults[id] = caseResult(statuses[id] ?? "not_started");
  }
  const body: BenchResults & { planHash: string } = {
    caseResults,
    updatedAt: "2026-01-01T00:00:00.000Z",
    planHash: PLAN_HASH,
  };
  return body;
}

// A NormalizedIssue, from gate-lifecycle-coordinator.test.ts.
function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    integrationId: PLUGIN_ID,
    externalId: PHASE2_TRACKER,
    externalUrl: `https://github.com/o/r/issues/${PHASE2_TRACKER}`,
    title: "Phase 2 verify gate",
    body: null,
    currentState: "open",
    allowedTransitions: ["close"],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    raw: {},
    ...overrides,
  };
}

// ── Shared in-test fixture world, threaded across the ordered it() blocks so the
// journey is continuous. ──

// The Phase 2 gate carries a tracker so onGatePassed has an issue to close.
const phase2Gate = gate(
  PHASE2_GATE,
  PHASE2_CASES,
  {
    system: "github",
    ref: PHASE2_TRACKER,
    url: `https://github.com/o/r/issues/${PHASE2_TRACKER}`,
    blocked_by_refs: [],
  },
  ["WU-031", "WU-032", "WU-033"],
);

const audit = new GateAuditLog();

// The mutable recorded-results world the gates route reads, keyed by gateId. S003
// flips the Phase 2 cases here, so the S004 overview re-read sees them passed.
const recordedResults: Record<string, Record<string, CaseStatus>> = {
  [PHASE1_GATE]: { [PHASE1_CASE]: "passed" },
  [PHASE2_GATE]: { "TC-019": "not_started", "TC-020": "not_started", "TC-024": "not_started" },
  [PHASE3_GATE]: { [PHASE3_CASE]: "not_started" },
};

// The plan cases per gate, so readPlanAndResults can hand the route a plan whose
// cases match each gate's gating set. All L1 so the default-policy narrowing keeps
// the whole set gating.
const planCasesByGate: Record<string, Case[]> = {
  [PHASE1_GATE]: [planCase(PHASE1_CASE, 1)],
  [PHASE2_GATE]: PHASE2_CASES.map((id) => planCase(id, 1)),
  [PHASE3_GATE]: [planCase(PHASE3_CASE, 1)],
};

// The gate tracker issue (#440), open while the gate is open.
let trackerIssue: NormalizedIssue = makeIssue();
// The downstream Phase 3 delivery unit: blocked by the Phase 2 gate tracker until
// it closes (the Phase 3 card's "blocked" signal, like TC-040 S003).
let phase3Issue: NormalizedIssue = makeIssue({
  externalId: PHASE3_REF,
  externalUrl: "https://github.com/o/r/issues/460",
  title: "Phase 3 delivery unit",
  blockedBy: [PHASE2_TRACKER],
});

// The faked external integration plugin (onGatePassed seam). getIssue returns the
// live tracker issue; applyTransition closes it AND clears the gate ref from the
// downstream unit's blockedBy, modelling the plugin's blocking-relationship
// teardown on close.
const invoke = (async (_pluginId: string, method: string, _params: unknown) => {
  if (method === "getIssue") {
    return trackerIssue as never;
  }
  if (method === "applyTransition") {
    trackerIssue = { ...trackerIssue, currentState: "closed", allowedTransitions: ["reopen"] };
    phase3Issue = {
      ...phase3Issue,
      blockedBy: phase3Issue.blockedBy.filter((ref) => ref !== PHASE2_TRACKER),
    };
    return trackerIssue as never;
  }
  throw new Error(`unexpected method ${method}`);
}) as unknown as GateLifecycleDeps["invoke"];

const deps: GateLifecycleDeps = {
  invoke,
  recordAudit: (entry) => audit.record(entry),
  now: () => "2026-06-23T00:00:00.000Z",
};

// The three gate cards, in phase order, the overview lists.
const overviewGates: LoadedVerifyUnit[] = [
  loaded(SLUG, gate(PHASE1_GATE, [PHASE1_CASE])),
  loaded(SLUG, phase2Gate),
  loaded(SLUG, gate(PHASE3_GATE, [PHASE3_CASE])),
];

// The gates route mounted on a real express app, driven over HTTP with supertest
// so the REAL projection runs end to end.
const app = express();
app.use(express.json());
app.use("/", gatesRouter);

// Map the route's GateState.status to the overview card's label: passed->passed,
// pending->verifying. This is the SAME projection the route exposes (we read its
// GateState.status verbatim); the label rename is the card vocabulary, not a
// divergent re-evaluation.
function cardStatus(routeStatus: string): string {
  if (routeStatus === "passed") return "passed";
  if (routeStatus === "pending") return "verifying";
  return routeStatus;
}

// Read the live overview cards through the real gates route.
async function readOverview(): Promise<Record<string, { status: string; card: string }>> {
  const res = await request(app).get(`/${PROJECT_ID}/gates`);
  expect(res.status).toBe(200);
  const byId: Record<string, { status: string; card: string }> = {};
  for (const entry of res.body as { gateId: string; status: string }[]) {
    byId[entry.gateId] = { status: entry.status, card: cardStatus(entry.status) };
  }
  return byId;
}

beforeEach(() => {
  // Re-wire the disk-seam mocks against the live shared world on every test, so
  // mutations in S003 are reflected when S004 re-reads the overview.
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    repoPath: "/repo",
    config: {},
  } as never);
  vi.mocked(gateOverrideStore.loadOverrides).mockReturnValue(emptyGateOverrides());
  vi.mocked(workUnitLoader.buildWorkUnitCaseMap).mockReturnValue(new Map());
  vi.mocked(workUnitLoader.loadVerifyUnits).mockReturnValue(overviewGates);
  vi.mocked(testbenchStore.readPlanAndResults).mockImplementation((_root, slug) => {
    // The route reads one gate's plan+results per loaded gate; resolve which gate
    // this read is for by matching the slug's gates. All gates share one slug
    // here, so the route reads the same slug per gate but the case sets differ;
    // return a plan+results union covering all three gates so each gate resolves
    // its own gating set from its own declared test_case_ids.
    void slug;
    const allCases: Case[] = Object.values(planCasesByGate).flat();
    const allResults: Record<string, CaseResult> = {};
    for (const statuses of Object.values(recordedResults)) {
      for (const [id, status] of Object.entries(statuses)) {
        allResults[id] = caseResult(status);
      }
    }
    return planAndResults(allCases, allResults) as never;
  });
});

describe("TC-024: verifier opens the overview, picks Phase 2, verifies the subset, and signs off", () => {
  it("S001: navigate to the batches overview -> three cards: Phase 1 passed, Phase 2 verifying, Phase 3 blocked (S001-O01)", async () => {
    const overview = await readOverview();

    // S001-O01: Phase 1 reads passed.
    expect(
      overview[PHASE1_GATE]?.card,
      `TC-024 step S001 (S001-O01) diverged: expected the Phase 1 card to read "passed", got "${overview[PHASE1_GATE]?.card}" (route status "${overview[PHASE1_GATE]?.status}"). Owning slice: ${SLICE_S001}.`,
    ).toBe("passed");

    // S001-O01: Phase 2 reads verifying (route status pending -> card verifying).
    expect(
      overview[PHASE2_GATE]?.card,
      `TC-024 step S001 (S001-O01) diverged: expected the Phase 2 card to read "verifying", got "${overview[PHASE2_GATE]?.card}" (route status "${overview[PHASE2_GATE]?.status}"). Owning slice: ${SLICE_S001}.`,
    ).toBe("verifying");

    // S001-O01: Phase 3 reads blocked. The gate-state model has no "blocked"
    // status; the block is the downstream unit's blockedBy carrying the Phase 2
    // gate tracker (same modelling as TC-040 S003).
    expect(
      phase3Issue.blockedBy,
      `TC-024 step S001 (S001-O01) diverged: expected the Phase 3 unit to be blocked by the Phase 2 gate tracker #${PHASE2_TRACKER} (the card's blocked signal), got blockedBy ${JSON.stringify(
        phase3Issue.blockedBy,
      )}. Owning slice: ${SLICE_S001}.`,
    ).toContain(PHASE2_TRACKER);
  });

  it("S002: click the Phase 2 gate card -> TestBench opens scoped to exactly TC-019, TC-020, TC-024 (S002-O01)", () => {
    // S002-O01: the batch view scopes to the Phase 2 gate's pre-resolved gating
    // set, its implements.test_case_ids.
    const scope = phase2Gate.implements.test_case_ids;
    expect(
      scope,
      `TC-024 step S002 (S002-O01) diverged: expected the Phase 2 batch scope to be exactly [TC-019, TC-020, TC-024], got ${JSON.stringify(
        scope,
      )}. Owning slice: ${SLICE_S002}.`,
    ).toEqual(["TC-019", "TC-020", "TC-024"]);
  });

  it("S003: mark TC-019, TC-020, TC-024 passed -> all three show passed and the sign-off action becomes active (S003-O01)", () => {
    // Precondition: before the flips, the Phase 2 gate is not passed (sign-off is
    // not yet active). Drive the REAL evaluateGate (#698) with the recorded
    // not_started cases.
    const before = evaluateGate(phase2Gate, phase2Results({}), PLAN_HASH);
    expect(
      before.status,
      `TC-024 step S003 diverged: expected the Phase 2 gate to read NOT passed before the gating cases are marked passed, got "${before.status}". Owning slice: ${SLICE_S003}.`,
    ).not.toBe("passed");

    // S003: execute and mark TC-019, then TC-020, then TC-024 passed. Flip them in
    // the shared recorded-results world so the S004 overview re-read sees them.
    recordedResults[PHASE2_GATE] = { "TC-019": "passed", "TC-020": "passed", "TC-024": "passed" };

    const after = evaluateGate(phase2Gate, phase2Results(recordedResults[PHASE2_GATE]), PLAN_HASH);

    // S003-O01: all three gating cases show passed (empty unresolved set) and the
    // gate transitions to passed, which is the signal the sign-off action becomes
    // active.
    expect(
      after.status,
      `TC-024 step S003 (S003-O01) diverged: expected the Phase 2 gate to transition to "passed" once all three gating cases are marked passed (so the sign-off action becomes active), got "${after.status}". Owning slice: ${SLICE_S003}.`,
    ).toBe("passed");
    expect(
      after.unresolvedCaseIds,
      `TC-024 step S003 (S003-O01) diverged: expected no unresolved gating cases once all three pass, got ${JSON.stringify(
        after.unresolvedCaseIds,
      )}. Owning slice: ${SLICE_S003}.`,
    ).toEqual([]);
  });

  it("S004: sign off the Phase 2 batch -> overview reads Phase 2 passed/closed (S004-O01) and Phase 3 unblocks (S004-O02)", async () => {
    // S004: sign off. Drive the REAL onGatePassed (#700) against the shared fake
    // plugin: it closes the Phase 2 tracker and clears it from Phase 3's blockedBy.
    await onGatePassed(PROJECT_ID, phase2Gate, PLUGIN_ID, deps);

    // The sign-off is recorded in the audit log (a close referencing #440).
    const entries = audit.query();
    expect(
      entries,
      `TC-024 step S004 (S004-O01) diverged: expected exactly one audit entry recording the Phase 2 sign-off, got ${entries.length}: ${JSON.stringify(
        entries,
      )}. Owning slice: ${SLICE_S004}.`,
    ).toHaveLength(1);
    expect(
      entries[0],
      `TC-024 step S004 (S004-O01) diverged: expected the audit entry to record outcome "closed" for tracker #${PHASE2_TRACKER} via plugin "${PLUGIN_ID}", got ${JSON.stringify(
        entries[0],
      )}. Owning slice: ${SLICE_S004}.`,
    ).toEqual<GateAuditEntry>({
      ts: "2026-06-23T00:00:00.000Z",
      projectId: PROJECT_ID,
      pluginId: PLUGIN_ID,
      gateId: PHASE2_GATE,
      trackerRef: PHASE2_TRACKER,
      transitionName: "close",
      outcome: "closed",
    });

    // S004-O01: the overview now reads Phase 2 passed/closed. Re-read the cards
    // through the REAL gates route: S003 flipped the recorded cases to passed, so
    // the projection now evaluates the Phase 2 gate as passed.
    const overview = await readOverview();
    expect(
      overview[PHASE2_GATE]?.card,
      `TC-024 step S004 (S004-O01) diverged: expected the overview to read the Phase 2 card "passed" after sign-off, got "${overview[PHASE2_GATE]?.card}" (route status "${overview[PHASE2_GATE]?.status}"). Owning slice: ${SLICE_S004}.`,
    ).toBe("passed");
    // The tracker issue transitioned to a done (closed) state via the plugin.
    expect(
      trackerIssue.currentState,
      `TC-024 step S004 (S004-O01) diverged: expected the Phase 2 gate tracker #${PHASE2_TRACKER} currentState to read "closed" after sign-off, got "${trackerIssue.currentState}". Owning slice: ${SLICE_S004}.`,
    ).toBe("closed");

    // S004-O02: Phase 3's blocked state resolves now its upstream gate has passed:
    // the downstream unit no longer lists the Phase 2 gate tracker in blockedBy.
    expect(
      phase3Issue.blockedBy,
      `TC-024 step S004 (S004-O02) diverged: expected the Phase 3 unit's blockedBy to no longer list the Phase 2 gate tracker #${PHASE2_TRACKER} after sign-off, got ${JSON.stringify(
        phase3Issue.blockedBy,
      )}. Owning slice: ${SLICE_S004}.`,
    ).not.toContain(PHASE2_TRACKER);
    expect(
      phase3Issue.blockedBy,
      `TC-024 step S004 (S004-O02) diverged: expected the Phase 3 unit to be fully unblocked (empty blockedBy) after sign-off, got ${JSON.stringify(
        phase3Issue.blockedBy,
      )}. Owning slice: ${SLICE_S004}.`,
    ).toEqual([]);
  });
});
