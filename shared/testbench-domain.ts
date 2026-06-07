// Pure derived-status state machine (FR-009).
//
// Platform-agnostic: no fs, no node:crypto, no React. Safe in the Vite client
// build. Canonical contract types land with testbench-contracts (#6); until
// then this consumes the local types in testbench-domain-types.ts.

import type { CaseStatus, ObservationMark } from "./testbench-domain-types";

// Derive a case's status purely from its observation marks (FR-009).
//
// The "all observations marked" denominator is NOT inferable from the marks map
// alone (the map only holds marked observations), so the full observation-id set
// is passed alongside the marks.
//
// Truth table:
//   - no observations marked                          => "not_started"
//   - some but not all observations marked            => "in_progress"
//   - all observations marked AND all are pass        => "passed"
//   - all observations marked AND at least one fail   => "failed"
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

  if (markedCount === 0) {
    return "not_started";
  }
  if (markedCount < total) {
    return "in_progress";
  }
  // All observations are marked.
  return anyFail ? "failed" : "passed";
}
