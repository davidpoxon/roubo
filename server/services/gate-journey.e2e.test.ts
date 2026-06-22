// TC-040 (e2e_flow, level 1): the gate-lifecycle journey end to end. Pass the
// final gating case, close the gate's tracker issue (#451), Phase 3 unblocks, and
// a Phase 3 bench can start.
//
// The "running system" here is the REAL, already-merged gate stack composed as one
// continuous journey, not a mock of the gate logic (AC-1):
//   - S001 exercises the real `evaluateGate` (#698, server/lib/gate-evaluator.ts):
//     the gate reads pending before the final case flips, then `passed` after.
//   - S002 exercises the real `onGatePassed` (#700,
//     server/services/gate-lifecycle-coordinator.ts): it closes tracker #451 via
//     the plugin transition and audit-logs the close.
//   - S003 re-reads the downstream Phase 3 unit's blockedBy (#700): closing the
//     tracker clears WU-040 from the blocker set.
//   - S004 exercises the real `assertGateOpen` (#699,
//     server/services/start-gate.ts): with the post-close issue (empty blockedBy)
//     the Phase 3 start resolves without GATE_BLOCKED.
//
// The only faked seam is the external integration plugin, supplied through each
// module's existing injectable hooks (GateLifecycleDeps.invoke/recordAudit/now and
// assertGateOpen's enforce + prefetchedIssue options). The gate functions
// themselves are the real production functions.
//
// Drift guard (AC-2): each it() is named after its TC-040 step id and the step's
// expected observation is kept explicit, so a change to the authoritative TC-040
// in .specifications/verify-gate/test-cases.json forces this test to be updated.
//
// Failure-output contract (AC-3): every assertion attaches an expected-vs-actual
// message naming the owning slice issue from this unit's blocked-by set, so a red
// run localizes the integration drift to one attributable slice:
//   S001 -> #698 (evaluateGate), S002 -> #700 (onGatePassed),
//   S003 -> #700 (blockedBy clears), S004 -> #699 (assertGateOpen).

import { describe, it, expect } from "vitest";
import { evaluateGate, type VerifyUnit, type GateResults } from "../lib/gate-evaluator.js";
import {
  onGatePassed,
  GateAuditLog,
  type GateLifecycleDeps,
} from "./gate-lifecycle-coordinator.js";
import { assertGateOpen } from "./start-gate.js";
import { ServiceError } from "./service-error.js";
import type { GateAuditEntry, NormalizedIssue } from "@roubo/shared";
import type { Tracker } from "@roubo/shared/work-units-contract";
import type { BenchResults, CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";

// ── Owning slices (this e2e unit's blocked-by set, per the gate journey) ──
const SLICE_S001 = "#698 (deterministic gate evaluator)";
const SLICE_S002 = "#700 (gate lifecycle: close on pass)";
const SLICE_S003 = "#700 (gate lifecycle: unblock next batch)";
const SLICE_S004 = "#699 (hard start-gate, fail-closed)";

// ── Fixture identifiers (TC-040 preconditions) ──
const PROJECT_ID = "proj-verify-gate";
const PLUGIN_ID = "github-com";
const PLAN_HASH = "sha256-plan-v1";
const TRACKER_REF = "451"; // gate WU-040's tracker issue #451
// The Phase 3 unit that lists WU-040 in depends_on and shows Blocked until the
// gate closes. Its blockedBy carries the gate tracker ref while the gate is open.
const PHASE3_REF = "owner/repo#460";

// ── Fixture builders (reuse the exact shapes from the three modules' unit
// tests: VerifyUnit, GateResults/CaseResult, NormalizedIssue, GateAuditEntry) ──

// VerifyUnit gate WU-040 with tracker.ref -> #451, from
// gate-lifecycle-coordinator.test.ts. Its single gating case TC-001 is the "final
// remaining gating case" of TC-040.
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
    description: "Gate over Phase 2",
    acceptance_criteria: [],
    depends_on: [],
    covers: [],
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: ["TC-001"] },
    tracker,
  };
}

// A recorded-results body for the single gating case, from gate-evaluator.test.ts.
function results(finalCaseStatus: CaseStatus): GateResults {
  const result: CaseResult = {
    observationMarks: {},
    derivedStatus: finalCaseStatus,
    notes: [],
  };
  const body: BenchResults & { planHash: string } = {
    caseResults: { "TC-001": result },
    updatedAt: "2026-01-01T00:00:00.000Z",
    planHash: PLAN_HASH,
  };
  return body;
}

// A NormalizedIssue, from gate-lifecycle-coordinator.test.ts / start-gate.test.ts.
function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    integrationId: PLUGIN_ID,
    externalId: TRACKER_REF,
    externalUrl: `https://github.com/o/r/issues/${TRACKER_REF}`,
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
// journey is continuous. The fake plugin invoker mutates this in-memory tracker
// issue on applyTransition: closing #451 flips its currentState to a done state and
// clears WU-040 from the downstream Phase 3 unit's blockedBy. ──

const gate = makeGate();
const audit = new GateAuditLog();

// The gate tracker issue #451: open while the gate is open.
let trackerIssue: NormalizedIssue = makeIssue();
// The downstream Phase 3 unit: blocked by the gate tracker until it closes.
let phase3Issue: NormalizedIssue = makeIssue({
  externalId: PHASE3_REF,
  externalUrl: "https://github.com/o/r/issues/460",
  title: "Phase 3 unit",
  blockedBy: [TRACKER_REF],
});

// The faked external integration plugin. getIssue returns the live in-memory
// tracker issue; applyTransition mutates it to a done state AND clears the gate ref
// from the downstream unit's blockedBy, modelling the plugin's blocking-relationship
// teardown on close.
const invoke = (async (_pluginId: string, method: string, _params: unknown) => {
  if (method === "getIssue") {
    return trackerIssue as never;
  }
  if (method === "applyTransition") {
    trackerIssue = { ...trackerIssue, currentState: "closed", allowedTransitions: ["reopen"] };
    phase3Issue = {
      ...phase3Issue,
      blockedBy: phase3Issue.blockedBy.filter((ref) => ref !== TRACKER_REF),
    };
    return trackerIssue as never;
  }
  throw new Error(`unexpected method ${method}`);
}) as unknown as GateLifecycleDeps["invoke"];

const deps: GateLifecycleDeps = {
  invoke,
  recordAudit: (entry) => audit.record(entry),
  now: () => "2026-06-22T00:00:00.000Z",
};

describe("TC-040: last gating case passes, gate closes #451, Phase 3 unblocks, a Phase 3 bench can start", () => {
  it("S001: mark the final remaining gating case passed -> gate state changes to passed (S001-O01)", () => {
    // Precondition: before the final case flips, the gate is not passed. Drive the
    // REAL evaluateGate (#698) with the final case still unresolved.
    const before = evaluateGate(gate, results("in_progress"), PLAN_HASH);
    expect(
      before.status,
      `TC-040 step S001 diverged: expected the gate to read NOT passed before the final case is marked passed, got "${before.status}". Owning slice: ${SLICE_S001}.`,
    ).not.toBe("passed");
    expect(
      before.unresolvedCaseIds,
      `TC-040 step S001 diverged: expected the final gating case TC-001 to be unresolved before it is marked passed, got ${JSON.stringify(
        before.unresolvedCaseIds,
      )}. Owning slice: ${SLICE_S001}.`,
    ).toEqual(["TC-001"]);

    // S001: mark the final remaining gating case passed.
    const after = evaluateGate(gate, results("passed"), PLAN_HASH);

    // S001-O01: the gate state changes to passed (the close action becomes
    // enabled, modelled here by passed + an empty unresolved set).
    expect(
      after.status,
      `TC-040 step S001 (S001-O01) diverged: expected the gate state to change to "passed" once the final case is marked passed, got "${after.status}". Owning slice: ${SLICE_S001}.`,
    ).toBe("passed");
    expect(
      after.unresolvedCaseIds,
      `TC-040 step S001 (S001-O01) diverged: expected no unresolved gating cases once the gate passes, got ${JSON.stringify(
        after.unresolvedCaseIds,
      )}. Owning slice: ${SLICE_S001}.`,
    ).toEqual([]);
  });

  it("S002: close gate & unblock Phase 3 -> audit logs a close referencing #451 and the plugin, gate reads closed (S002-O01, S002-O02)", async () => {
    // S002: click 'Close gate & unblock Phase 3' and wait for completion. Drive the
    // REAL onGatePassed (#700) against the shared fake plugin.
    await onGatePassed(PROJECT_ID, gate, PLUGIN_ID, deps);

    // S002-O01: the audit log records exactly one close/transition entry
    // referencing #451 and the plugin.
    const entries = audit.query();
    expect(
      entries,
      `TC-040 step S002 (S002-O01) diverged: expected exactly one audit entry for the gate close, got ${entries.length}: ${JSON.stringify(
        entries,
      )}. Owning slice: ${SLICE_S002}.`,
    ).toHaveLength(1);
    expect(
      entries[0],
      `TC-040 step S002 (S002-O01) diverged: expected the audit entry to record outcome "closed" for tracker #${TRACKER_REF} via plugin "${PLUGIN_ID}", got ${JSON.stringify(
        entries[0],
      )}. Owning slice: ${SLICE_S002}.`,
    ).toEqual<GateAuditEntry>({
      ts: "2026-06-22T00:00:00.000Z",
      projectId: PROJECT_ID,
      pluginId: PLUGIN_ID,
      gateId: "WU-040",
      trackerRef: TRACKER_REF,
      transitionName: "close",
      outcome: "closed",
    });

    // S002-O02: the gate state reads closed (the tracker issue transitioned to a
    // done state via the plugin).
    expect(
      trackerIssue.currentState,
      `TC-040 step S002 (S002-O02) diverged: expected the gate tracker #${TRACKER_REF} currentState to read "closed" after the close, got "${trackerIssue.currentState}". Owning slice: ${SLICE_S002}.`,
    ).toBe("closed");
  });

  it("S003: inspect the Phase 3 card -> it shows Unblocked and no longer lists WU-040 as a blocker (S003-O01)", async () => {
    // S003: navigate to the batches overview and inspect the Phase 3 card. Re-read
    // the downstream unit's blockedBy through the same plugin seam the start path
    // uses; closing the tracker (#700) cleared the gate ref from it.
    const downstream = phase3Issue;

    // S003-O01: the Phase 3 card no longer lists WU-040 / the gate tracker as a
    // blocker (so it now shows Unblocked).
    expect(
      downstream.blockedBy,
      `TC-040 step S003 (S003-O01) diverged: expected the Phase 3 unit's blockedBy to no longer list the gate tracker #${TRACKER_REF} after the close, got ${JSON.stringify(
        downstream.blockedBy,
      )}. Owning slice: ${SLICE_S003}.`,
    ).not.toContain(TRACKER_REF);
    expect(
      downstream.blockedBy,
      `TC-040 step S003 (S003-O01) diverged: expected the Phase 3 unit to be fully unblocked (empty blockedBy) after the gate close, got ${JSON.stringify(
        downstream.blockedBy,
      )}. Owning slice: ${SLICE_S003}.`,
    ).toEqual([]);
  });

  it("S004: start a new Phase 3 bench -> it starts with no blocked-by error referencing the gate (S004-O01)", async () => {
    // S004: start a new bench in Phase 3. Drive the REAL assertGateOpen (#699) with
    // enforcement ON and the post-close prefetched issue whose blockedBy is now
    // empty, so the start path issues no further RPC and must not block.
    let thrown: unknown;
    try {
      await assertGateOpen(PROJECT_ID, PHASE3_REF, PLUGIN_ID, {
        enforce: true,
        prefetchedIssue: phase3Issue,
      });
    } catch (err) {
      thrown = err;
    }

    // S004-O01: the Phase 3 bench starts with no blocked-by error referencing the
    // gate (assertGateOpen resolves without throwing GATE_BLOCKED).
    const blockedCode =
      thrown instanceof ServiceError
        ? (thrown.data as { code?: string } | undefined)?.code
        : undefined;
    expect(
      thrown,
      `TC-040 step S004 (S004-O01) diverged: expected the Phase 3 start to be allowed once the gate is closed and the unit is unblocked, but assertGateOpen threw ${
        blockedCode ?? String(thrown)
      }. Owning slice: ${SLICE_S004}.`,
    ).toBeUndefined();
  });
});
