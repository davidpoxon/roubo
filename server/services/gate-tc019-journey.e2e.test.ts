// TC-019 (e2e_flow, level 1): marking all gating cases passed transitions the gate
// from PENDING to PASSED. The journey opens the gate-state panel for WU-040, then
// marks each of its three gating cases passed in order, watching the gate hold
// PENDING until the last one flips and then read PASSED with no stale banner.
//
// The "running system" here is the REAL, already-merged gate evaluator composed in
// process under vitest, not a mock of the gate logic (AC-1): every step drives the
// real `evaluateGate` (#698, server/lib/gate-evaluator.ts) over the same WU-040
// gate fixture and a results body that the verifier mutates one case at a time. The
// unresolved-list and PENDING/PASSED badge the panel renders are read straight off
// that real GateState; the only thing the test stands in for is the human clicking
// "mark passed", modelled by flipping a case's recorded status in the results body
// the surface would have persisted.
//
// Drift guard (AC-2): each it() is named after its TC-019 step id and the step's
// expected observation is kept explicit, so a change to the authoritative TC-019 in
// .specifications/verify-gate/test-cases.json forces this test to be updated.
//
// Failure-output contract (AC-3): every assertion attaches an expected-vs-actual
// message naming the owning slice issue from this unit's blocked-by set, so a red
// run localizes the integration drift to one attributable slice:
//   - the gate-state transition itself (PENDING/PASSED, unresolved set) is #698
//     (deterministic gate evaluator);
//   - the unresolved-list / gate-state panel surface that renders it is #702
//     (TestBench batch UI / gate-state panel), riding on #701 (gate API routes +
//     batch-subset) for the data it reads.

import { describe, it, expect } from "vitest";
import { evaluateGate, type VerifyUnit, type GateResults } from "../lib/gate-evaluator.js";
import type { Tracker } from "@roubo/shared/work-units-contract";
import type { BenchResults, CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";

// ── Owning slices (this e2e unit's blocked-by set, per #710) ──
// The gate-state transition (PENDING -> PASSED, the unresolved set) is owned by the
// deterministic evaluator; the unresolved-list / gate-state panel surface that
// renders it is owned by the batch UI riding on the gate API routes.
const SLICE_GATE_STATE = "#698 (deterministic gate evaluator)";
const SLICE_PANEL =
  "#702 (TestBench batch UI / gate-state panel), #701 (gate API routes + batch-subset)";

// ── Fixture identifiers (TC-019 preconditions) ──
// Gate WU-040 covers WU-031, WU-032, WU-033; gating set is TC-019, TC-020, TC-024.
// planHash matches throughout (no stale banner); all three cases start not_started.
const PLAN_HASH = "sha256-plan-v1";
const TRACKER_REF = "451"; // gate WU-040's tracker issue
const COVERED_UNIT_IDS = ["WU-031", "WU-032", "WU-033"];
const GATING_CASE_IDS = ["TC-019", "TC-020", "TC-024"];

// ── Fixture builders (reuse the shapes from gate-journey.e2e.test.ts:
// VerifyUnit, GateResults/CaseResult) ──

// VerifyUnit gate WU-040, covering WU-031/WU-032/WU-033 with the three gating cases
// as its implements.test_case_ids (the pre-resolved gating set, used verbatim since
// no plan is threaded in).
function makeGate(): VerifyUnit {
  const tracker: Tracker = {
    system: "github",
    ref: TRACKER_REF,
    url: `https://github.com/o/r/issues/${TRACKER_REF}`,
    blocked_by_refs: [],
  };
  return {
    id: "WU-040",
    title: "Verify batch Phase 2",
    type: "task",
    kind: "verify",
    description: "Gate over WU-031, WU-032, WU-033",
    acceptance_criteria: [],
    depends_on: [],
    covers: [...COVERED_UNIT_IDS],
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: [...GATING_CASE_IDS] },
    tracker,
  };
}

// A recorded-results body assigning each gating case a status. Cases left out of
// `statuses` are recorded not_started, matching the precondition that all three
// start not_started and are flipped one at a time as the verifier marks them.
function results(statuses: Partial<Record<string, CaseStatus>>): GateResults {
  const caseResults: Record<string, CaseResult> = {};
  for (const id of GATING_CASE_IDS) {
    caseResults[id] = {
      observationMarks: {},
      derivedStatus: statuses[id] ?? "not_started",
      notes: [],
    };
  }
  const body: BenchResults & { planHash: string } = {
    caseResults,
    updatedAt: "2026-01-01T00:00:00.000Z",
    planHash: PLAN_HASH,
  };
  return body;
}

// ── Shared in-test fixture world, threaded across the ordered it() blocks so the
// journey is continuous: the verifier flips one recorded case status at a time and
// the panel re-reads the real GateState after each mark. ──

const gate = makeGate();
// The recorded statuses the surface would have persisted. Starts with all three
// gating cases not_started (the precondition); each step mutates one to passed.
const recorded: Record<string, CaseStatus> = {
  "TC-019": "not_started",
  "TC-020": "not_started",
  "TC-024": "not_started",
};

describe("TC-019: marking all gating cases passed transitions WU-040 from PENDING to PASSED", () => {
  it("S001: open the gate-state panel for WU-040 -> badge PENDING, unresolved list shows all three gating cases (S001-O01, S001-O02)", () => {
    // S001: open the batch detail and locate the gate-state panel. Drive the REAL
    // evaluateGate (#698) over the recorded results with all three cases not_started.
    const state = evaluateGate(gate, results(recorded), PLAN_HASH);

    // S001-O01: the gate badge shows PENDING (the panel renders PENDING from the
    // real GateState's status).
    expect(
      state.status,
      `TC-019 step S001 (S001-O01) diverged: expected the gate badge to show PENDING with all three gating cases not_started, got "${state.status}". Owning slices: ${SLICE_GATE_STATE} for the state, ${SLICE_PANEL} for the badge.`,
    ).toBe("pending");

    // S001-O02: the unresolved list shows the three gating cases, each linkable to
    // its covering unit (the panel reads unresolvedCaseIds + coveringUnitIds).
    expect(
      state.unresolvedCaseIds,
      `TC-019 step S001 (S001-O02) diverged: expected the unresolved list to show all three gating cases ${JSON.stringify(
        GATING_CASE_IDS,
      )}, got ${JSON.stringify(state.unresolvedCaseIds)}. Owning slices: ${SLICE_GATE_STATE} for the set, ${SLICE_PANEL} for the list.`,
    ).toEqual(GATING_CASE_IDS);
    expect(
      state.coveringUnitIds,
      `TC-019 step S001 (S001-O02) diverged: expected the unresolved cases to link to their covering units ${JSON.stringify(
        COVERED_UNIT_IDS,
      )}, got ${JSON.stringify(state.coveringUnitIds)}. Owning slices: ${SLICE_GATE_STATE} for covers, ${SLICE_PANEL} for the links.`,
    ).toEqual(COVERED_UNIT_IDS);
  });

  it("S002: mark the first gating case passed -> removed from unresolved, badge stays PENDING with two remaining (S002-O01)", () => {
    // S002: mark the first gating case (TC-019) passed. The surface persists the
    // flip; re-read the real GateState.
    recorded["TC-019"] = "passed";
    const state = evaluateGate(gate, results(recorded), PLAN_HASH);

    // S002-O01: TC-019 is removed from the unresolved list; the badge stays PENDING
    // because two gating cases remain.
    expect(
      state.unresolvedCaseIds,
      `TC-019 step S002 (S002-O01) diverged: expected the first gating case TC-019 to be removed from the unresolved list, leaving ["TC-020","TC-024"], got ${JSON.stringify(
        state.unresolvedCaseIds,
      )}. Owning slices: ${SLICE_GATE_STATE} for the set, ${SLICE_PANEL} for the list.`,
    ).toEqual(["TC-020", "TC-024"]);
    expect(
      state.status,
      `TC-019 step S002 (S002-O01) diverged: expected the gate badge to stay PENDING with two gating cases remaining, got "${state.status}". Owning slices: ${SLICE_GATE_STATE} for the state, ${SLICE_PANEL} for the badge.`,
    ).toBe("pending");
  });

  it("S003: mark the second gating case passed -> removed from unresolved, badge stays PENDING with one remaining (S003-O01)", () => {
    // S003: mark the second gating case (TC-020) passed. Re-read the real GateState.
    recorded["TC-020"] = "passed";
    const state = evaluateGate(gate, results(recorded), PLAN_HASH);

    // S003-O01: TC-020 is removed from the unresolved list; the badge stays PENDING
    // because one gating case remains.
    expect(
      state.unresolvedCaseIds,
      `TC-019 step S003 (S003-O01) diverged: expected the second gating case TC-020 to be removed from the unresolved list, leaving ["TC-024"], got ${JSON.stringify(
        state.unresolvedCaseIds,
      )}. Owning slices: ${SLICE_GATE_STATE} for the set, ${SLICE_PANEL} for the list.`,
    ).toEqual(["TC-024"]);
    expect(
      state.status,
      `TC-019 step S003 (S003-O01) diverged: expected the gate badge to stay PENDING with one gating case remaining, got "${state.status}". Owning slices: ${SLICE_GATE_STATE} for the state, ${SLICE_PANEL} for the badge.`,
    ).toBe("pending");
  });

  it("S004: mark the final gating case passed -> unresolved list empty, badge transitions to PASSED, no stale banner (S004-O01, S004-O02, S004-O03)", () => {
    // S004: mark the final gating case (TC-024) passed. Re-read the real GateState.
    recorded["TC-024"] = "passed";
    const state = evaluateGate(gate, results(recorded), PLAN_HASH);

    // S004-O01: the unresolved list is empty (every gating case is passed).
    expect(
      state.unresolvedCaseIds,
      `TC-019 step S004 (S004-O01) diverged: expected the unresolved list to be empty once every gating case is passed, got ${JSON.stringify(
        state.unresolvedCaseIds,
      )}. Owning slices: ${SLICE_GATE_STATE} for the set, ${SLICE_PANEL} for the list.`,
    ).toEqual([]);

    // S004-O02: the gate badge transitions to PASSED.
    expect(
      state.status,
      `TC-019 step S004 (S004-O02) diverged: expected the gate badge to transition to PASSED once the final gating case is marked passed, got "${state.status}". Owning slices: ${SLICE_GATE_STATE} for the state, ${SLICE_PANEL} for the badge.`,
    ).toBe("passed");

    // S004-O03: no stale banner is shown, because the results' planHash already
    // matched the live plan hash throughout (the gate never read stale).
    expect(
      state.status,
      `TC-019 step S004 (S004-O03) diverged: expected no stale banner (planHash matched throughout, so the gate must not read "stale"), got "${state.status}". Owning slices: ${SLICE_GATE_STATE} for the staleness rule, ${SLICE_PANEL} for the banner.`,
    ).not.toBe("stale");
  });
});
