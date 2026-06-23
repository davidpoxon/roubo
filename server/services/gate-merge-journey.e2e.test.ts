// TC-025 (e2e_flow, level 2): the merge-then-verify-then-sign-off journey end to
// end. An operator merges the Phase 2 and Phase 3 gates into one combined gate,
// marks all four gating cases passed, and signs off, with no separate Phase 2 /
// Phase 3 gate cards remaining.
//
// The "running system" here is the REAL, already-merged gate stack composed as one
// continuous journey, not a mock of the gate logic (AC-1):
//   - S001 exercises the real `applyGateOverrides` (#703,
//     server/lib/gate-overrides.ts): one recorded `merge` op over the two loaded
//     verify units yields one synthetic combined gate whose gating set is the
//     union TC-019, TC-020, TC-024, TC-030.
//   - S002 exercises the real `evaluateGate` (#701,
//     server/lib/gate-evaluator.ts): the combined gate reads pending before the
//     four cases are passed, then `passed` once all four are marked passed.
//   - S003 exercises the real `onGatePassed` (#701/#702,
//     server/services/gate-lifecycle-coordinator.ts): it closes the combined
//     gate's tracker via the plugin transition and audit-logs the close; then a
//     re-application of `applyGateOverrides` confirms no separate Phase 2 / Phase 3
//     gate card remains.
//
// The only faked seam is the external integration plugin, supplied through the
// coordinator's existing injectable hooks (GateLifecycleDeps.invoke/recordAudit/
// now). The gate functions themselves are the real production functions.
//
// Drift guard (AC-2): each it() is named after its TC-025 step id and the step's
// expected observation is kept explicit, so a change to the authoritative TC-025
// in .specifications/verify-gate/test-cases.json forces this test to be updated.
//
// Failure-output contract (AC-3): every assertion attaches an expected-vs-actual
// message naming the owning slice issue from this unit's blocked-by set, so a red
// run localizes the integration drift to one attributable slice:
//   S001 -> #703 (batch merge/split), S002 -> #701 (gate API + batch-subset),
//   S003 -> #701/#702 (sign-off: close on pass + batch UI).

import { describe, it, expect } from "vitest";
import { applyGateOverrides, type WorkUnitCaseMap } from "../lib/gate-overrides.js";
import { evaluateGate, type VerifyUnit, type GateResults } from "../lib/gate-evaluator.js";
import {
  onGatePassed,
  GateAuditLog,
  type GateLifecycleDeps,
} from "./gate-lifecycle-coordinator.js";
import type { LoadedVerifyUnit } from "./work-unit-loader.js";
import type { GateAuditEntry, NormalizedIssue } from "@roubo/shared";
import type { Tracker } from "@roubo/shared/work-units-contract";
import type { GateOverridesFile } from "@roubo/shared/gate-overrides-contract";
import {
  GATE_OVERRIDES_SCHEMA_ID,
  GATE_OVERRIDES_SCHEMA_VERSION,
} from "@roubo/shared/gate-overrides-contract";
import type { BenchResults, CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";

// ── Owning slices (this e2e unit's blocked-by set: #701, #702, #703) ──
const SLICE_S001 = "#703 (batch merge/split, operator override)";
const SLICE_S002 = "#701 (gate API routes + batch-subset)";
const SLICE_S003 = "#701/#702 (sign-off: close on pass + TestBench batch UI)";

// ── Fixture identifiers (TC-025 preconditions) ──
const PROJECT_ID = "proj-verify-gate";
const PLUGIN_ID = "github-com";
const PLAN_HASH = "sha256-plan-v1";
const SLUG = "verify-gate";

// The two source gates and their gating sets (TC-025 precondition).
const PHASE2_GATE_ID = "WU-031";
const PHASE3_GATE_ID = "WU-032";
const PHASE2_CASES = ["TC-019", "TC-020", "TC-024"];
const PHASE3_CASES = ["TC-030"];
const COMBINED_CASES = [...PHASE2_CASES, ...PHASE3_CASES];

// The combined gate's tracker issue, closed on sign-off.
const TRACKER_REF = "451";

// The deterministic merged gate id minted from the sorted source ids
// (gate-overrides.mintMergeGateId). WU-031, WU-032 sort to this id.
const MERGED_GATE_ID = `MERGED:${[PHASE2_GATE_ID, PHASE3_GATE_ID].sort().join("+")}`;

// ── Fixture builders (reuse the shapes from the modules' unit tests) ──

// A loaded VerifyUnit gate paired with its spec slug, as work-unit-loader returns.
function makeGate(id: string, title: string, testCaseIds: readonly string[]): LoadedVerifyUnit {
  const unit: VerifyUnit = {
    id,
    title,
    type: "task",
    kind: "verify",
    description: `Gate over ${title}`,
    acceptance_criteria: [],
    depends_on: [],
    covers: [],
    implements: {
      requirement_ids: [],
      user_story_ids: [],
      test_case_ids: [...testCaseIds],
    },
  };
  return { slug: SLUG, unit };
}

// A recorded-results body over the four gating cases. Each case carries the given
// status so the combined gate reads pending (any non-passed) or passed (all
// passed). Shape from gate-evaluator.test.ts.
function results(caseStatus: CaseStatus): GateResults {
  const caseResults: Record<string, CaseResult> = {};
  for (const id of COMBINED_CASES) {
    caseResults[id] = { observationMarks: {}, derivedStatus: caseStatus, notes: [] };
  }
  const body: BenchResults & { planHash: string } = {
    caseResults,
    updatedAt: "2026-01-01T00:00:00.000Z",
    planHash: PLAN_HASH,
  };
  return body;
}

// A NormalizedIssue for the combined gate's tracker, from
// gate-lifecycle-coordinator.test.ts.
function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    integrationId: PLUGIN_ID,
    externalId: TRACKER_REF,
    externalUrl: `https://github.com/o/r/issues/${TRACKER_REF}`,
    title: "Combined verify gate",
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

// The empty WU- -> TC- case map: merge does not consult it (only split does), so
// an empty map suffices for the merge journey.
const caseMap: WorkUnitCaseMap = new Map<string, readonly string[]>();

// The two source gates (TC-025 precondition: Phase 2 + Phase 3, both pending).
const phase2 = makeGate(PHASE2_GATE_ID, "Verify batch Phase 2", PHASE2_CASES);
const phase3 = makeGate(PHASE3_GATE_ID, "Verify batch Phase 3", PHASE3_CASES);
const loaded: LoadedVerifyUnit[] = [phase2, phase3];

// A gate-overrides document carrying one recorded `merge` op over the two gates.
const overrides: GateOverridesFile = {
  $schema: GATE_OVERRIDES_SCHEMA_ID,
  schemaVersion: GATE_OVERRIDES_SCHEMA_VERSION,
  ops: [{ op: "merge", gateIds: [PHASE2_GATE_ID, PHASE3_GATE_ID] }],
};

// ── Shared in-test fixture world, threaded across the ordered it() blocks so the
// journey is continuous. ──

const audit = new GateAuditLog();

// The combined gate tracker issue #451: open until sign-off closes it.
let trackerIssue: NormalizedIssue = makeIssue();

// The faked external integration plugin. getIssue returns the live in-memory
// tracker; applyTransition mutates it to a done state, modelling the close.
const invoke = (async (_pluginId: string, method: string, _params: unknown) => {
  if (method === "getIssue") {
    return trackerIssue as never;
  }
  if (method === "applyTransition") {
    trackerIssue = { ...trackerIssue, currentState: "closed", allowedTransitions: ["reopen"] };
    return trackerIssue as never;
  }
  throw new Error(`unexpected method ${method}`);
}) as unknown as GateLifecycleDeps["invoke"];

const deps: GateLifecycleDeps = {
  invoke,
  recordAudit: (entry) => audit.record(entry),
  now: () => "2026-06-23T00:00:00.000Z",
};

describe("TC-025: operator merges two batches then verifies and signs off the combined gate", () => {
  it("S001: merge the Phase 2 and Phase 3 gates -> one combined gate replaces the two; gating set is TC-019, TC-020, TC-024, TC-030 (S001-O01)", () => {
    // S001: open the batches overview and merge the Phase 2 and Phase 3 gates;
    // confirm. Drive the REAL applyGateOverrides (#703) with the recorded merge op.
    const { gates, dropped } = applyGateOverrides(loaded, overrides, caseMap);

    // No op should be dropped: both source gates are present and same-slug.
    expect(
      dropped,
      `TC-025 step S001 (S001-O01) diverged: expected the merge op to apply cleanly, but it was dropped: ${JSON.stringify(
        dropped,
      )}. Owning slice: ${SLICE_S001}.`,
    ).toEqual([]);

    // S001-O01a: exactly one combined gate card replaces the two source cards.
    expect(
      gates.map((g) => g.unit.id),
      `TC-025 step S001 (S001-O01) diverged: expected exactly one combined gate "${MERGED_GATE_ID}" to replace the two Phase gates, got ${JSON.stringify(
        gates.map((g) => g.unit.id),
      )}. Owning slice: ${SLICE_S001}.`,
    ).toEqual([MERGED_GATE_ID]);

    // S001-O01b: the combined gate's gating set is the union of the two sources'
    // gating sets (TC-019, TC-020, TC-024, TC-030), deduped, no loss.
    const combined = gates[0].unit;
    expect(
      combined.implements.test_case_ids,
      `TC-025 step S001 (S001-O01) diverged: expected the combined gate's gating set to be the union ${JSON.stringify(
        COMBINED_CASES,
      )}, got ${JSON.stringify(combined.implements.test_case_ids)}. Owning slice: ${SLICE_S001}.`,
    ).toEqual(COMBINED_CASES);
  });

  it("S002: open the combined gate in TestBench and mark all 4 cases passed -> all 4 gating cases show passed (S002-O01)", () => {
    // Resolve the combined gate from the same real merge transform the route uses.
    const combined = applyGateOverrides(loaded, overrides, caseMap).gates[0].unit;

    // Precondition: before the four cases flip, the combined gate is not passed.
    // Drive the REAL evaluateGate (#701) over the combined gating set.
    const before = evaluateGate(combined, results("in_progress"), PLAN_HASH);
    expect(
      before.status,
      `TC-025 step S002 diverged: expected the combined gate to read NOT passed before the four cases are marked passed, got "${before.status}". Owning slice: ${SLICE_S002}.`,
    ).not.toBe("passed");
    expect(
      before.unresolvedCaseIds,
      `TC-025 step S002 diverged: expected all four combined gating cases unresolved before they are marked passed, got ${JSON.stringify(
        before.unresolvedCaseIds,
      )}. Owning slice: ${SLICE_S002}.`,
    ).toEqual(COMBINED_CASES);

    // S002: mark all four gating cases passed.
    const after = evaluateGate(combined, results("passed"), PLAN_HASH);

    // S002-O01: all four gating cases show passed (the gate passes with an empty
    // unresolved set, no duplicates).
    expect(
      after.status,
      `TC-025 step S002 (S002-O01) diverged: expected the combined gate to read "passed" once all four cases are marked passed, got "${after.status}". Owning slice: ${SLICE_S002}.`,
    ).toBe("passed");
    expect(
      after.unresolvedCaseIds,
      `TC-025 step S002 (S002-O01) diverged: expected no unresolved gating cases once all four pass, got ${JSON.stringify(
        after.unresolvedCaseIds,
      )}. Owning slice: ${SLICE_S002}.`,
    ).toEqual([]);
  });

  it("S003: sign off the combined batch -> sign-off succeeds, the combined gate shows passed/closed, and no separate Phase 2 / Phase 3 gate cards remain (S003-O01, S003-O02)", async () => {
    // Resolve the combined gate and attach its tracker ref, then sign off. The
    // sign-off path is modelled as evaluateGate (passed) -> onGatePassed, exactly
    // as the TC-040 sibling and architecture.md "TestBench sign-off path" describe.
    const combinedUnit = applyGateOverrides(loaded, overrides, caseMap).gates[0].unit;
    const tracker: Tracker = {
      system: "github",
      ref: TRACKER_REF,
      url: `https://github.com/o/r/issues/${TRACKER_REF}`,
      blocked_by_refs: [],
    };
    const signedOffGate: VerifyUnit = { ...combinedUnit, tracker };

    // Confirm the gate is passed (the caller's guard) before signing off.
    const state = evaluateGate(signedOffGate, results("passed"), PLAN_HASH);
    expect(
      state.status,
      `TC-025 step S003 diverged: expected the combined gate to be passed before sign-off, got "${state.status}". Owning slice: ${SLICE_S003}.`,
    ).toBe("passed");

    // S003: sign off the combined batch. Drive the REAL onGatePassed (#701/#702)
    // against the shared fake plugin.
    await onGatePassed(PROJECT_ID, signedOffGate, PLUGIN_ID, deps);

    // S003-O01a: sign-off is recorded: exactly one audit entry for the gate close,
    // referencing the combined tracker #451 and the plugin.
    const entries = audit.query();
    expect(
      entries,
      `TC-025 step S003 (S003-O01) diverged: expected exactly one audit entry for the combined-gate sign-off, got ${entries.length}: ${JSON.stringify(
        entries,
      )}. Owning slice: ${SLICE_S003}.`,
    ).toHaveLength(1);
    expect(
      entries[0],
      `TC-025 step S003 (S003-O01) diverged: expected the audit entry to record outcome "closed" for combined tracker #${TRACKER_REF} via plugin "${PLUGIN_ID}" on gate "${MERGED_GATE_ID}", got ${JSON.stringify(
        entries[0],
      )}. Owning slice: ${SLICE_S003}.`,
    ).toEqual<GateAuditEntry>({
      ts: "2026-06-23T00:00:00.000Z",
      projectId: PROJECT_ID,
      pluginId: PLUGIN_ID,
      gateId: MERGED_GATE_ID,
      trackerRef: TRACKER_REF,
      transitionName: "close",
      outcome: "closed",
    });

    // S003-O01b: the combined gate shows passed/closed (the tracker transitioned
    // to a done state via the plugin).
    expect(
      trackerIssue.currentState,
      `TC-025 step S003 (S003-O01) diverged: expected the combined gate tracker #${TRACKER_REF} currentState to read "closed" after sign-off, got "${trackerIssue.currentState}". Owning slice: ${SLICE_S003}.`,
    ).toBe("closed");

    // S003-O02: no separate Phase 2 or Phase 3 gate cards remain. Re-applying the
    // real merge transform over the loaded gates still yields only the combined
    // gate, never the original Phase 2 / Phase 3 cards.
    const effectiveIds = applyGateOverrides(loaded, overrides, caseMap).gates.map((g) => g.unit.id);
    expect(
      effectiveIds,
      `TC-025 step S003 (S003-O02) diverged: expected the effective gate list to contain only the combined gate "${MERGED_GATE_ID}" with no separate Phase 2 / Phase 3 card, got ${JSON.stringify(
        effectiveIds,
      )}. Owning slice: ${SLICE_S003}.`,
    ).toEqual([MERGED_GATE_ID]);
    expect(
      effectiveIds,
      `TC-025 step S003 (S003-O02) diverged: expected no separate Phase 2 gate "${PHASE2_GATE_ID}" to remain after the merge, got ${JSON.stringify(
        effectiveIds,
      )}. Owning slice: ${SLICE_S003}.`,
    ).not.toContain(PHASE2_GATE_ID);
    expect(
      effectiveIds,
      `TC-025 step S003 (S003-O02) diverged: expected no separate Phase 3 gate "${PHASE3_GATE_ID}" to remain after the merge, got ${JSON.stringify(
        effectiveIds,
      )}. Owning slice: ${SLICE_S003}.`,
    ).not.toContain(PHASE3_GATE_ID);
  });
});
