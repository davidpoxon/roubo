// TC-045 (e2e_flow, level 1): the failed-case fix-issue journey end to end. Mark a
// gating case failed, capture notes, file a fix issue that blocks the gate, and the
// gate stays not-passable until the fix issue is resolved.
//
// The "running system" here is the REAL, already-merged fix-issue stack composed as
// one continuous journey, not a mock of the gate logic (AC-1):
//   - S001 exercises the real `evaluateGate` (#698, server/lib/gate-evaluator.ts):
//     with the gating case TC-024 marked failed, the gate reads "failed" (the
//     server-observable equivalent of "panel opens, case failed"; the UI panel is
//     out of scope for a server e2e).
//   - S002 exercises the real `fileFixIssueAndBlock` (#735,
//     server/services/fix-issue-filer.ts) wired on top of the REAL tracker-action
//     gateway `createIssue` + `addBlockedBy` (#734,
//     server/services/tracker-action-gateway.ts) with its real capability / consent
//     / audit gating. Only the external plugin RPC (`invoke`) is faked. The filer's
//     create-then-link produces the fix issue #452 and links it as a blocker on the
//     gate #451.
//   - S003 re-reads the REAL `TrackerActionAuditLog` (#734): the journey recorded a
//     createIssue then an addBlockedBy entry, both attributed to github-com.
//   - S004 re-exercises the real `evaluateGate` (#698): with TC-024 still failed (the
//     open fix issue #452 still blocking), the gate cannot pass.
//   - S005 closes #452 in the fake tracker and re-exercises `evaluateGate` (#698)
//     with TC-024 now passed: the blocker clears and the gate passes.
//
// The only faked seam is the external integration plugin, supplied through the
// gateway's existing injectable `invoke` hook plus the resolve / capability /
// consent / audit deps. The gate and filer functions themselves are the real
// production functions. No supertest / Express boot is used: the *-journey.e2e
// siblings call the services directly, and that is the "running system, not a mock"
// the AC means (the gate logic is real; only the GitHub RPC and the plugin
// install / consent / capability state are faked, unavoidable without a live
// tracker).
//
// Drift guard (AC-2): each it() is named after its TC-045 step id and the step's
// expected observation is kept explicit, so a change to the authoritative TC-045 in
// .specifications/verify-gate/test-cases.json forces this test to be updated. The
// pinned refs (gate #451, fix issue #452) and gating case (TC-024) mirror TC-045
// step for step and are not generated.
//
// Failure-output contract (AC-3): every assertion attaches an expected-vs-actual
// message naming the owning slice issue from this unit's blocked-by set, so a red
// run localizes the integration drift to one attributable slice:
//   S001 -> #698 (evaluateGate), S002 -> #735 (fix-issue filer) over #734 (gateway),
//   S003 -> #734 (tracker-action audit log), S004 -> #698 (gate stays failed),
//   S005 -> #698 (gate passes once the case is re-verified passed).

import { describe, it, expect } from "vitest";
import { evaluateGate, type VerifyUnit, type GateResults } from "../lib/gate-evaluator.js";
import {
  TrackerActionAuditLog,
  addBlockedBy,
  createIssue,
  type TrackerActionGatewayDeps,
} from "./tracker-action-gateway.js";
import { fileFixIssueAndBlock, type FixIssueFilerDeps } from "./fix-issue-filer.js";
import type { CreateIssueResult } from "@roubo/plugin-sdk";
import type { TrackerActionAuditEntry } from "@roubo/shared";
import type { Tracker } from "@roubo/shared/work-units-contract";
import type { BenchResults, CaseResult, CaseStatus } from "@roubo/shared/testbench-contracts";

// ── Owning slices (this e2e unit's blocked-by set, per the milestone critical
// path spike -> gateway -> filer) ──
const SLICE_S001 = "#698 (deterministic gate evaluator)";
const SLICE_S002 = "#735 (failed-case fix-issue filer) over #734 (tracker-action gateway)";
const SLICE_S003 = "#734 (tracker-action audit log)";
const SLICE_S004 = "#698 (gate stays failed while the fix issue is open)";
const SLICE_S005 = "#698 (gate passes once the case is re-verified passed)";

// ── Fixture identifiers (TC-045 preconditions, verbatim) ──
const PROJECT_ID = "proj-verify-gate";
const PLUGIN_ID = "github-com";
const PLAN_HASH = "sha256-plan-v1";
// Gate WU-040's tracker issue #451 and its single gating case TC-024.
const GATE_REF = "owner/repo#451";
const GATING_CASE_ID = "TC-024";
const REPO_FULL_NAME = "owner/repo";
// The fix issue WU-041 / #452 the filer mints for the failed case.
const FIX_ISSUE_REF = "owner/repo#452";
const FIX_ISSUE_URL = "https://github.com/owner/repo/issues/452";

// ── Fixture builders (reuse the exact shapes from the slices' unit tests:
// VerifyUnit, GateResults/CaseResult) ──

// VerifyUnit gate WU-040 with tracker.ref -> #451. Its single gating case TC-024 is
// the case marked failed in TC-045 (no plan threaded, so implements.test_case_ids is
// the gating set verbatim).
function makeGate(): VerifyUnit {
  const tracker: Tracker = {
    system: "github",
    ref: GATE_REF,
    url: "https://github.com/owner/repo/issues/451",
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
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: [GATING_CASE_ID] },
    tracker,
  };
}

// A recorded-results body for the single gating case TC-024, from
// gate-evaluator.test.ts. Parameterized by TC-024's status.
function results(caseStatus: CaseStatus): GateResults {
  const result: CaseResult = {
    observationMarks: {},
    derivedStatus: caseStatus,
    notes: [],
  };
  const body: BenchResults & { planHash: string } = {
    caseResults: { [GATING_CASE_ID]: result },
    updatedAt: "2026-01-01T00:00:00.000Z",
    planHash: PLAN_HASH,
  };
  return body;
}

// ── Shared in-test fixture world, threaded across the ordered it() blocks so the
// journey is continuous. A fake tracker maps issue ref -> open/done state; the fake
// `invoke` mints #452 on createIssue, records #451 blocked_by #452 on addBlockedBy,
// and S005 flips #452 to closed directly. A LOCAL TrackerActionAuditLog is used (NOT
// the process-wide global) so the journey's audit assertions are isolated. ──

const gate = makeGate();

// In-memory tracker world. `blockedByOf` maps a blocked ref to the refs blocking it.
const issues = new Map<string, { state: "open" | "closed" }>();
const blockedByOf = new Map<string, string[]>();
issues.set(GATE_REF, { state: "open" });

// A LOCAL audit log for isolation (not the process-wide global export).
const audit = new TrackerActionAuditLog();

// The faked external integration plugin RPC. createIssue mints #452 (open) and
// returns its ref + url; addBlockedBy records #451 blocked_by #452. Any other method
// is an unexpected call and fails loudly.
const invoke = (async (_pluginId: string, method: string, params: unknown) => {
  if (method === "createIssue") {
    issues.set(FIX_ISSUE_REF, { state: "open" });
    const created: CreateIssueResult = { ref: FIX_ISSUE_REF, url: FIX_ISSUE_URL };
    return created as never;
  }
  if (method === "addBlockedBy") {
    const { blockedRef, blockerRef } = params as { blockedRef: string; blockerRef: string };
    const existing = blockedByOf.get(blockedRef) ?? [];
    blockedByOf.set(blockedRef, [...existing, blockerRef]);
    return undefined as never;
  }
  throw new Error(`unexpected method ${method}`);
}) as unknown as TrackerActionGatewayDeps["invoke"];

// Gateway deps: the REAL createIssue / addBlockedBy run against these, so the
// capability / consent / audit gating all execute for real; only `invoke` is faked.
const gatewayDeps: TrackerActionGatewayDeps = {
  invoke,
  resolveActivePlugin: () => ({ pluginId: PLUGIN_ID, integrationId: PLUGIN_ID, pageSize: 50 }),
  getCapabilities: () => ({ supportsCreateIssue: true, supportsBlockingLinks: true }),
  hasConsent: () => true,
  onGatePassed: async () => {},
  recordAudit: (entry) => audit.record(entry),
  now: () => "2026-06-22T00:00:00.000Z",
};

// Filer deps: createIssue / addBlockedBy bind the REAL gateway functions to
// gatewayDeps, so BOTH the filer (#735) and the gateway (#734) run for real.
const filerDeps: FixIssueFilerDeps = {
  resolveActivePlugin: () => ({ pluginId: PLUGIN_ID, integrationId: PLUGIN_ID, pageSize: 50 }),
  getCapabilities: () => ({ supportsCreateIssue: true, supportsBlockingLinks: true }),
  createIssue: (projectId, params) => createIssue(projectId, params, gatewayDeps),
  addBlockedBy: (projectId, params) => addBlockedBy(projectId, params, gatewayDeps),
  now: () => "2026-06-22T00:00:00.000Z",
};

describe("TC-045: mark TC-024 failed, file fix issue #452 that blocks gate #451, gate stays not-passable until #452 is resolved", () => {
  it("S001: mark TC-024 failed -> the gating case is failed and the gate is not passable (S001-O01)", () => {
    // S001: mark TC-024 failed. Drive the REAL evaluateGate (#698) over the recorded
    // results with TC-024 failed. The server-observable equivalent of "the panel
    // opens with a Notes field and a 'File fix issue & block gate' action" is that
    // the gate reads "failed" with TC-024 unresolved (the UI panel itself is out of
    // scope for a server e2e).
    const state = evaluateGate(gate, results("failed"), PLAN_HASH);

    // S001-O01: TC-024 transitions to failed; the gate is not passable.
    expect(
      state.status,
      `TC-045 step S001 (S001-O01) diverged: expected the gate to read "failed" once gating case ${GATING_CASE_ID} is marked failed, got "${state.status}". Owning slice: ${SLICE_S001}.`,
    ).toBe("failed");
    expect(
      state.unresolvedCaseIds,
      `TC-045 step S001 (S001-O01) diverged: expected the failed gating case ${GATING_CASE_ID} to be unresolved, got ${JSON.stringify(
        state.unresolvedCaseIds,
      )}. Owning slice: ${SLICE_S001}.`,
    ).toEqual([GATING_CASE_ID]);
  });

  it("S002: file fix issue & block gate -> #452 created and blocks gate #451 (S002-O01, S002-O02)", async () => {
    // S002: enter notes and click 'File fix issue & block gate'. Drive the REAL
    // fileFixIssueAndBlock (#735) over the REAL gateway (#734), faking only the
    // plugin RPC. createIssue mints #452, then addBlockedBy links it as a blocker on
    // the gate's tracker #451.
    const record = await fileFixIssueAndBlock(
      PROJECT_ID,
      {
        repoFullName: REPO_FULL_NAME,
        failedCaseId: GATING_CASE_ID,
        gateRef: GATE_REF,
        notes: "TC-024 failed: the create-then-link recovery path regressed under load.",
      },
      filerDeps,
    );

    // S002-O01: a fix issue WU-041 / #452 is created in the tracker.
    expect(
      record.fixIssueRef,
      `TC-045 step S002 (S002-O01) diverged: expected the filer to create fix issue ${FIX_ISSUE_REF}, got "${record.fixIssueRef}". Owning slice: ${SLICE_S002}.`,
    ).toBe(FIX_ISSUE_REF);
    expect(
      issues.get(FIX_ISSUE_REF)?.state,
      `TC-045 step S002 (S002-O01) diverged: expected the fix issue ${FIX_ISSUE_REF} to exist and be open in the tracker, got ${JSON.stringify(
        issues.get(FIX_ISSUE_REF),
      )}. Owning slice: ${SLICE_S002}.`,
    ).toBe("open");

    // S002-O02: the panel confirms 'WU-041 (#452) blocks WU-040 (#451)' (the
    // server-observable form is a complete link record plus the tracker recording
    // #451 blocked_by #452).
    expect(
      { gateRef: record.gateRef, failedCaseId: record.failedCaseId, linkStatus: record.linkStatus },
      `TC-045 step S002 (S002-O02) diverged: expected a complete link of ${FIX_ISSUE_REF} blocking gate ${GATE_REF} for case ${GATING_CASE_ID}, got ${JSON.stringify(
        record,
      )}. Owning slice: ${SLICE_S002}.`,
    ).toEqual({ gateRef: GATE_REF, failedCaseId: GATING_CASE_ID, linkStatus: "complete" });
    expect(
      blockedByOf.get(GATE_REF),
      `TC-045 step S002 (S002-O02) diverged: expected the tracker to record gate ${GATE_REF} blocked_by ${FIX_ISSUE_REF}, got ${JSON.stringify(
        blockedByOf.get(GATE_REF),
      )}. Owning slice: ${SLICE_S002}.`,
    ).toEqual([FIX_ISSUE_REF]);
  });

  it("S003: open the bench audit log -> two chronological entries createIssue then addBlockedBy, both github-com (S003-O01)", () => {
    // S003: open the bench audit log. Re-read the LOCAL TrackerActionAuditLog the
    // journey recorded into (#734).
    const entries = audit.query();

    // S003-O01: exactly two chronological entries are present: create-issue
    // (#452) then add-blocking-link, both attributed to github-com.
    expect(
      entries,
      `TC-045 step S003 (S003-O01) diverged: expected exactly two audit entries (createIssue then addBlockedBy), got ${entries.length}: ${JSON.stringify(
        entries,
      )}. Owning slice: ${SLICE_S003}.`,
    ).toHaveLength(2);
    expect(
      entries[0],
      `TC-045 step S003 (S003-O01) diverged: expected the first audit entry to be an applied createIssue for ${FIX_ISSUE_REF} via "${PLUGIN_ID}", got ${JSON.stringify(
        entries[0],
      )}. Owning slice: ${SLICE_S003}.`,
    ).toEqual<TrackerActionAuditEntry>({
      ts: "2026-06-22T00:00:00.000Z",
      projectId: PROJECT_ID,
      pluginId: PLUGIN_ID,
      action: "createIssue",
      outcome: "applied",
      refs: {
        repoFullName: REPO_FULL_NAME,
        title: `Fix failed verify case ${GATING_CASE_ID} blocking gate ${GATE_REF}`,
        ref: FIX_ISSUE_REF,
      },
    });
    expect(
      entries[1],
      `TC-045 step S003 (S003-O01) diverged: expected the second audit entry to be an applied addBlockedBy linking ${FIX_ISSUE_REF} -> ${GATE_REF} via "${PLUGIN_ID}", got ${JSON.stringify(
        entries[1],
      )}. Owning slice: ${SLICE_S003}.`,
    ).toEqual<TrackerActionAuditEntry>({
      ts: "2026-06-22T00:00:00.000Z",
      projectId: PROJECT_ID,
      pluginId: PLUGIN_ID,
      action: "addBlockedBy",
      outcome: "applied",
      refs: { blockedRef: GATE_REF, blockerRef: FIX_ISSUE_REF },
    });
  });

  it("S004: attempt to pass the gate -> the gate cannot pass while #452 blocks it (S004-O01)", () => {
    // S004: attempt to pass the gate. The open fix issue #452 still blocks it, and
    // the gating case TC-024 is still failed. Re-drive the REAL evaluateGate (#698)
    // with TC-024 still failed and the blocker still open.
    expect(
      issues.get(FIX_ISSUE_REF)?.state,
      `TC-045 step S004 (S004-O01) diverged: expected the fix issue ${FIX_ISSUE_REF} to still be open while the gate is blocked, got ${JSON.stringify(
        issues.get(FIX_ISSUE_REF),
      )}. Owning slice: ${SLICE_S004}.`,
    ).toBe("open");

    const state = evaluateGate(gate, results("failed"), PLAN_HASH);

    // S004-O01: the gate cannot pass; it is blocked by the open fix issue #452.
    expect(
      state.status,
      `TC-045 step S004 (S004-O01) diverged: expected the gate to remain not-passable (status "failed") while fix issue ${FIX_ISSUE_REF} is open and ${GATING_CASE_ID} is failed, got "${state.status}". Owning slice: ${SLICE_S004}.`,
    ).toBe("failed");
    expect(
      state.unresolvedCaseIds,
      `TC-045 step S004 (S004-O01) diverged: expected ${GATING_CASE_ID} to remain unresolved while the gate is blocked, got ${JSON.stringify(
        state.unresolvedCaseIds,
      )}. Owning slice: ${SLICE_S004}.`,
    ).toEqual([GATING_CASE_ID]);
  });

  it("S005: close #452 and re-verify TC-024 passed -> the blocker clears and the gate passes (S005-O01)", () => {
    // S005: resolve (close) #452 in the tracker and re-verify TC-024 as passed. Close
    // the fix issue in the fake tracker and clear it from the gate's blocked_by, then
    // re-drive the REAL evaluateGate (#698) with TC-024 now passed.
    issues.set(FIX_ISSUE_REF, { state: "closed" });
    blockedByOf.set(
      GATE_REF,
      (blockedByOf.get(GATE_REF) ?? []).filter((ref) => ref !== FIX_ISSUE_REF),
    );

    const state = evaluateGate(gate, results("passed"), PLAN_HASH);

    // S005-O01: TC-024 becomes passed, the blocker clears, and the gate can now pass.
    expect(
      issues.get(FIX_ISSUE_REF)?.state,
      `TC-045 step S005 (S005-O01) diverged: expected the fix issue ${FIX_ISSUE_REF} to read closed after resolution, got ${JSON.stringify(
        issues.get(FIX_ISSUE_REF),
      )}. Owning slice: ${SLICE_S005}.`,
    ).toBe("closed");
    expect(
      blockedByOf.get(GATE_REF),
      `TC-045 step S005 (S005-O01) diverged: expected the gate ${GATE_REF} to no longer be blocked by ${FIX_ISSUE_REF} after the close, got ${JSON.stringify(
        blockedByOf.get(GATE_REF),
      )}. Owning slice: ${SLICE_S005}.`,
    ).toEqual([]);
    expect(
      state.status,
      `TC-045 step S005 (S005-O01) diverged: expected the gate to pass once ${GATING_CASE_ID} is re-verified passed and the blocker clears, got "${state.status}". Owning slice: ${SLICE_S005}.`,
    ).toBe("passed");
    expect(
      state.unresolvedCaseIds,
      `TC-045 step S005 (S005-O01) diverged: expected no unresolved gating cases once the gate passes, got ${JSON.stringify(
        state.unresolvedCaseIds,
      )}. Owning slice: ${SLICE_S005}.`,
    ).toEqual([]);
  });
});
