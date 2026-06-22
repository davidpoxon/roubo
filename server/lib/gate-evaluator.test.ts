import { describe, it, expect } from "vitest";
import { evaluateGate, type VerifyUnit, type GateResults } from "./gate-evaluator.js";
import type {
  BenchResults,
  CaseResult,
  CaseStatus,
  StatusOverride,
  TestCasesPlan,
  Case,
} from "@roubo/shared/testbench-contracts";
import { TEST_CASES_SCHEMA_ID, TEST_CASES_SCHEMA_VERSION } from "@roubo/shared/testbench-contracts";

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

describe("evaluateGate: status truth table (TC-009..TC-013, FR-004)", () => {
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

  it("PASSED only when EVERY gating case is passed (TC-009)", () => {
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

describe("evaluateGate: effective status / override (TC-014, FR-005)", () => {
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

describe("evaluateGate: never false-pass (TC-015..TC-017, NFR-007)", () => {
  it("an absent gating case reads as pending, never passed (TC-015)", () => {
    const gate = makeGate(["TC-1", "TC-2"]);
    // TC-2 has no recorded result.
    const state = evaluateGate(gate, results({ "TC-1": caseResult("passed") }), PLAN_HASH);
    expect(state.status).toBe("pending");
    expect(state.unresolvedCaseIds).toEqual(["TC-2"]);
  });

  it("an orphaned gating case reads as pending, never passed (TC-016)", () => {
    const gate = makeGate(["TC-1"]);
    const state = evaluateGate(
      gate,
      results({ "TC-1": caseResult("passed", { orphaned: true }) }),
      PLAN_HASH,
    );
    expect(state.status).toBe("pending");
    expect(state.unresolvedCaseIds).toEqual(["TC-1"]);
  });

  it("a planHash mismatch reads as stale, never passed (TC-017)", () => {
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

describe("evaluateGate: default gating policy L1/L2 + e2e_flow (TC-018, FR-005)", () => {
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

describe("evaluateGate: coveringUnitIds derivation (NFR-004)", () => {
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

describe("evaluateGate: purity and idempotence (TC-018, NFR-007)", () => {
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
