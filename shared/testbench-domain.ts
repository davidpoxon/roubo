// Pure derived-status state machine (FR-009).
//
// Platform-agnostic: no fs, no node:crypto, no React. Safe in the Vite client
// build. Canonical contract types land with testbench-contracts (#6); until
// then this consumes the local types in testbench-domain-types.ts.

import type {
  BenchResults,
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
// observations are still unmarked, per issue #508):
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
  // when other observations are still unmarked (issue #508).
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
  // snapshot refreshed and derivedStatus recomputed from their kept marks, every
  // other datum copied verbatim. The caller persists this; reconcile never
  // deletes.
  nextResults: BenchResults;
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

export function reconcile(plan: TestCasesPlan, results: BenchResults): ReconcileResult {
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
    // nothing). The stored snapshot vs published-contract gap is tracked in #447.
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

  // changed cases: keep every mark, note, and override; only refresh the
  // per-case snapshot and recompute derivedStatus from the kept marks.
  for (const caseId of classification.changed) {
    const next = nextCaseResults[caseId];
    next.caseCanon = planCanonById.get(caseId);
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
