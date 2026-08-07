// The pure, deterministic verify-gate evaluator (#698, VG-FR-004, VG-FR-005, VG-NFR-007).
//
// `evaluateGate` computes a gate's passed / failed / pending / stale /
// no_gating_cases state from a worktree's recorded results over the gate's gating
// set. It is the join point of
// two already-merged contracts:
//   - the gate is a `kind: "verify"` work unit (VerifyUnit) from
//     `@roubo/shared/work-units-contract`, whose `implements.test_case_ids` IS the
//     pre-resolved gating set (architecture.md Data model, VG-FR-004) and whose
//     `covers` lists the WU- ids that deliver those cases;
//   - the results are the `{ caseResults }` body produced by
//     `readPlanAndResults` in `testbench-store.ts`, each `CaseResult` carrying a
//     `derivedStatus`, an optional `statusOverride`, and an optional `orphaned`
//     marker (testbench-contracts.ts).
//
// As of #768 the narrowing step also honours the case lifecycle block
// (SATCA-FR-008..SATCA-FR-012): a retired case leaves the effective gating set, a
// superseded case's status is read from the case its replacement chain resolved
// to, an unresolvable pointer keeps the case in the set as unresolved, and an
// emptied gating set says whether lifecycle or the level/type policy emptied it.
// The resolution itself is computed by the pure `@roubo/shared/lifecycle-resolver`
// and threaded in by the caller, exactly as the plan is; this module never walks a
// pointer of its own, so the gate, the rollup, and the authoring-time picker
// cannot diverge on depth or cycle handling.
//
// Purity (VG-NFR-007): this function does NO I/O. It never calls
// `readPlanAndResults` itself; the caller threads loaded inputs in. It reads no
// clock and mutates none of its inputs, so identical inputs yield a deep-equal
// `GateState`. The decision is therefore deterministic and, per VG-NFR-007, can
// never false-pass: an absent, orphaned, or stale case is read as pending/stale,
// never as passed.
//
// The evaluation rule is encoded as an explicit, auditable precedence ladder
// (the truth table fixed in .specifications/verify-gate/verify-gate.md, the
// "results-to-passed rule" section, and VG-FR-004 / VG-FR-005). The module is kept pure
// so it can move to `shared/` for client reuse if needed (issue #698 technical
// note).

import type {
  BenchResults,
  CaseResult,
  CaseStatus,
  TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import type { Resolution } from "@roubo/shared/lifecycle-resolver";
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
// (issue #436, VG-NFR-007 fail-closed).
export type GateStatus = "passed" | "failed" | "pending" | "stale" | "no_gating_cases";

// WHY a gate's gating set ended up empty (SATCA-FR-011, #768). Reported on the
// `no_gating_cases` rung only, and null on every other rung.
//
//   "policy"    every declared case was excluded by the default level/type policy
//               (all L3/L4, none e2e_flow), the pre-existing #436 shape.
//   "lifecycle" every declared case left the set because its own lifecycle block
//               retired it (SATCA-FR-008).
//   "mixed"     both rules fired over different declared cases.
//
// Null when the gate declared no cases at all: nothing emptied the set, it was
// never populated, and attributing that to a rule would be a lie. The distinction
// the PRD actually requires is lifecycle-versus-policy; `mixed` exists so an
// attribution is never silently rounded to one of the two.
export type GateEmptyReason = "policy" | "lifecycle" | "mixed";

// The computed projection returned by `evaluateGate`. Never persisted.
//
// Kept to the issue #698 technical note shape `{ status, unresolvedCaseIds,
// coveringUnitIds }`. The architecture.md Data model row additionally lists
// `gateId` and `evaluatedAt`, but `evaluatedAt` is deliberately omitted here: a
// clock read would break determinism and purity (VG-NFR-007), the property the issue
// and FR rule pin down. A caller that needs an identity or a timestamp can stamp
// them from outside; the pure core stays free of both.
export interface GateState {
  status: GateStatus;
  // The gating case ids whose effective status is not `passed` (VG-FR-004): the
  // remaining human-verification work. Empty exactly when the gate is passed.
  unresolvedCaseIds: string[];
  // The full narrowed gating set: every case this gate evaluates over, after the
  // default-policy narrowing (L1/L2 + e2e_flow). Its length is the gate's total
  // gating-case count, surfaced on the Batches overview (issue #433). Unlike
  // `unresolvedCaseIds` this is populated in every rung including `passed`, so the
  // count always traces to the same set the evaluator gates on.
  gatingCaseIds: string[];
  // The gate's `covers` WU- ids, surfaced as the units a verifier follows up on
  // for the unresolved cases (VG-NFR-004 observability). Empty when nothing is
  // unresolved or the gate covers nothing.
  coveringUnitIds: string[];
  // Why the gating set is empty, on the `no_gating_cases` rung only (SATCA-FR-011).
  // Null on every other rung, and null on an empty set the gate never declared
  // anything into. See `GateEmptyReason`.
  emptyReason: GateEmptyReason | null;
  // The declared case ids lifecycle removed from the effective gating set: the
  // cases whose own `retired` block ended their obligation (SATCA-FR-008), in the
  // order the gate declared them. Populated on EVERY rung, not just the empty one:
  // a gate can pass precisely BECAUSE a case was retired, and the operator reading
  // a passed gate is owed the reason it passed. `emptyReason` only ever answers
  // that question for a gate lifecycle emptied outright, which is the narrower
  // case. Empty when lifecycle dropped nothing (the pre-#777 shape, byte for byte).
  lifecycleExcludedCaseIds: string[];
}

// The slice of the recorded results the evaluator needs. `readPlanAndResults`
// returns `{ plan, results, stale, planHash, recovered }`; the caller threads the
// `results` (BenchResults, or null when no results exist yet) plus the file's own
// `planHash` so the staleness rule (results.planHash !== currentPlanHash) can be
// decided inside this pure function rather than depending on the store's
// pre-computed `stale` flag. Passing `null` models "no results recorded yet".
export type GateResults = (BenchResults & { planHash: string }) | null;

// The caller-threaded lifecycle view (#768, SATCA-FR-008..SATCA-FR-012).
//
// `resolutions` is what `resolvePlan` (shared/lifecycle-resolver.ts) returned for
// the gate's OWN plan: one Resolution per plan case, keyed here by
// `origin.caseId`. The evaluator never calls the resolver and never loads a
// referenced spec itself; the caller uses the resolver's `collectReferencedSlugs`
// to decide what to pre-load and threads the result in, so purity and determinism
// hold (SATCA-FR-012, VG-NFR-007) and the three resolver consumers cannot diverge
// on depth or cycle handling.
//
// `resultsBySlug` carries the recorded results of any OTHER spec a resolution
// landed in, keyed by spec slug, so a cross-spec replacement's status can be read
// (SATCA-TC-029). Same-spec replacements are read from the gate's own `results`
// and need no entry. A resolution that landed in a slug with no entry here is
// treated as unresolved rather than as passed: every gap degrades to unresolved,
// never to a pass.
//
// Omitting the whole input preserves the pre-#768 behaviour byte for byte.
export interface GateLifecycle {
  resolutions: readonly Resolution[];
  resultsBySlug?: ReadonlyMap<string, BenchResults>;
}

// The default gating policy (VG-FR-005): a case gates when its level is L1 or L2, OR
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

// Effective status = the override when present, else the derived status (VG-FR-005,
// VG-NFR-007). An override always wins over the derived value.
function effectiveStatus(result: CaseResult): CaseStatus {
  return result.statusOverride?.status ?? result.derivedStatus;
}

// Evaluate a verify gate's state. Pure and synchronous: no I/O, no clock, no
// input mutation (VG-NFR-007).
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
// `lifecycle`       optional. The caller-threaded resolution of the plan's
//                   lifecycle blocks (see `GateLifecycle`). When supplied, a
//                   retired case leaves the gating set (SATCA-FR-008), a
//                   superseded case's status is read from the case its chain
//                   resolved to (SATCA-FR-009), and an unresolvable pointer keeps
//                   the case in the set as unresolved so the gate cannot pass
//                   (SATCA-FR-010). Omitted, the gate ignores lifecycle exactly as
//                   it did before #768.
export function evaluateGate(
  gate: VerifyUnit,
  results: GateResults,
  currentPlanHash: string,
  plan?: TestCasesPlan,
  lifecycle?: GateLifecycle,
): GateState {
  const coveringUnitIds = gate.covers ?? [];

  // Index the threaded resolutions by the case they are about. First entry wins
  // for a duplicated origin id (a plan cannot hold two cases with one id, so this
  // only guards a malformed caller).
  const resolutionById = new Map<string, Resolution>();
  for (const resolution of lifecycle?.resolutions ?? []) {
    if (!resolutionById.has(resolution.origin.caseId)) {
      resolutionById.set(resolution.origin.caseId, resolution);
    }
  }

  // Narrow the gating set: the gate's declared test case ids, minus what
  // lifecycle retires and what the default level/type policy excludes. Both rules
  // are applied in ONE walk that records which rule dropped each id, so an emptied
  // set can name its cause (SATCA-FR-011) instead of the caller having to guess.
  //
  // Lifecycle is evaluated BEFORE the policy filter so the attribution is
  // deterministic: a retired L3 case is reported as dropped by lifecycle, not by
  // policy, whichever order the ids happen to be declared in.
  const declaredIds = gate.implements.test_case_ids;
  const caseById = plan ? new Map(plan.cases.map((c) => [c.id, c])) : null;
  const gatingCaseIds: string[] = [];
  // The ids lifecycle removed, kept as a list rather than only as the boolean the
  // `emptyReason` attribution needs, so a gate that merely NARROWED can still name
  // which declared cases lifecycle excluded (#777, SATCA-TC-033 S003-O02).
  const lifecycleExcludedCaseIds: string[] = [];
  let droppedByPolicy = false;
  for (const id of declaredIds) {
    // A retired case's obligation ENDS rather than transferring, so it leaves the
    // effective gating set and can no longer hold the gate pending (SATCA-FR-008).
    // The gate's declared `implements.test_case_ids` is untouched: the narrowing is
    // computed here, never written back to the work unit.
    if (resolutionById.get(id)?.status === "retired") {
      lifecycleExcludedCaseIds.push(id);
      continue;
    }
    if (caseById) {
      const planCase = caseById.get(id);
      // A declared id with no matching plan case cannot be classified by level,
      // so it stays in the gating set and is resolved by status below (it will
      // read as pending when absent from results). Dropping it could mask an
      // unverified case, which VG-NFR-007 forbids.
      if (planCase && !caseGatesByDefaultPolicy(planCase.level, planCase.type)) {
        droppedByPolicy = true;
        continue;
      }
    }
    gatingCaseIds.push(id);
  }

  // Precedence ladder (order-sensitive). The first rung that matches wins.

  // (0) NO GATING CASES: the (possibly narrowed) gating set is empty. This is a
  // structural fact independent of any recorded results, so it must be decided
  // before the results-driven rungs (including STALE): an empty gating set is not
  // "must be re-verified", it is "there is nothing to gate on". Crucially it must
  // never fall through to the PASSED rung, where an empty unresolved set would
  // read as a vacuous pass (an all-L3/L4 gate narrows to `[]`), violating
  // VG-NFR-007's fail-closed intent (issue #436). Sign-off stays gated on `passed`,
  // so a no-gating-cases phase is correctly non-signable.
  if (gatingCaseIds.length === 0) {
    return {
      status: "no_gating_cases",
      unresolvedCaseIds: [],
      gatingCaseIds: [],
      coveringUnitIds: [],
      // Name what emptied it (SATCA-FR-011): a set the level/type policy narrowed
      // away is a different situation from one lifecycle retired away, and the two
      // call for different operator responses.
      emptyReason:
        lifecycleExcludedCaseIds.length > 0 && droppedByPolicy
          ? "mixed"
          : lifecycleExcludedCaseIds.length > 0
            ? "lifecycle"
            : droppedByPolicy
              ? "policy"
              : null,
      lifecycleExcludedCaseIds,
    };
  }

  // (1) STALE: results absent, or the results' planHash does not match the live
  // plan hash. The batch must be re-verified; stale never reads as passed.
  if (results === null || results.planHash !== currentPlanHash) {
    return {
      status: "stale",
      unresolvedCaseIds: [...gatingCaseIds],
      gatingCaseIds: [...gatingCaseIds],
      coveringUnitIds: gatingCaseIds.length > 0 ? coveringUnitIds : [],
      emptyReason: null,
      lifecycleExcludedCaseIds,
    };
  }

  const caseResults = results.caseResults;

  // Classify each gating case once, by reading its effective status (and its
  // absence / orphaned markers), so the rungs below are a pure read over this.
  let anyFailedOrBlocked = false;
  let anyPending = false;
  const unresolvedCaseIds: string[] = [];

  for (const id of gatingCaseIds) {
    // Where this case's status is actually read from. A superseded case whose
    // chain resolved keeps its DECLARED id in `gatingCaseIds` (the gate still
    // gates on the obligation it declared) while its status comes from the case
    // the chain landed on (SATCA-FR-009). An unresolvable pointer, or a landing in
    // a spec whose results the caller did not thread in, degrades to unresolved so
    // the gate can never reach the PASSED rung (SATCA-FR-010, VG-NFR-007).
    const resolution = resolutionById.get(id);
    let result: CaseResult | undefined;
    if (resolution !== undefined && resolution.status === "unresolved") {
      anyPending = true;
      unresolvedCaseIds.push(id);
      continue;
    } else if (resolution !== undefined && resolution.status === "resolved") {
      // `resolvedTo` is non-null on a "resolved" status by the resolver's own
      // contract; the guard keeps a malformed input failing closed rather than
      // silently reading the origin's own (stale) result.
      const target = resolution.resolvedTo;
      if (target === null) {
        anyPending = true;
        unresolvedCaseIds.push(id);
        continue;
      }
      if (target.slug === resolution.origin.slug) {
        result = caseResults[target.caseId];
      } else {
        const foreign = lifecycle?.resultsBySlug?.get(target.slug);
        if (foreign === undefined) {
          anyPending = true;
          unresolvedCaseIds.push(id);
          continue;
        }
        result = foreign.caseResults[target.caseId];
      }
    } else {
      result = caseResults[id];
    }

    // Absent from results, or retained-but-orphaned, reads as pending: the case
    // is unverified, never passed (VG-FR-004, VG-NFR-007).
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
    return {
      status: "failed",
      unresolvedCaseIds,
      gatingCaseIds: [...gatingCaseIds],
      coveringUnitIds,
      emptyReason: null,
      lifecycleExcludedCaseIds,
    };
  }

  // (3) PENDING: any gating case is not_started / in_progress, absent, or
  // orphaned (and none failed/blocked).
  if (anyPending) {
    return {
      status: "pending",
      unresolvedCaseIds,
      gatingCaseIds: [...gatingCaseIds],
      coveringUnitIds,
      emptyReason: null,
      lifecycleExcludedCaseIds,
    };
  }

  // (4) PASSED: every gating case effective status is passed. Nothing unresolved.
  return {
    status: "passed",
    unresolvedCaseIds: [],
    gatingCaseIds: [...gatingCaseIds],
    coveringUnitIds: [],
    emptyReason: null,
    lifecycleExcludedCaseIds,
  };
}
