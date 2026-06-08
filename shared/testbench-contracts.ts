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
// breaking change ships a major bump plus a migration registry entry; additive
// optional fields (like the reserved targeting fields below) do not bump the
// version. `TEST_CASES_SCHEMA_VERSION` / `TEST_RESULTS_SCHEMA_VERSION` are the
// matching `schemaVersion` string values kept consistent with the `$id` semver.

export const TEST_CASES_SCHEMA_ID = "https://roubo.dev/schema/testbench/test-cases/v1.0.0.json";
export const TEST_CASES_SCHEMA_VERSION = "1.0.0";

export const TEST_RESULTS_SCHEMA_ID = "https://roubo.dev/schema/testbench/test-results/v1.0.0.json";
export const TEST_RESULTS_SCHEMA_VERSION = "1.0.0";

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

export const CaseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    level: z.string(),
    priority: z.string(),
    preconditions: z.array(z.string()).optional(),
    steps: z.array(StepSchema),
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

export const CaseResultSchema = z
  .object({
    // Keyed by observation id; results reference cases by stable id and never
    // require editing test-cases.json (FR-020).
    observationMarks: z.record(z.string(), ObservationMarkSchema),
    derivedStatus: CaseStatusSchema,
    statusOverride: StatusOverrideSchema.optional(),
    notes: z.array(NoteSchema),
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
    // Keyed by bench id: the chosen multi-bench layout, one sidecar per spec.
    benches: z.record(z.string(), BenchResultsSchema),
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
