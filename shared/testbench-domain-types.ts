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

// ── Result-side input shapes (consumed by testbench-domain.reconcile) ──
//
// These mirror the architecture.md data model and the canonical zod shapes in
// testbench-contracts.ts (NoteSchema, StatusOverrideSchema, CaseResultSchema,
// BenchResultsSchema). They are local copies for the same reason as the shapes
// above: testbench-contracts owns the canonical types, and these should be
// aligned with (or replaced by) its exports when this module consolidates.

// An explicit status override, recorded distinctly from derivedStatus (FR-010).
export interface StatusOverride {
  status: CaseStatus;
  author: Author;
  timestamp: string;
}

// An append-only note (FR-011). statusAtWrite captures the effective status at
// the moment the note was written.
export interface Note {
  id: string;
  text: string;
  author: Author;
  timestamp: string;
  statusAtWrite: CaseStatus;
}

// A recorded result for one case, keyed by case id in BenchResults.caseResults.
//
// The shape is now derived from the published contract's CaseResultSchema
// (testbench-contracts), re-exported here so it is declared once. This is a
// type-only re-export: it is erased at compile time, so no zod runtime import
// is pulled into these pure, Vite-safe domain modules. caseCanon (the per-case
// canonical body snapshot reconcile compares against the live plan to classify
// changed vs unchanged) is one of the contract fields; a result with no stored
// snapshot is conservatively classified changed.
import type { CaseResult } from "./testbench-contracts";
export type { CaseResult };

// One bench's recorded results, keyed by case id.
export interface BenchResults {
  caseResults: Record<string, CaseResult>;
  updatedAt: string;
}
