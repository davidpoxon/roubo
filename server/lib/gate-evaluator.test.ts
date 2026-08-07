import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  type VerifyUnit,
  type GateResults,
  type GateLifecycle,
} from "./gate-evaluator.js";
// The real resolver the evaluator's lifecycle input is produced by (#766), driven
// here rather than stubbed so the gate and the authoring-time picker are shown to
// resolve a pointer through the same code (#768).
import { collectReferencedSlugs, resolvePlan } from "@roubo/shared/lifecycle-resolver";
import type { ResolverPlan, ResolverSpecLifecycle } from "@roubo/shared/lifecycle-resolver";
import type {
  BenchResults,
  CaseResult,
  CaseStatus,
  StatusOverride,
  TestCasesPlan,
  Case,
} from "@roubo/shared/testbench-contracts";
import { TEST_CASES_SCHEMA_ID, TEST_CASES_SCHEMA_VERSION } from "@roubo/shared/testbench-contracts";
// The real hash the store records and the gate compares against, so the
// lifecycle carve-out is exercised end to end rather than through a stand-in
// string (#767).
import { computePlanHash } from "./testbench-store.js";

// ── Builders (keep the table rows terse and intention-revealing) ──

const PLAN_HASH = "sha256-plan-v1";

function makeGate(testCaseIds: string[], covers: string[] = []): VerifyUnit {
  return {
    id: "WU-100",
    title: "Verify batch A",
    type: "task",
    kind: "verify",
    description: "Gate over batch A",
    acceptance_criteria: [],
    depends_on: [],
    covers,
    implements: {
      requirement_ids: [],
      user_story_ids: [],
      test_case_ids: testCaseIds,
    },
  };
}

const author = { name: "Ada", email: "ada@example.com" };

function override(status: CaseStatus): StatusOverride {
  return { status, author, timestamp: "2026-01-01T00:00:00.000Z" };
}

function caseResult(
  derivedStatus: CaseStatus,
  opts: { override?: CaseStatus; orphaned?: true } = {},
): CaseResult {
  const result: CaseResult = {
    observationMarks: {},
    derivedStatus,
    notes: [],
  };
  if (opts.override) result.statusOverride = override(opts.override);
  if (opts.orphaned) result.orphaned = true;
  return result;
}

function results(
  caseResults: Record<string, CaseResult>,
  planHash: string = PLAN_HASH,
): GateResults {
  const body: BenchResults & { planHash: string } = {
    caseResults,
    updatedAt: "2026-01-01T00:00:00.000Z",
    planHash,
  };
  return body;
}

function planCase(id: string, level: number, type: string): Case {
  return {
    id,
    title: id,
    area: "gate",
    level: level as 1 | 2 | 3 | 4,
    type,
    steps: [],
    tags: [],
    linked_requirement_ids: ["FR-004"],
    linked_user_story_ids: [],
  };
}

function plan(cases: Case[]): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: TEST_CASES_SCHEMA_VERSION,
    specSlug: "verify-gate",
    cases,
  };
}

describe("evaluateGate: status truth table (VG-TC-009..VG-TC-013, VG-FR-004)", () => {
  // Each row: a gating set of one case in a given effective status, and the gate
  // status the precedence ladder must yield.
  const rows: Array<{
    name: string;
    derived: CaseStatus;
    expected: "passed" | "failed" | "pending";
  }> = [
    { name: "passed -> passed", derived: "passed", expected: "passed" },
    { name: "failed -> failed", derived: "failed", expected: "failed" },
    { name: "blocked -> failed", derived: "blocked", expected: "failed" },
    { name: "not_started -> pending", derived: "not_started", expected: "pending" },
    { name: "in_progress -> pending", derived: "in_progress", expected: "pending" },
  ];

  for (const row of rows) {
    it(`single gating case ${row.name}`, () => {
      const gate = makeGate(["TC-1"]);
      const state = evaluateGate(gate, results({ "TC-1": caseResult(row.derived) }), PLAN_HASH);
      expect(state.status).toBe(row.expected);
      if (row.expected === "passed") {
        expect(state.unresolvedCaseIds).toEqual([]);
      } else {
        expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
      }
    });
  }

  it("FAILED wins over PENDING when both are present (precedence)", () => {
    const gate = makeGate(["TC-1", "TC-2"]);
    const state = evaluateGate(
      gate,
      results({
        "TC-1": caseResult("in_progress"),
        "TC-2": caseResult("failed"),
      }),
      PLAN_HASH,
    );
    expect(state.status).toBe("failed");
    // Both unresolved cases are reported regardless of which rung fires.
    expect(state.unresolvedCaseIds.sort()).toEqual(["TC-1", "TC-2"]);
  });

  it("PASSED only when EVERY gating case is passed (VG-TC-009)", () => {
    const gate = makeGate(["TC-1", "TC-2", "TC-3"]);
    const state = evaluateGate(
      gate,
      results({
        "TC-1": caseResult("passed"),
        "TC-2": caseResult("passed"),
        "TC-3": caseResult("passed"),
      }),
      PLAN_HASH,
    );
    expect(state.status).toBe("passed");
    expect(state.unresolvedCaseIds).toEqual([]);
    expect(state.coveringUnitIds).toEqual([]);
  });
});

describe("evaluateGate: effective status / override (VG-TC-014, VG-FR-005)", () => {
  it("override is honoured over derivedStatus (override passed beats derived failed)", () => {
    const gate = makeGate(["TC-1"]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("failed", { override: "passed" }) }),
      PLAN_HASH,
    );
    expect(state.status).toBe("passed");
  });

  it("override can fail a derived-passed case (override failed beats derived passed)", () => {
    const gate = makeGate(["TC-1"]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed", { override: "failed" }) }),
      PLAN_HASH,
    );
    expect(state.status).toBe("failed");
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
  });
});

describe("evaluateGate: never false-pass (VG-TC-015..VG-TC-017, VG-NFR-007)", () => {
  it("an absent gating case reads as pending, never passed (VG-TC-015)", () => {
    const gate = makeGate(["TC-1", "TC-2"]);
    // TC-2 has no recorded result.
    const state = evaluateGate(gate, results({ "TC-1": caseResult("passed") }), PLAN_HASH);
    expect(state.status).toBe("pending");
    expect(state.unresolvedCaseIds).toEqual(["TC-2"]);
  });

  it("an orphaned gating case reads as pending, never passed (VG-TC-016)", () => {
    const gate = makeGate(["TC-1"]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed", { orphaned: true }) }),
      PLAN_HASH,
    );
    expect(state.status).toBe("pending");
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
  });

  it("a planHash mismatch reads as stale, never passed (VG-TC-017)", () => {
    const gate = makeGate(["TC-1"]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed") }, "sha256-plan-v2-stale"),
      PLAN_HASH,
    );
    expect(state.status).toBe("stale");
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
  });

  it("absent results (null) read as stale, never passed", () => {
    const gate = makeGate(["TC-1"]);
    const state = evaluateGate(gate, null, PLAN_HASH);
    expect(state.status).toBe("stale");
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
  });
});

// #767 (SATCA-FR-022, SATCA-TC-055): the gate's staleness rung is exactly
// `results.planHash !== currentPlanHash`, and the plan hash excludes the v1.2.0
// lifecycle block (#764), so a lifecycle-only edit cannot move a gate to stale.
// The negative control keeps VG-NFR-007 fail-closed honest: a genuine content
// edit still reads as stale, never as passed.
describe("evaluateGate: a lifecycle-only plan edit never moves a gate to stale (#767)", () => {
  function gatingCase(id: string, expected: string): Case {
    return {
      ...planCase(id, 1, "e2e_flow"),
      steps: [{ id: "S1", instruction: "do the thing", observations: [{ id: "O1", expected }] }],
    };
  }

  const live = plan([gatingCase("TC-1", "obs one")]);
  // The hash recorded on the results, computed against the pre-lifecycle plan.
  const recordedHash = computePlanHash(live);

  it("keeps a passed gate passed after its case is retired or superseded", () => {
    const retired = plan([
      { ...gatingCase("TC-1", "obs one"), lifecycle: { state: "retired", reason: "Obsolete" } },
    ]);
    const superseded = plan([
      {
        ...gatingCase("TC-1", "obs one"),
        lifecycle: { state: "superseded", replacement: "TC-2" },
      },
    ]);

    const gate = makeGate(["TC-1"]);
    const recorded = results({ "TC-1": caseResult("passed") }, recordedHash);

    for (const edited of [retired, superseded]) {
      const state = evaluateGate(gate, recorded, computePlanHash(edited), edited);
      expect(state.status).toBe("passed");
      expect(state.unresolvedCaseIds).toEqual([]);
    }
  });

  it("still reads as stale after a live case's steps are edited", () => {
    const edited = plan([gatingCase("TC-1", "reworded obs one")]);
    const gate = makeGate(["TC-1"]);
    const recorded = results({ "TC-1": caseResult("passed") }, recordedHash);

    const state = evaluateGate(gate, recorded, computePlanHash(edited), edited);
    expect(state.status).toBe("stale");
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
  });
});

describe("evaluateGate: default gating policy L1/L2 + e2e_flow (VG-TC-018, VG-FR-005)", () => {
  // L3 and L4 cases are excluded even when failing, so they never block the gate.
  it("excludes L3/L4 cases from the gating set when a plan is threaded", () => {
    const gate = makeGate(["TC-L1", "TC-L2", "TC-L3", "TC-L4"]);
    const p = plan([
      planCase("TC-L1", 1, "functional"),
      planCase("TC-L2", 2, "functional"),
      planCase("TC-L3", 3, "functional"),
      planCase("TC-L4", 4, "functional"),
    ]);
    const state = evaluateGate(
      gate,
      results({
        "TC-L1": caseResult("passed"),
        "TC-L2": caseResult("passed"),
        // L3/L4 are failing but must be ignored by the default policy.
        "TC-L3": caseResult("failed"),
        "TC-L4": caseResult("failed"),
      }),
      PLAN_HASH,
      p,
    );
    expect(state.status).toBe("passed");
    expect(state.unresolvedCaseIds).toEqual([]);
  });

  it("includes an e2e_flow case regardless of its level", () => {
    const gate = makeGate(["TC-E2E"]);
    const p = plan([planCase("TC-E2E", 4, "e2e_flow")]);
    const state = evaluateGate(gate, results({ "TC-E2E": caseResult("failed") }), PLAN_HASH, p);
    expect(state.status).toBe("failed");
    expect(state.unresolvedCaseIds).toEqual(["TC-E2E"]);
  });

  it("a declared id missing from the plan stays in the gating set (never silently dropped)", () => {
    const gate = makeGate(["TC-1", "TC-UNKNOWN"]);
    const p = plan([planCase("TC-1", 1, "functional")]);
    const state = evaluateGate(gate, results({ "TC-1": caseResult("passed") }), PLAN_HASH, p);
    // TC-UNKNOWN cannot be level-classified, so it remains gating and reads
    // pending (absent from results).
    expect(state.status).toBe("pending");
    expect(state.unresolvedCaseIds).toEqual(["TC-UNKNOWN"]);
  });

  it("without a plan, implements.test_case_ids is used verbatim (no narrowing)", () => {
    const gate = makeGate(["TC-L3"]);
    // No plan threaded: the declared set is the gating set, so an L3 case still
    // gates here. (The plan-aware narrowing is the caller's opt-in.)
    const state = evaluateGate(gate, results({ "TC-L3": caseResult("failed") }), PLAN_HASH);
    expect(state.status).toBe("failed");
  });
});

describe("evaluateGate: empty narrowed gating set reads as no_gating_cases (VG-TC-026, #436, VG-NFR-007)", () => {
  it("an all-L3/L4 gate with a plan narrows to no_gating_cases, never passed", () => {
    const gate = makeGate(["TC-L3", "TC-L4"], ["WU-10"]);
    const p = plan([planCase("TC-L3", 3, "functional"), planCase("TC-L4", 4, "functional")]);
    const state = evaluateGate(
      gate,
      results({
        // Even though every declared case is passed, they all narrow out of the
        // default policy, so the gate has nothing to gate on: it must NOT read as
        // a vacuous pass (the #436 bug).
        "TC-L3": caseResult("passed"),
        "TC-L4": caseResult("passed"),
      }),
      PLAN_HASH,
      p,
    );
    expect(state.status).toBe("no_gating_cases");
    expect(state.unresolvedCaseIds).toEqual([]);
    expect(state.coveringUnitIds).toEqual([]);
  });

  it("the empty-gating-set guard precedes the STALE rung (null results still read as no_gating_cases)", () => {
    // A gate whose narrowed set is empty AND has no recorded results must read as
    // no_gating_cases, not stale: an empty gating set is a structural fact
    // independent of results, so the guard fires before the results-driven ladder.
    const gate = makeGate(["TC-L3"], ["WU-10"]);
    const p = plan([planCase("TC-L3", 3, "functional")]);
    const state = evaluateGate(gate, null, PLAN_HASH, p);
    expect(state.status).toBe("no_gating_cases");
    expect(state.unresolvedCaseIds).toEqual([]);
    expect(state.coveringUnitIds).toEqual([]);
  });

  it("a gate declaring no cases at all reads as no_gating_cases even without a plan", () => {
    const gate = makeGate([], ["WU-10"]);
    const state = evaluateGate(gate, results({}), PLAN_HASH);
    expect(state.status).toBe("no_gating_cases");
    expect(state.unresolvedCaseIds).toEqual([]);
    expect(state.coveringUnitIds).toEqual([]);
  });
});

describe("evaluateGate: coveringUnitIds derivation (VG-NFR-004)", () => {
  it("surfaces covers for unresolved cases", () => {
    const gate = makeGate(["TC-1"], ["WU-10", "WU-11"]);
    const state = evaluateGate(gate, results({ "TC-1": caseResult("failed") }), PLAN_HASH);
    expect(state.coveringUnitIds).toEqual(["WU-10", "WU-11"]);
  });

  it("is empty when the gate is passed", () => {
    const gate = makeGate(["TC-1"], ["WU-10"]);
    const state = evaluateGate(gate, results({ "TC-1": caseResult("passed") }), PLAN_HASH);
    expect(state.coveringUnitIds).toEqual([]);
  });

  it("surfaces covers for a stale gate with a non-empty gating set", () => {
    const gate = makeGate(["TC-1"], ["WU-10"]);
    const state = evaluateGate(gate, null, PLAN_HASH);
    expect(state.status).toBe("stale");
    expect(state.coveringUnitIds).toEqual(["WU-10"]);
  });
});

describe("evaluateGate: gatingCaseIds is the full narrowed gating set (issue #433)", () => {
  // Unlike unresolvedCaseIds, gatingCaseIds is populated in EVERY rung (including
  // passed) so the overview's "N gating cases" count traces to the same set the
  // evaluator gates on.
  it("populates gatingCaseIds on a passed gate (count survives even with nothing unresolved)", () => {
    const gate = makeGate(["TC-1", "TC-2"]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed"), "TC-2": caseResult("passed") }),
      PLAN_HASH,
    );
    expect(state.status).toBe("passed");
    expect(state.unresolvedCaseIds).toEqual([]);
    expect(state.gatingCaseIds).toEqual(["TC-1", "TC-2"]);
  });

  it("populates gatingCaseIds on a failed gate", () => {
    const gate = makeGate(["TC-1", "TC-2"]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("failed"), "TC-2": caseResult("passed") }),
      PLAN_HASH,
    );
    expect(state.status).toBe("failed");
    expect(state.gatingCaseIds).toEqual(["TC-1", "TC-2"]);
  });

  it("populates gatingCaseIds on a pending gate", () => {
    const gate = makeGate(["TC-1", "TC-2"]);
    const state = evaluateGate(gate, results({ "TC-1": caseResult("passed") }), PLAN_HASH);
    expect(state.status).toBe("pending");
    expect(state.gatingCaseIds).toEqual(["TC-1", "TC-2"]);
  });

  it("populates gatingCaseIds on a stale gate (null results)", () => {
    const gate = makeGate(["TC-1", "TC-2"]);
    const state = evaluateGate(gate, null, PLAN_HASH);
    expect(state.status).toBe("stale");
    expect(state.gatingCaseIds).toEqual(["TC-1", "TC-2"]);
  });

  it("reflects the L3/L4 narrowing (excludes non-gating cases) when a plan is threaded", () => {
    const gate = makeGate(["TC-L1", "TC-L2", "TC-L3", "TC-L4"]);
    const p = plan([
      planCase("TC-L1", 1, "functional"),
      planCase("TC-L2", 2, "functional"),
      planCase("TC-L3", 3, "functional"),
      planCase("TC-L4", 4, "functional"),
    ]);
    const state = evaluateGate(
      gate,
      results({
        "TC-L1": caseResult("passed"),
        "TC-L2": caseResult("passed"),
        "TC-L3": caseResult("failed"),
        "TC-L4": caseResult("failed"),
      }),
      PLAN_HASH,
      p,
    );
    expect(state.status).toBe("passed");
    expect(state.gatingCaseIds).toEqual(["TC-L1", "TC-L2"]);
  });
});

describe("evaluateGate: purity and idempotence (VG-TC-018, VG-NFR-007)", () => {
  it("identical inputs yield a deep-equal GateState", () => {
    const gate = makeGate(["TC-1", "TC-2"], ["WU-10"]);
    const r = results({
      "TC-1": caseResult("passed"),
      "TC-2": caseResult("in_progress"),
    });
    const a = evaluateGate(gate, r, PLAN_HASH);
    const b = evaluateGate(gate, r, PLAN_HASH);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("does not mutate its inputs", () => {
    const gate = makeGate(["TC-1", "TC-2"], ["WU-10"]);
    const r = results({
      "TC-1": caseResult("passed"),
      "TC-2": caseResult("failed"),
    });
    const gateSnapshot = structuredClone(gate);
    const resultsSnapshot = structuredClone(r);
    evaluateGate(gate, r, PLAN_HASH);
    expect(gate).toEqual(gateSnapshot);
    expect(r).toEqual(resultsSnapshot);
  });
});

// ── #768 lifecycle builders (SATCA-FR-008..SATCA-FR-012) ──
//
// The evaluator consumes a resolution, never a raw lifecycle block, so these
// builders drive the REAL `resolvePlan` from @roubo/shared/lifecycle-resolver
// rather than hand-writing Resolution literals. That keeps these tests honest
// about the one thing the architecture insists on: the gate and the authoring-time
// picker resolve a pointer through the same code.

function retired(testCase: Case, reason = "superseded by a broader scenario"): Case {
  return { ...testCase, lifecycle: { state: "retired", reason } };
}

function supersededBy(testCase: Case, replacement: string): Case {
  return { ...testCase, lifecycle: { state: "superseded", replacement } };
}

function planFor(specSlug: string, cases: Case[]): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: TEST_CASES_SCHEMA_VERSION,
    specSlug,
    cases,
  };
}

// The recorded results of ANOTHER spec, as threaded in through `resultsBySlug`.
function foreignResults(caseResults: Record<string, CaseResult>): BenchResults {
  return { caseResults, updatedAt: "2026-01-01T00:00:00.000Z" };
}

function lifecycleFor(
  origin: TestCasesPlan,
  opts: {
    otherPlans?: TestCasesPlan[];
    archivedSpecs?: string[];
    resultsBySlug?: Record<string, BenchResults>;
  } = {},
): GateLifecycle {
  const plans = new Map<string, ResolverPlan>([[origin.specSlug, origin]]);
  for (const other of opts.otherPlans ?? []) plans.set(other.specSlug, other);
  const specLifecycles = new Map<string, ResolverSpecLifecycle>(
    (opts.archivedSpecs ?? []).map((slug) => [slug, { archived: true } as const]),
  );
  return {
    resolutions: resolvePlan(origin, { plans, specLifecycles }),
    resultsBySlug: new Map(Object.entries(opts.resultsBySlug ?? {})),
  };
}

describe("evaluateGate: a retired case leaves the gating set (SATCA-TC-022, SATCA-FR-008)", () => {
  const declared = ["TC-1", "TC-2", "TC-3", "TC-4"];
  const recorded = results({
    "TC-1": caseResult("passed"),
    "TC-2": caseResult("passed"),
    "TC-3": caseResult("passed"),
    "TC-4": caseResult("not_started"),
  });
  const live = [
    planCase("TC-1", 1, "functional"),
    planCase("TC-2", 1, "functional"),
    planCase("TC-3", 1, "functional"),
  ];

  it("the retired case is absent from the effective gating set and the gate passes", () => {
    const gate = makeGate(declared, ["WU-10"]);
    const declaredSnapshot = structuredClone(gate.implements.test_case_ids);
    const p = plan([...live, retired(planCase("TC-4", 1, "functional"))]);

    const state = evaluateGate(gate, recorded, PLAN_HASH, p, lifecycleFor(p));

    // S001-O01: TC-4 is gone from the effective set.
    expect(state.gatingCaseIds).toEqual(["TC-1", "TC-2", "TC-3"]);
    expect(state.unresolvedCaseIds).toEqual([]);
    // S001-O02: the three remaining cases all pass, so the gate passes.
    expect(state.status).toBe("passed");
    // S001-O03: nobody edited the work unit's declared case list; the narrowing is
    // computed, never written back.
    expect(gate.implements.test_case_ids).toEqual(declaredSnapshot);
  });

  it("without the lifecycle input the same retired case still gates (pre-#768 behaviour)", () => {
    const gate = makeGate(declared, ["WU-10"]);
    const p = plan([...live, retired(planCase("TC-4", 1, "functional"))]);
    const state = evaluateGate(gate, recorded, PLAN_HASH, p);
    expect(state.gatingCaseIds).toEqual(declared);
    expect(state.status).toBe("pending");
  });
});

describe("evaluateGate: a superseded case takes its replacement's status (SATCA-TC-023, SATCA-FR-009)", () => {
  // TC-1 is superseded by TC-9 in the same spec. TC-1 itself has no recorded
  // result at all, so a gate that ignored the pointer would read it as pending.
  const p = plan([
    supersededBy(planCase("TC-1", 1, "functional"), "TC-9"),
    planCase("TC-9", 1, "functional"),
  ]);

  it("resolves to the replacement and reports passed", () => {
    const gate = makeGate(["TC-1"], ["WU-10"]);
    const state = evaluateGate(
      gate,
      results({ "TC-9": caseResult("passed") }),
      PLAN_HASH,
      p,
      lifecycleFor(p),
    );
    // S001-O01: the obligation transferred; the declared id is still what the gate
    // reports gating on, but its status came from TC-9.
    expect(state.gatingCaseIds).toEqual(["TC-1"]);
    expect(state.unresolvedCaseIds).toEqual([]);
    // S001-O02.
    expect(state.status).toBe("passed");
  });

  it("reports failed once the replacement later fails", () => {
    const gate = makeGate(["TC-1"], ["WU-10"]);
    const state = evaluateGate(
      gate,
      results({ "TC-9": caseResult("failed") }),
      PLAN_HASH,
      p,
      lifecycleFor(p),
    );
    // S002-O01: the replacement's failure is the gate's failure.
    expect(state.status).toBe("failed");
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
  });
});

describe("evaluateGate: a supersession chain reads the case it lands on (SATCA-TC-079, SATCA-FR-009)", () => {
  it("reads the third case's status through a two-hop chain", () => {
    // TC-1 -> TC-2 -> TC-3, where TC-3 is live and passed and TC-1 has no result.
    const p = plan([
      supersededBy(planCase("TC-1", 2, "functional"), "TC-2"),
      supersededBy(planCase("TC-2", 2, "functional"), "TC-3"),
      planCase("TC-3", 2, "functional"),
    ]);
    const gate = makeGate(["TC-1"], ["WU-10"]);

    const state = evaluateGate(
      gate,
      results({ "TC-3": caseResult("passed") }),
      PLAN_HASH,
      p,
      lifecycleFor(p),
    );

    // S001-O01: the third case's status stood in for the superseded case's.
    expect(state.status).toBe("passed");
    expect(state.gatingCaseIds).toEqual(["TC-1"]);
    // S001-O02.
    expect(state.unresolvedCaseIds).toEqual([]);
  });
});

describe("evaluateGate: an unresolvable pointer keeps the gate non-passing (SATCA-TC-028, SATCA-FR-010)", () => {
  it("a pointer at a case inside an archived spec fails closed", () => {
    const p = plan([supersededBy(planCase("TC-1", 1, "functional"), "retired-spec:TC-9")]);
    const target = planFor("retired-spec", [planCase("TC-9", 1, "functional")]);
    const lifecycle = lifecycleFor(p, {
      otherPlans: [target],
      archivedSpecs: ["retired-spec"],
      // The target's results ARE available; the archived spec is what blocks it,
      // so a passed target must still not produce a pass.
      resultsBySlug: { "retired-spec": foreignResults({ "TC-9": caseResult("passed") }) },
    });
    const gate = makeGate(["TC-1"], ["WU-10"]);

    // S001-O01: the resolver names the archived target, from the closed six-value
    // vocabulary the evaluator consumes rather than re-derives.
    const resolution = lifecycle.resolutions.find((r) => r.origin.caseId === "TC-1");
    expect(resolution?.status).toBe("unresolved");
    expect(resolution?.reason).toBe("target archived");
    expect(resolution?.targetSpecState).toBe("archived");

    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed") }),
      PLAN_HASH,
      p,
      lifecycle,
    );
    // S001-O02: the case stays in the gating set as unresolved, so the gate cannot
    // pass, not even off its own stale recorded pass.
    expect(state.gatingCaseIds).toEqual(["TC-1"]);
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
    expect(state.status).toBe("pending");
  });

  it("a cycle keeps both cases gating and the gate non-passing", () => {
    const p = plan([
      supersededBy(planCase("TC-1", 1, "functional"), "TC-2"),
      supersededBy(planCase("TC-2", 1, "functional"), "TC-1"),
    ]);
    const gate = makeGate(["TC-1", "TC-2"], ["WU-10"]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed"), "TC-2": caseResult("passed") }),
      PLAN_HASH,
      p,
      lifecycleFor(p),
    );
    expect(state.status).toBe("pending");
    expect(state.unresolvedCaseIds).toEqual(["TC-1", "TC-2"]);
  });
});

describe("evaluateGate: a cross-spec pointer resolves only when the caller threads the target in (SATCA-TC-029, SATCA-FR-002, SATCA-FR-009)", () => {
  const origin = plan([supersededBy(planCase("TC-1", 2, "integration"), "spec-b:TC-9")]);
  const specB = planFor("spec-b", [planCase("TC-9", 2, "integration")]);
  const gate = makeGate(["TC-1"], ["WU-10"]);

  it("names the other spec through the resolver's referenced-slug collector", () => {
    // S001-O01: the caller asks the resolver what to load; it does not parse the
    // pointer itself.
    expect(collectReferencedSlugs(origin)).toEqual(["spec-b"]);
  });

  it("resolves and passes once that spec's plan and results are threaded in", () => {
    const state = evaluateGate(
      gate,
      results({}),
      PLAN_HASH,
      origin,
      lifecycleFor(origin, {
        otherPlans: [specB],
        resultsBySlug: { "spec-b": foreignResults({ "TC-9": caseResult("passed") }) },
      }),
    );
    // S002-O01 / S002-O02.
    expect(state.gatingCaseIds).toEqual(["TC-1"]);
    expect(state.unresolvedCaseIds).toEqual([]);
    expect(state.status).toBe("passed");
  });

  it("stays unresolved when the target spec was not supplied", () => {
    const lifecycle = lifecycleFor(origin);
    expect(lifecycle.resolutions[0].reason).toBe("target spec not supplied");
    const state = evaluateGate(gate, results({}), PLAN_HASH, origin, lifecycle);
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
    expect(state.status).not.toBe("passed");
  });

  it("stays unresolved when the target spec's plan is supplied but its results are not", () => {
    // The pointer resolves, but there is no recorded status to read at the
    // landing. Fail closed rather than treat an absent foreign result as a pass.
    const state = evaluateGate(
      gate,
      results({}),
      PLAN_HASH,
      origin,
      lifecycleFor(origin, { otherPlans: [specB] }),
    );
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
    expect(state.status).not.toBe("passed");
  });
});

describe("evaluateGate: an emptied gating set names what emptied it (SATCA-TC-031, SATCA-FR-011)", () => {
  it("a set emptied by lifecycle reports emptyReason 'lifecycle'", () => {
    const gate = makeGate(["TC-1", "TC-2"], ["WU-10"]);
    const p = plan([
      retired(planCase("TC-1", 1, "functional")),
      retired(planCase("TC-2", 1, "functional")),
    ]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed"), "TC-2": caseResult("passed") }),
      PLAN_HASH,
      p,
      lifecycleFor(p),
    );
    // S001-O01: an empty gating set, deliberately not a pass.
    expect(state.status).toBe("no_gating_cases");
    expect(state.gatingCaseIds).toEqual([]);
    // S001-O02.
    expect(state.emptyReason).toBe("lifecycle");
  });

  it("a set emptied by the level and type policy reports a distinct emptyReason 'policy'", () => {
    const gate = makeGate(["TC-1", "TC-2"], ["WU-10"]);
    const p = plan([planCase("TC-1", 3, "functional"), planCase("TC-2", 4, "functional")]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed"), "TC-2": caseResult("passed") }),
      PLAN_HASH,
      p,
      lifecycleFor(p),
    );
    // S002-O01 / S002-O02: same status, different, distinguishable reason.
    expect(state.status).toBe("no_gating_cases");
    expect(state.emptyReason).toBe("policy");
    expect(state.emptyReason).not.toBe("lifecycle");
  });

  it("a set both rules emptied reports 'mixed' rather than rounding to one rule", () => {
    const gate = makeGate(["TC-1", "TC-2"], ["WU-10"]);
    const p = plan([retired(planCase("TC-1", 1, "functional")), planCase("TC-2", 4, "functional")]);
    const state = evaluateGate(gate, results({}), PLAN_HASH, p, lifecycleFor(p));
    expect(state.status).toBe("no_gating_cases");
    expect(state.emptyReason).toBe("mixed");
  });

  it("a retired out-of-policy case is attributed to lifecycle, whatever the declaration order", () => {
    // Lifecycle is evaluated before the policy filter so the attribution is
    // deterministic rather than an accident of ordering.
    const gate = makeGate(["TC-1"], ["WU-10"]);
    const p = plan([retired(planCase("TC-1", 4, "functional"))]);
    const state = evaluateGate(gate, results({}), PLAN_HASH, p, lifecycleFor(p));
    expect(state.emptyReason).toBe("lifecycle");
  });

  it("a gate that declared nothing reports emptyReason null (nothing emptied it)", () => {
    const state = evaluateGate(makeGate([], ["WU-10"]), results({}), PLAN_HASH, plan([]));
    expect(state.status).toBe("no_gating_cases");
    expect(state.emptyReason).toBeNull();
  });

  it("emptyReason is null on every non-empty rung", () => {
    const gate = makeGate(["TC-1"], ["WU-10"]);
    const p = plan([planCase("TC-1", 1, "functional")]);
    expect(
      evaluateGate(gate, results({ "TC-1": caseResult("passed") }), PLAN_HASH, p).emptyReason,
    ).toBeNull();
    expect(
      evaluateGate(gate, results({ "TC-1": caseResult("failed") }), PLAN_HASH, p).emptyReason,
    ).toBeNull();
    expect(evaluateGate(gate, null, PLAN_HASH, p).emptyReason).toBeNull();
  });
});

describe("evaluateGate: the lifecycle input stays pure (SATCA-FR-012, VG-NFR-007)", () => {
  const p = plan([
    supersededBy(planCase("TC-1", 1, "functional"), "spec-b:TC-9"),
    retired(planCase("TC-2", 1, "functional")),
    planCase("TC-3", 1, "functional"),
  ]);
  const specB = planFor("spec-b", [planCase("TC-9", 1, "functional")]);

  it("identical inputs yield a deep-equal GateState", () => {
    const gate = makeGate(["TC-1", "TC-2", "TC-3"], ["WU-10"]);
    const r = results({ "TC-3": caseResult("passed") });
    const lifecycle = lifecycleFor(p, {
      otherPlans: [specB],
      resultsBySlug: { "spec-b": foreignResults({ "TC-9": caseResult("passed") }) },
    });
    const a = evaluateGate(gate, r, PLAN_HASH, p, lifecycle);
    const b = evaluateGate(gate, r, PLAN_HASH, p, lifecycle);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.status).toBe("passed");
  });

  it("does not mutate the threaded lifecycle input", () => {
    const gate = makeGate(["TC-1", "TC-2", "TC-3"], ["WU-10"]);
    const lifecycle = lifecycleFor(p, {
      otherPlans: [specB],
      resultsBySlug: { "spec-b": foreignResults({ "TC-9": caseResult("passed") }) },
    });
    const resolutionsSnapshot = structuredClone(lifecycle.resolutions);
    const foreignSnapshot = structuredClone([...(lifecycle.resultsBySlug ?? new Map())]);
    const planSnapshot = structuredClone(p);

    evaluateGate(gate, results({ "TC-3": caseResult("passed") }), PLAN_HASH, p, lifecycle);

    expect(lifecycle.resolutions).toEqual(resolutionsSnapshot);
    expect([...(lifecycle.resultsBySlug ?? new Map())]).toEqual(foreignSnapshot);
    expect(p).toEqual(planSnapshot);
  });
});

describe("evaluateGate: a narrowed set names the cases lifecycle excluded (SATCA-TC-033, #777)", () => {
  const gate = makeGate(["TC-1", "TC-2"], ["WU-10"]);

  it("names the retired case on a PASSED gate, which is where the release is read", () => {
    // The journey SATCA-TC-033 walks: one case verified, one retired, so the gate
    // passes. `emptyReason` cannot answer "why did this pass" here, because the
    // set was narrowed rather than emptied.
    const p = plan([planCase("TC-1", 1, "functional"), retired(planCase("TC-2", 1, "functional"))]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed") }),
      PLAN_HASH,
      p,
      lifecycleFor(p),
    );
    expect(state.status).toBe("passed");
    expect(state.gatingCaseIds).toEqual(["TC-1"]);
    expect(state.lifecycleExcludedCaseIds).toEqual(["TC-2"]);
    // The narrowing is computed, never written back to the declared set.
    expect(gate.implements.test_case_ids).toEqual(["TC-1", "TC-2"]);
    // A narrowed (not emptied) set carries no emptyReason, which is exactly why
    // the exclusion list has to exist.
    expect(state.emptyReason).toBeNull();
  });

  it("names them on a PENDING gate too, in the gate's declared order", () => {
    const p = plan([
      retired(planCase("TC-1", 1, "functional")),
      planCase("TC-2", 1, "functional"),
      planCase("TC-3", 1, "functional"),
    ]);
    const wide = makeGate(["TC-1", "TC-2", "TC-3"], ["WU-10"]);
    const state = evaluateGate(
      wide,
      results({ "TC-2": caseResult("passed") }),
      PLAN_HASH,
      p,
      lifecycleFor(p),
    );
    expect(state.status).toBe("pending");
    expect(state.lifecycleExcludedCaseIds).toEqual(["TC-1"]);
    expect(state.unresolvedCaseIds).toEqual(["TC-3"]);
  });

  it("is empty when lifecycle dropped nothing, on every rung", () => {
    const p = plan([planCase("TC-1", 1, "functional"), planCase("TC-2", 1, "functional")]);
    for (const r of [
      results({ "TC-1": caseResult("passed"), "TC-2": caseResult("passed") }),
      results({ "TC-1": caseResult("failed"), "TC-2": caseResult("passed") }),
      results({}),
      null,
    ] as const) {
      expect(evaluateGate(gate, r, PLAN_HASH, p, lifecycleFor(p)).lifecycleExcludedCaseIds).toEqual(
        [],
      );
    }
  });

  it("excludes only what LIFECYCLE dropped, never what the level and type policy dropped", () => {
    // Attribution matters: an operator told "excluded by lifecycle" would go
    // looking for a retirement record that does not exist.
    const p = plan([planCase("TC-1", 4, "functional"), retired(planCase("TC-2", 1, "functional"))]);
    const state = evaluateGate(gate, results({}), PLAN_HASH, p, lifecycleFor(p));
    expect(state.status).toBe("no_gating_cases");
    expect(state.emptyReason).toBe("mixed");
    expect(state.lifecycleExcludedCaseIds).toEqual(["TC-2"]);
  });

  it("reports the whole declared set on a gate lifecycle emptied outright", () => {
    const p = plan([
      retired(planCase("TC-1", 1, "functional")),
      retired(planCase("TC-2", 1, "functional")),
    ]);
    const state = evaluateGate(gate, results({}), PLAN_HASH, p, lifecycleFor(p));
    expect(state.emptyReason).toBe("lifecycle");
    expect(state.lifecycleExcludedCaseIds).toEqual(["TC-1", "TC-2"]);
  });
});
