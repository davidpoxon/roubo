// The pure, deterministic verify-gate evaluator (#698, FR-004, FR-005, NFR-007).
//
// `evaluateGate` computes a gate's passed / failed / pending / stale /
// no_gating_cases state from a worktree's recorded results over the gate's gating
// set. It is the join point of
// two already-merged contracts:
//   - the gate is a `kind: "verify"` work unit (VerifyUnit) from
//     `@roubo/shared/work-units-contract`, whose `implements.test_case_ids` IS the
//     pre-resolved gating set (architecture.md Data model, FR-004) and whose
//     `covers` lists the WU- ids that deliver those cases;
//   - the results are the `{ caseResults }` body produced by
//     `readPlanAndResults` in `testbench-store.ts`, each `CaseResult` carrying a
//     `derivedStatus`, an optional `statusOverride`, and an optional `orphaned`
//     marker (testbench-contracts.ts).
//
// Purity (NFR-007): this function does NO I/O. It never calls
// `readPlanAndResults` itself; the caller threads loaded inputs in. It reads no
// clock and mutates none of its inputs, so identical inputs yield a deep-equal
// `GateState`. The decision is therefore deterministic and, per NFR-007, can
// never false-pass: an absent, orphaned, or stale case is read as pending/stale,
// never as passed.
//
// The evaluation rule is encoded as an explicit, auditable precedence ladder
// (the truth table fixed in .specifications/verify-gate/verify-gate.md, the
// "results-to-passed rule" section, and FR-004 / FR-005). The module is kept pure
// so it can move to `shared/` for client reuse if needed (issue #698 technical
// note).

import type {
  BenchResults,
  CaseResult,
  CaseStatus,
  TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import type { Unit } from "@roubo/shared/work-units-contract";

// A VerifyUnit is a work unit whose durable semantic role is `verify`: its
// `implements.test_case_ids` is the gating set and `covers` lists the WU- ids it
// spans (architecture.md Data model). `covers` is optional on the base `Unit`;
// the evaluator tolerates its absence and treats it as an empty list.
export type VerifyUnit = Unit & { kind: "verify" };

// The terminal gate states. Order matches the precedence ladder below.
// `no_gating_cases` is the structural state for a gate whose (possibly narrowed)
// gating set is empty: it is not a pass (nothing was verified), and its guard
// precedes every results-driven rung so an all-L3/L4 gate never vacuously passes
// (issue #436, NFR-007 fail-closed).
export type GateStatus = "passed" | "failed" | "pending" | "stale" | "no_gating_cases";

// The computed projection returned by `evaluateGate`. Never persisted.
//
// Kept to the issue #698 technical note shape `{ status, unresolvedCaseIds,
// coveringUnitIds }`. The architecture.md Data model row additionally lists
// `gateId` and `evaluatedAt`, but `evaluatedAt` is deliberately omitted here: a
// clock read would break determinism and purity (NFR-007), the property the issue
// and FR rule pin down. A caller that needs an identity or a timestamp can stamp
// them from outside; the pure core stays free of both.
export interface GateState {
  status: GateStatus;
  // The gating case ids whose effective status is not `passed` (FR-004): the
  // remaining human-verification work. Empty exactly when the gate is passed.
  unresolvedCaseIds: string[];
  // The gate's `covers` WU- ids, surfaced as the units a verifier follows up on
  // for the unresolved cases (NFR-004 observability). Empty when nothing is
  // unresolved or the gate covers nothing.
  coveringUnitIds: string[];
}

// The slice of the recorded results the evaluator needs. `readPlanAndResults`
// returns `{ plan, results, stale, planHash, recovered }`; the caller threads the
// `results` (BenchResults, or null when no results exist yet) plus the file's own
// `planHash` so the staleness rule (results.planHash !== currentPlanHash) can be
// decided inside this pure function rather than depending on the store's
// pre-computed `stale` flag. Passing `null` models "no results recorded yet".
export type GateResults = (BenchResults & { planHash: string }) | null;

// The default gating policy (FR-005): a case gates when its level is L1 or L2, OR
// its category (the case `type` field) is `e2e_flow`. L3 and L4 cases are tracked
// but excluded; they belong in an automation / regression backlog, not a human's
// blocking queue. This narrowing only applies when the plan is threaded in (see
// the `plan` parameter on `evaluateGate`); without a plan the gate's
// `implements.test_case_ids` is already the pre-resolved gating set and is used
// verbatim.
const GATING_LEVELS: ReadonlySet<number> = new Set([1, 2]);
const GATING_CATEGORY = "e2e_flow";

function caseGatesByDefaultPolicy(level: number, category: string): boolean {
  return GATING_LEVELS.has(level) || category === GATING_CATEGORY;
}

// Effective status = the override when present, else the derived status (FR-005,
// NFR-007). An override always wins over the derived value.
function effectiveStatus(result: CaseResult): CaseStatus {
  return result.statusOverride?.status ?? result.derivedStatus;
}

// Evaluate a verify gate's state. Pure and synchronous: no I/O, no clock, no
// input mutation (NFR-007).
//
// `gate`            the VerifyUnit; `implements.test_case_ids` is the gating set,
//                   `covers` the WU- ids it spans.
// `results`         the recorded results (`{ caseResults, planHash }`), or null
//                   when none exist yet. Null is treated as stale (the plan has
//                   never been verified against), never as passed.
// `currentPlanHash` the freshly computed hash of the live plan; the gate is stale
//                   when the results' planHash does not match it.
// `plan`            optional. When supplied, the gating set is narrowed to the
//                   default policy (L1/L2 + e2e_flow, L3/L4 excluded) using each
//                   case's level/type from the plan. When omitted, the gate's
//                   `implements.test_case_ids` is used verbatim as the already
//                   pre-resolved gating set (architecture.md fixes the 3-arg
//                   signature; the plan is the optional fourth input the L3/L4
//                   filter needs when the set is not pre-narrowed).
export function evaluateGate(
  gate: VerifyUnit,
  results: GateResults,
  currentPlanHash: string,
  plan?: TestCasesPlan,
): GateState {
  const coveringUnitIds = gate.covers ?? [];

  // Resolve the gating set: the gate's declared test case ids, optionally
  // narrowed to the default policy when a plan is available.
  const declaredIds = gate.implements.test_case_ids;
  let gatingCaseIds: string[];
  if (plan) {
    const caseById = new Map(plan.cases.map((c) => [c.id, c]));
    gatingCaseIds = declaredIds.filter((id) => {
      const planCase = caseById.get(id);
      // A declared id with no matching plan case cannot be classified by level,
      // so it stays in the gating set and is resolved by status below (it will
      // read as pending when absent from results). Dropping it could mask an
      // unverified case, which NFR-007 forbids.
      if (!planCase) return true;
      return caseGatesByDefaultPolicy(planCase.level, planCase.type);
    });
  } else {
    gatingCaseIds = [...declaredIds];
  }

  // Precedence ladder (order-sensitive). The first rung that matches wins.

  // (0) NO GATING CASES: the (possibly narrowed) gating set is empty. This is a
  // structural fact independent of any recorded results, so it must be decided
  // before the results-driven rungs (including STALE): an empty gating set is not
  // "must be re-verified", it is "there is nothing to gate on". Crucially it must
  // never fall through to the PASSED rung, where an empty unresolved set would
  // read as a vacuous pass (an all-L3/L4 gate narrows to `[]`), violating
  // NFR-007's fail-closed intent (issue #436). Sign-off stays gated on `passed`,
  // so a no-gating-cases phase is correctly non-signable.
  if (gatingCaseIds.length === 0) {
    return { status: "no_gating_cases", unresolvedCaseIds: [], coveringUnitIds: [] };
  }

  // (1) STALE: results absent, or the results' planHash does not match the live
  // plan hash. The batch must be re-verified; stale never reads as passed.
  if (results === null || results.planHash !== currentPlanHash) {
    return {
      status: "stale",
      unresolvedCaseIds: [...gatingCaseIds],
      coveringUnitIds: gatingCaseIds.length > 0 ? coveringUnitIds : [],
    };
  }

  const caseResults = results.caseResults;

  // Classify each gating case once, by reading its effective status (and its
  // absence / orphaned markers), so the rungs below are a pure read over this.
  let anyFailedOrBlocked = false;
  let anyPending = false;
  const unresolvedCaseIds: string[] = [];

  for (const id of gatingCaseIds) {
    const result = caseResults[id];

    // Absent from results, or retained-but-orphaned, reads as pending: the case
    // is unverified, never passed (FR-004, NFR-007).
    if (result === undefined || result.orphaned === true) {
      anyPending = true;
      unresolvedCaseIds.push(id);
      continue;
    }

    const status = effectiveStatus(result);
    if (status === "failed" || status === "blocked") {
      anyFailedOrBlocked = true;
      unresolvedCaseIds.push(id);
    } else if (status === "not_started" || status === "in_progress") {
      anyPending = true;
      unresolvedCaseIds.push(id);
    }
    // status === "passed": resolved, contributes nothing to the unresolved set.
  }

  // (2) FAILED: any gating case effective status is failed or blocked.
  if (anyFailedOrBlocked) {
    return { status: "failed", unresolvedCaseIds, coveringUnitIds };
  }

  // (3) PENDING: any gating case is not_started / in_progress, absent, or
  // orphaned (and none failed/blocked).
  if (anyPending) {
    return { status: "pending", unresolvedCaseIds, coveringUnitIds };
  }

  // (4) PASSED: every gating case effective status is passed. Nothing unresolved.
  return { status: "passed", unresolvedCaseIds: [], coveringUnitIds: [] };
}
