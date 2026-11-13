// Pure derived-status state machine (FR-009).
//
// Platform-agnostic: no fs, no node:crypto, no React. Safe in the Vite client
// build. Canonical contract types land with testbench-contracts (#445); until
// then this consumes the local types in testbench-domain-types.ts.

import type {
  BenchResults,
  Case,
  CaseResult,
  CaseStatus,
  ObservationMark,
  TestCasesPlan,
} from "./testbench-domain-types";
import { canonicalizeCase } from "./testbench-canonicalize";

// Derive a case's status purely from its observation marks (FR-009).
//
// The "all observations marked" denominator is NOT inferable from the marks map
// alone (the map only holds marked observations), so the full observation-id set
// is passed alongside the marks.
//
// Truth table (a single fail short-circuits to "failed", even when other
// observations are still unmarked, per #510):
//   - any observation marked fail                     => "failed"
//   - no observations marked (and no fail)            => "not_started"
//   - some but not all observations marked (no fail)  => "in_progress"
//   - all observations marked AND all are pass        => "passed"
//
// "blocked" is NEVER derived here: marks are pass|fail only, so blocked is
// reachable only through an explicit override (FR-010), via
// effectiveStatus = override ?? deriveStatus(...). CaseStatus still includes
// "blocked" for that override path.
//
// Edge: a case with zero observations defined is treated as "not_started".
// There is nothing for the reviewer to mark, so the case has not been started;
// it can never auto-advance to passed/failed without an observation to mark.
export function deriveStatus(
  observationIds: string[],
  marks: Record<string, ObservationMark>,
): CaseStatus {
  const total = observationIds.length;

  // Zero observations defined: nothing to mark, so not started.
  if (total === 0) {
    return "not_started";
  }

  let markedCount = 0;
  let anyFail = false;
  for (const id of observationIds) {
    const mark = marks[id];
    if (mark === undefined) {
      continue;
    }
    markedCount += 1;
    if (mark.result === "fail") {
      anyFail = true;
    }
  }

  // A single failed observation moves the case to "failed" immediately, even
  // when other observations are still unmarked (#510).
  if (anyFail) {
    return "failed";
  }
  if (markedCount === 0) {
    return "not_started";
  }
  if (markedCount < total) {
    return "in_progress";
  }
  // All observations are marked and none failed.
  return "passed";
}

// Deterministic reconcile (FR-017, spike-407 AC3/AC4/AC5).
//
// Diffs a source plan against recorded results by stable case id and classifies
// each case as added / unchanged / changed / removed. It is non-destructive:
// removed cases that carry authored results are flagged orphaned (never deleted
// here), so no ObservationMark, Note, or StatusOverride is ever lost. Physical
// deletion is a SEPARATE explicit operation (purgeOrphans below), per the issue
// AC and spike-407 AC5.

// The four id buckets a reconcile produces (spike-407 AC3).
export interface ReconcileClassification {
  // In the plan, no recorded result yet: new, nothing authored to preserve.
  added: string[];
  // In both, canonical case body matches the stored snapshot.
  unchanged: string[];
  // In both, canonical case body differs (or no stored snapshot): marks/notes/
  // override retained, reviewer signalled to re-review.
  changed: string[];
  // Recorded result with no matching plan case: orphan candidate, never deleted.
  removed: string[];
}

export interface ReconcileResult {
  classification: ReconcileClassification;
  // A non-destructive reconciled BenchResults: orphans flagged, changed cases'
  // derivedStatus recomputed from their kept marks, every other datum copied
  // verbatim. A changed case gets a snapshot only when it has none and the
  // results are fresh (see ReconcileOptions); otherwise it keeps the snapshot of
  // the body its marks were judged against, so it stays stale (#1407, #1696).
  // The caller persists this; reconcile never deletes.
  nextResults: BenchResults;
}

export interface ReconcileOptions {
  // True when the results file's planHash is the current plan hash (see
  // currentResultCaseIds). Only then does a changed case with no snapshot get
  // one: that upgrades a legacy result, which a fresh file reads as current. A
  // changed case that has a snapshot was judged against another body, so it
  // keeps that snapshot and stays stale until it is judged again, under fresh
  // results (#1696) as under stale ones (#1407).
  fresh: boolean;
}

// Gather every observation id defined across a plan case's steps, so a changed
// case's derivedStatus can be recomputed from its (kept) marks against the new
// plan's observation set.
function planCaseObservationIds(plan: TestCasesPlan, caseId: string): string[] {
  const planCase = plan.cases.find((c) => c.id === caseId);
  if (planCase === undefined) {
    return [];
  }
  const ids: string[] = [];
  for (const step of planCase.steps) {
    for (const observation of step.observations) {
      ids.push(observation.id);
    }
  }
  return ids;
}

export function reconcile(
  plan: TestCasesPlan,
  results: BenchResults,
  options: ReconcileOptions,
): ReconcileResult {
  const planCanonById = new Map<string, string>();
  for (const planCase of plan.cases) {
    planCanonById.set(planCase.id, canonicalizeCase(planCase));
  }
  const planIds = new Set(planCanonById.keys());
  const resultIds = new Set(Object.keys(results.caseResults));

  const classification: ReconcileClassification = {
    added: [],
    unchanged: [],
    changed: [],
    removed: [],
  };

  for (const caseId of planIds) {
    if (!resultIds.has(caseId)) {
      // Authored nothing yet: safe, nothing to preserve.
      classification.added.push(caseId);
      continue;
    }
    // A result exists; did the case body change? A result with no stored
    // snapshot is conservatively classified changed (prompts re-review, loses
    // nothing). The stored snapshot vs published-contract gap is tracked in #489.
    const stored = results.caseResults[caseId].caseCanon;
    if (stored !== undefined && stored === planCanonById.get(caseId)) {
      classification.unchanged.push(caseId);
    } else {
      classification.changed.push(caseId);
    }
  }

  for (const caseId of resultIds) {
    if (!planIds.has(caseId)) {
      // Orphan candidate: results are NOT touched in this loop.
      classification.removed.push(caseId);
    }
  }

  // Build the non-destructive reconciled results. Every recorded result is
  // copied; only additive/metadata mutations are applied.
  const nextCaseResults: Record<string, CaseResult> = {};
  for (const [caseId, result] of Object.entries(results.caseResults)) {
    nextCaseResults[caseId] = copyCaseResult(result);
  }

  // changed cases: keep every mark, note, and override; recompute derivedStatus
  // from the kept marks. Only a legacy result with no snapshot, under fresh
  // results, gets the current body. A recorded snapshot names an older body the
  // marks were judged against, and refreshing it would make them read as
  // current (#1407; under a fresh file too, #1696, as for a restored case).
  for (const caseId of classification.changed) {
    const next = nextCaseResults[caseId];
    if (options.fresh && next.caseCanon === undefined) {
      next.caseCanon = planCanonById.get(caseId);
    }
    next.derivedStatus = deriveStatus(planCaseObservationIds(plan, caseId), next.observationMarks);
  }

  // removed cases: flag orphaned, retain on disk, exclude from the rollup.
  for (const caseId of classification.removed) {
    nextCaseResults[caseId].orphaned = true;
  }

  return {
    classification,
    nextResults: {
      caseResults: nextCaseResults,
      updatedAt: results.updatedAt,
    },
  };
}

// ── Per-case result currency (#1407, #1696) ──
//
// The file-level planHash claims that EVERY recorded result belongs to the
// current plan. Under stale results (a stored planHash that is not the plan's), a
// result can still be current on its own: its caseCanon snapshot equals
// canonicalizeCase of its case in the current plan, so the case body it was
// judged against has not changed. Under a fresh file a result is current unless
// its recorded caseCanon names another body: a case can come back to the plan
// with an old result while the file is fresh, because the plan hash excludes the
// lifecycle block, so retiring a case and restoring it leaves the hash as it was
// (#1696). A legacy result with no caseCanon stays current under a fresh file.
// These two predicates are the one definition of that rule, shared by the
// store's write side (which stamps planHash only when no live recorded case is
// stale) and by the read side (the store's currentCaseIds and stale flag, which
// the gate evaluator judges each gating case by; noncurrentLiveCaseIds). They follow the same rule as
// the other writer of test-results.json, so neither writer can make a result the
// other judged stale read as current.

// Whether a recorded result is current for its plan case: its caseCanon is the
// case's canonical body, or, under a fresh file, it records no caseCanon.
function resultIsCurrent(planCase: Case, result: CaseResult, fresh: boolean): boolean {
  if (result.caseCanon === undefined) return fresh;
  return result.caseCanon === canonicalizeCase(planCase);
}

// The recorded case ids whose result is current for the plan, in plan order then
// recorded order. `fresh` is true when the file planHash is the current plan
// hash. A result whose case is in the plan is current by resultIsCurrent. A
// result whose case left the plan is current only under a fresh file (an orphan
// has no current body to compare against, and a fresh file claims it). Under
// stale results a result with no caseCanon, one whose case left the plan, or one
// judged against an older body is not current.
export function currentResultCaseIds(
  plan: TestCasesPlan,
  caseResults: Record<string, CaseResult>,
  fresh: boolean,
): string[] {
  const planOrder = plan.cases
    .filter(
      (planCase) =>
        Object.hasOwn(caseResults, planCase.id) &&
        resultIsCurrent(planCase, caseResults[planCase.id], fresh),
    )
    .map((planCase) => planCase.id);
  if (!fresh) return planOrder;
  const inPlan = new Set(plan.cases.map((c) => c.id));
  return [...planOrder, ...Object.keys(caseResults).filter((id) => !inPlan.has(id))];
}

// The live recorded case ids that hold a stale planHash, in plan order. Empty
// when `fresh`. A live recorded case is a plan case with no lifecycle block
// (retired and superseded both end its own obligation, as the gate evaluator and
// the other writer of test-results.json read it) that has a recorded result. It
// holds the stamp when its result is not current, or when its statusOverride
// stands over a verdict judged against another body (a verdictCanon that is not
// the case's current body): the override is current, but the file stamp would
// claim the verdict under it is current too, and clearing the override would
// then show that verdict as current. A result whose case left the plan is an
// orphan and never holds the stamp.
export function staleResultCaseIds(
  plan: TestCasesPlan,
  caseResults: Record<string, CaseResult>,
  fresh: boolean,
): string[] {
  if (fresh) {
    return [];
  }
  const current = new Set(currentResultCaseIds(plan, caseResults, false));
  return plan.cases
    .filter((planCase) => {
      if (planCase.lifecycle !== undefined || !Object.hasOwn(caseResults, planCase.id)) {
        return false;
      }
      if (!current.has(planCase.id)) return true;
      const verdictCanon = caseResults[planCase.id].statusOverride?.verdictCanon;
      return verdictCanon !== undefined && verdictCanon !== canonicalizeCase(planCase);
    })
    .map((planCase) => planCase.id);
}

// The live recorded case ids whose result is not current, in plan order (#1696).
// A live recorded case is as in staleResultCaseIds. Under a fresh file these are
// the cases whose recorded caseCanon names another body, such as a case restored
// with an old result; the store reads the results as stale while any is named.
export function noncurrentLiveCaseIds(
  plan: TestCasesPlan,
  caseResults: Record<string, CaseResult>,
  fresh: boolean,
): string[] {
  return plan.cases
    .filter(
      (planCase) =>
        planCase.lifecycle === undefined &&
        Object.hasOwn(caseResults, planCase.id) &&
        !resultIsCurrent(planCase, caseResults[planCase.id], fresh),
    )
    .map((planCase) => planCase.id);
}

// Deep-copy a CaseResult so reconcile/purge never mutate the caller's input
// (these are pure functions). Marks, notes, and the override are copied by value.
function copyCaseResult(result: CaseResult): CaseResult {
  const observationMarks: Record<string, ObservationMark> = {};
  for (const [id, mark] of Object.entries(result.observationMarks)) {
    observationMarks[id] = { ...mark, author: { ...mark.author } };
  }
  const copy: CaseResult = {
    observationMarks,
    derivedStatus: result.derivedStatus,
    notes: result.notes.map((note) => ({ ...note, author: { ...note.author } })),
  };
  if (result.statusOverride !== undefined) {
    copy.statusOverride = {
      ...result.statusOverride,
      author: { ...result.statusOverride.author },
    };
  }
  if (result.orphaned !== undefined) {
    copy.orphaned = result.orphaned;
  }
  if (result.caseCanon !== undefined) {
    copy.caseCanon = result.caseCanon;
  }
  return copy;
}

// Purge orphaned results (FR-017, spike-407 AC5). This is the ONLY delete path,
// kept SEPARATE from reconcile so physical deletion always requires an explicit,
// distinct operation. Pure: returns a new BenchResults dropping every entry
// flagged orphaned, leaving the input untouched.
export function purgeOrphans(results: BenchResults): BenchResults {
  const caseResults: Record<string, CaseResult> = {};
  for (const [caseId, result] of Object.entries(results.caseResults)) {
    if (result.orphaned === true) {
      continue;
    }
    caseResults[caseId] = copyCaseResult(result);
  }
  return { caseResults, updatedAt: results.updatedAt };
}
