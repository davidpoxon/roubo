// Pure canonicalisation of a TestCasesPlan into a deterministic string
// (spike-407 AC1 rules 1-5). The server hashes this string with node:crypto to
// detect staleness (FR-016); this module does NOT hash.
//
// Platform-agnostic: no fs, no node:crypto, no React. Safe in the Vite client
// build. Canonical contract types land with testbench-contracts (#6); until
// then this consumes the local types in testbench-domain-types.ts.
//
// See .specifications/testbench/spikes/spike-407-staleness-hash-reconcile.md
// AC1 (the rules) and AC2 (the worked example this module is verified against).

import type { Case, Observation, Step, TestCasesPlan } from "./testbench-domain-types";

// Byte-wise (code-point) comparison, NOT a locale collator. A locale-aware
// collator is environment-dependent and would make the canonical string (and
// therefore the hash) non-deterministic across machines. Comparing the raw
// UTF-16 code units of two strings is a total, stable, environment-independent
// order, which is what spike-407 AC1 rule 2 requires.
function compareCodePoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

// String content-normalisation (spike-407 AC1 rule 3), applied to every
// included string value: NFC normalise, convert CRLF and lone CR to LF, trim
// leading/trailing whitespace, collapse each run of internal whitespace
// (spaces/tabs/newlines) to a single space.
function normalizeString(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim().replace(/\s+/g, " ");
}

// Per-observation projection in fixed canonical key order: id, expected.
function projectObservation(observation: Observation): { id: string; expected: string } {
  return {
    id: observation.id,
    expected: normalizeString(observation.expected),
  };
}

// Per-step projection in fixed canonical key order: id, instruction,
// observations (sorted by Observation.id).
function projectStep(step: Step): {
  id: string;
  instruction: string;
  observations: ReturnType<typeof projectObservation>[];
} {
  const observations = [...step.observations]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map(projectObservation);
  return {
    id: step.id,
    instruction: normalizeString(step.instruction),
    observations,
  };
}

// Per-case projection in fixed canonical key order: id, title, level, priority,
// preconditions (when present and non-empty), steps (sorted by Step.id).
//
// preconditions order is PRESERVED (not sorted). An absent and an empty
// preconditions list canonicalise identically: the key is omitted in both cases.
function projectCase(testCase: Case): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: testCase.id,
    title: normalizeString(testCase.title),
    level: normalizeString(testCase.level),
    priority: normalizeString(testCase.priority),
  };

  if (testCase.preconditions !== undefined && testCase.preconditions.length > 0) {
    projected.preconditions = testCase.preconditions.map(normalizeString);
  }

  projected.steps = [...testCase.steps]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map(projectStep);

  return projected;
}

// Produce the deterministic canonical string for a SINGLE case (spike-407 AC1,
// the per-case projection). This is the per-case unit that `canonicalize(plan)`
// composes over the whole case set, exported so `testbench-domain.reconcile`
// can compare one plan case's canonical body against the snapshot stored on a
// recorded result, sharing one canonicalisation authority (no second copy of
// the projection rules). Applies the same projection + normalisation + fixed
// key order as the plan-level canonicalize: drops every TargetingField and
// unknown field, sorts steps/observations by id, preserves preconditions order.
export function canonicalizeCase(testCase: Case): string {
  return JSON.stringify(projectCase(testCase));
}

// Produce the deterministic canonical string for a plan (spike-407 AC1).
//
// Rules, in order:
//   1. Project to included fields only (drop $schema, schemaVersion, specSlug,
//      every TargetingField, and any unknown field).
//   2. Stable-id sort cases/steps/observations by code-point comparison;
//      preconditions order preserved.
//   3. Normalise every included string value.
//   4. Serialise with fixed canonical key order and no insignificant whitespace.
//   5. Return the string (no hashing).
//
// The empty case set canonicalises to a fixed, stable, non-empty string:
//   {"cases":[]}
export function canonicalize(plan: TestCasesPlan): string {
  const cases = [...plan.cases].sort((a, b) => compareCodePoints(a.id, b.id)).map(projectCase);
  // JSON.stringify with no spacing emits keys in insertion order (the fixed
  // canonical order built above) and no insignificant whitespace.
  return JSON.stringify({ cases });
}
