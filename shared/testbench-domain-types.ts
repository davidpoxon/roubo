// Minimal, self-contained input types for the pure TestBench domain modules
// (testbench-domain, testbench-canonicalize).
//
// The canonical contract types are owned by testbench-contracts (issue #6),
// which is authored in parallel with this work (#412) and has NOT landed yet.
// To keep these pure modules self-contained, the shapes below are local copies
// that structurally match the architecture.md data model
// (.specifications/testbench/architecture.md, the Data model table). When #6
// lands, it owns the canonical zod-derived types and these local interfaces
// should be aligned with (or replaced by) the ones it exports.
//
// These modules are platform-agnostic: no fs, no node:crypto, no React. They
// must not break the Vite client build.

// The fixed status set (FR-009). "blocked" is NOT derivable from observation
// marks (marks are pass|fail only); it reaches a CaseResult only through an
// explicit override (FR-010), via effectiveStatus = override ?? derived.
export type CaseStatus = "not_started" | "in_progress" | "passed" | "failed" | "blocked";

// Author of a mark or note (FR-012). Included for structural fidelity with the
// architecture.md shape; the domain functions do not read it.
export interface Author {
  name: string;
  email: string;
  isSentinel?: true;
}

// A single observation result keyed by observation id in a CaseResult's
// observationMarks map. Marks are pass|fail only.
export interface ObservationMark {
  result: "pass" | "fail";
  author: Author;
  timestamp: string;
}

// Reserved, all-optional guided-execution targeting field (FR-019). Ignored by
// canonicalisation (see testbench-canonicalize): present on the input shape so
// these local types match the architecture.md Step/Observation shapes.
export interface TargetingField {
  cssSelector?: string;
  ariaRole?: string;
  ariaName?: string;
  textAnchor?: string;
  routeContext?: string;
  region?: string;
}

export interface Observation {
  id: string;
  expected: string;
  observe?: TargetingField;
}

export interface Step {
  id: string;
  instruction: string;
  observations: Observation[];
  target?: TargetingField;
}

export interface Case {
  id: string;
  title: string;
  level: string;
  priority: string;
  preconditions?: string[];
  steps: Step[];
}

export interface TestCasesPlan {
  $schema: string;
  schemaVersion: string;
  specSlug: string;
  cases: Case[];
}
