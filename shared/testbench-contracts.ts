// TestBench contracts: the single, compile-time source of truth (in `shared/`)
// for the two published, versioned TestBench files, `test-cases.json` and
// `test-results.json`. Both server and client validate against these schemas
// (FR-019, FR-020, FR-021). Shapes follow the architecture.md Data model table
// exactly; the runtime validators wrap `safeParse` (never throw) and return
// actionable, field-named errors.
//
// Scope note: this module authors the zod source schemas, the inferred types,
// the runtime validators, and the versioned `$id` constants. The roots carry
// `.meta({ $id })` so the generate script + CI drift guard (FR-023, #411) can
// emit versioned JSON Schema from them; the store IO (#11) is out of scope here.

import { z } from "zod";

// ── Versioned schema identifiers (NFR-005) ──
//
// Each published file carries a `$schema` URI whose path embeds a semver. A
// breaking change ships a major bump plus a documented migration path; additive
// optional fields (like the reserved targeting fields below) do not bump the
// version. `TEST_CASES_SCHEMA_VERSION` / `TEST_RESULTS_SCHEMA_VERSION` are the
// matching `schemaVersion` string values kept consistent with the `$id` semver.
//
// The migration history and the versioning rule live in
// docs/testbench-schema-migrations.md. Two entries there matter for NFR-005:
//   - test-cases 1.0.0 -> 1.1.0 was a MINOR bump that was in fact breaking
//     (level string -> integer; area/type/tags/linked_* became required). That
//     break is recorded as an ACCEPTED retroactive break, not re-tagged to 2.0.0
//     (re-tagging would rewrite a published `$id` for no practical gain). Going
//     forward, minor bumps stay additive/optional; a real break takes a major
//     bump plus a migration entry.
//   - test-results 1.0.0 -> 2.0.0 flattened the per-bench `benches` map to
//     top-level caseResults. The store loader detects a prior-major file and
//     fails open with a version-migration-required signal pointing at that doc.

export const TEST_CASES_SCHEMA_ID = "https://roubo.dev/schema/testbench/test-cases/v1.1.0.json";
export const TEST_CASES_SCHEMA_VERSION = "1.1.0";

export const TEST_RESULTS_SCHEMA_ID = "https://roubo.dev/schema/testbench/test-results/v2.0.0.json";
export const TEST_RESULTS_SCHEMA_VERSION = "2.0.0";

// The repo-relative path to the migration history doc referenced above (NFR-005).
// A prior-major test-results.json fails open with a version-migration-required
// signal; this constant is the single source of truth for the pointer, so every
// observable surface that names the migration path (the plan API payload, the
// ResultsRecoveryBanner copy) references the same string and it cannot drift from
// the doc that actually lives here.
export const TESTBENCH_MIGRATION_GUIDE_PATH = "docs/testbench-schema-migrations.md";

// ── Shared leaf schemas ──

// The fixed derived-status set (FR-009). Owned by `testbench-domain` as a
// concept, but the literal enum lives here so both files can reference it.
export const CaseStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "passed",
  "failed",
  "blocked",
]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

// Author of a mark, override, or note (FR-012). `isSentinel` is set when git
// identity was unset at write time, so writes never fail on missing identity.
export const AuthorSchema = z
  .object({
    name: z.string(),
    email: z.string(),
    isSentinel: z.literal(true).optional(),
  })
  .strict();
export type Author = z.infer<typeof AuthorSchema>;

// Reserved, optional, additive targeting field (FR-019, NFR-005). Flat and
// all-optional: ignored by the in-app UI today, reserved for the future
// guided-execution Chrome extension. Present or absent, both validate; adding
// it to a step/observation is non-breaking.
export const TargetingFieldSchema = z
  .object({
    cssSelector: z.string().optional(),
    ariaRole: z.string().optional(),
    ariaName: z.string().optional(),
    textAnchor: z.string().optional(),
    routeContext: z.string().optional(),
    region: z.string().optional(),
  })
  .strict();
export type TargetingField = z.infer<typeof TargetingFieldSchema>;

// ── test-cases.json (the source plan; never mutated) ──

export const ObservationSchema = z
  .object({
    id: z.string(),
    expected: z.string(),
    // Reserved per-observation targeting field (FR-019).
    observe: TargetingFieldSchema.optional(),
  })
  .strict();
export type Observation = z.infer<typeof ObservationSchema>;

export const StepSchema = z
  .object({
    id: z.string(),
    instruction: z.string(),
    observations: z.array(ObservationSchema),
    // Reserved per-step targeting field (FR-019).
    target: TargetingFieldSchema.optional(),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;

// Recommended `type` vocabulary: the canonical product-dev set
// (functional, security, performance, accessibility, integration, negative,
// edge_case, e2e_flow) expanded with `reliability` and `structural`, both
// already in use across real specs. This is authoring guidance carried in the
// product-dev docs; the contract itself validates `type` as a permissive string
// (see CaseSchema), never a strict enum. The merged schema (v1.1.0) is strict on
// STRUCTURE (envelope, step ids, required fields) but lenient on open-ended
// metadata, so a newly-coined `type` can never silently make an entire spec
// undiscoverable (the failure mode v1.1.0 fixed).
export const RECOMMENDED_CASE_TYPES = [
  "functional",
  "security",
  "performance",
  "accessibility",
  "integration",
  "negative",
  "edge_case",
  "e2e_flow",
  "reliability",
  "structural",
] as const;

export const CaseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    // Canonical feature area (kebab-case), e.g. "checkout". Required.
    area: z.string(),
    // Canonical level: an integer 1-4 (L1 smoke .. L4 exploratory). The merge
    // keeps level from the canonical product-dev format (an integer), replacing
    // the earlier string level.
    level: z.number().int().min(1).max(4),
    // Test flavor (see RECOMMENDED_CASE_TYPES). Permissive string by design.
    type: z.string().min(1),
    // Optional priority label (carried from the TestBench shape). Canonical
    // authors omit it; the UI rollup buckets cases with no priority gracefully.
    priority: z.string().optional(),
    preconditions: z.array(z.string()).optional(),
    steps: z.array(StepSchema),
    // Canonical metadata: free-form tags + requirement/story traceability.
    // Every case links at least one requirement; user-story links may be empty.
    tags: z.array(z.string()),
    linked_requirement_ids: z.array(z.string()).min(1),
    linked_user_story_ids: z.array(z.string()),
  })
  .strict();
export type Case = z.infer<typeof CaseSchema>;

export const TestCasesPlanSchema = z
  .object({
    $schema: z.string(),
    schemaVersion: z.string(),
    specSlug: z.string(),
    cases: z.array(CaseSchema),
  })
  .strict()
  // Pass the literal `$id` key through `.meta()` so `z.toJSONSchema()` emits a
  // top-level `$id` carrying the versioned identifier (NFR-005). The generate
  // script + CI drift guard (FR-023) consume this.
  .meta({ $id: TEST_CASES_SCHEMA_ID });
export type TestCasesPlan = z.infer<typeof TestCasesPlanSchema>;

// ── test-results.json (the sidecar; references cases by stable id) ──

export const ObservationMarkSchema = z
  .object({
    result: z.enum(["pass", "fail"]),
    author: AuthorSchema,
    timestamp: z.string(),
  })
  .strict();
export type ObservationMark = z.infer<typeof ObservationMarkSchema>;

// Recorded distinctly from `derivedStatus` (FR-010).
export const StatusOverrideSchema = z
  .object({
    status: CaseStatusSchema,
    author: AuthorSchema,
    timestamp: z.string(),
  })
  .strict();
export type StatusOverride = z.infer<typeof StatusOverrideSchema>;

// Append-only: no edit/delete path exists (FR-011). `statusAtWrite` captures
// the effective status at the moment the note was written.
export const NoteSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    author: AuthorSchema,
    timestamp: z.string(),
    statusAtWrite: CaseStatusSchema,
  })
  .strict();
export type Note = z.infer<typeof NoteSchema>;

// Machine verification provenance, written by an external verification engine
// (product-dev:verify's results-merge engine), never by Roubo itself: the
// decisive method tier that produced `derivedStatus` (a: drive the running
// system / b: suite corroboration / c: throwaway probe / d: static inspection),
// the graded confidence behind it, and evidence pointers (commands run, report
// anchors) backing the verdict. Additive and optional per the versioning policy
// above (no schemaVersion bump); absent for purely human-marked cases.
export const VerificationTierSchema = z.enum(["a", "b", "c", "d"]);
export type VerificationTier = z.infer<typeof VerificationTierSchema>;

export const VerificationConfidenceSchema = z.enum(["high", "medium", "low"]);
export type VerificationConfidence = z.infer<typeof VerificationConfidenceSchema>;

export const VerificationSchema = z
  .object({
    tier: VerificationTierSchema,
    confidence: VerificationConfidenceSchema,
    evidence: z.array(z.string()),
    author: AuthorSchema,
    timestamp: z.string(),
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;

export const CaseResultSchema = z
  .object({
    // Keyed by observation id; results reference cases by stable id and never
    // require editing test-cases.json (FR-020).
    observationMarks: z.record(z.string(), ObservationMarkSchema),
    derivedStatus: CaseStatusSchema,
    statusOverride: StatusOverrideSchema.optional(),
    notes: z.array(NoteSchema),
    // Machine verification provenance from an external engine (see
    // VerificationSchema); Roubo reads and re-serializes it verbatim.
    verification: VerificationSchema.optional(),
    // A removed case's result is marked orphaned and retained, never deleted,
    // and excluded from the rollup (FR-013, FR-017).
    orphaned: z.literal(true).optional(),
    // The per-case canonical body snapshot reconcile compares against the live
    // plan to classify changed vs unchanged (#413, spike-407 AC3). Optional so a
    // result with no stored snapshot still parses and is conservatively
    // classified changed; persisting it lets the signal survive a round-trip to
    // disk (#447).
    caseCanon: z.string().optional(),
  })
  .strict();
export type CaseResult = z.infer<typeof CaseResultSchema>;

// The recorded-results body for a single spec: case results keyed by case id,
// plus a write timestamp. As of the v2.0.0 flatten (#493), one results file
// lives per worktree (sibling of test-cases.json), so there is exactly one of
// these per file and it sits at the top level. This stays a named type because
// it is also the API result shape the client reads (the route projects the file
// body down to it), so keeping the name avoids client churn.
export const BenchResultsSchema = z
  .object({
    // Keyed by case id.
    caseResults: z.record(z.string(), CaseResultSchema),
    updatedAt: z.string(),
  })
  .strict();
export type BenchResults = z.infer<typeof BenchResultsSchema>;

export const TestResultsFileSchema = z
  .object({
    $schema: z.string(),
    schemaVersion: z.string(),
    planHash: z.string(),
    // Flattened in v2.0.0 (#493): one results file per worktree means exactly
    // one bench per file, so case results sit at the top level rather than
    // nested under a per-bench `benches` map. Keyed by case id.
    caseResults: z.record(z.string(), CaseResultSchema),
    updatedAt: z.string(),
  })
  .strict()
  // Pass the literal `$id` key through `.meta()` so `z.toJSONSchema()` emits a
  // top-level `$id` carrying the versioned identifier (NFR-005). The generate
  // script + CI drift guard (FR-023) consume this.
  .meta({ $id: TEST_RESULTS_SCHEMA_ID });
export type TestResultsFile = z.infer<typeof TestResultsFileSchema>;

// ── Runtime validators ──
//
// Both wrap `safeParse` (never throw, FR-021) and return a discriminated result.
// On failure, each zod issue becomes a clear `path: message` string keyed by
// the field that failed.

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function zodIssuesToFieldErrors(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateTestCases(raw: unknown): ValidationResult<TestCasesPlan> {
  const parsed = TestCasesPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}

export function validateTestResults(raw: unknown): ValidationResult<TestResultsFile> {
  const parsed = TestResultsFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
