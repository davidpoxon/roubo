// Work-units contract: the single, compile-time source of truth (in `shared/`)
// for the published, versioned `work-units.json` file that product-dev breakdown
// writes and Roubo validates. This mirrors the test-cases / test-results pair in
// testbench-contracts.ts: a zod source schema, the inferred type, the runtime
// validator, and the versioned `$id` constant. The shape follows the field
// reference tables in .specifications/verify-gate/work-unit-model.md VERBATIM and
// is not re-derived (see that document's "Field reference" section).
//
// Scope note (#697): this module authors the zod source schema, the inferred
// type, the runtime validator, and the versioned `$id` constant. The root carries
// `.meta({ $id })` so the generate script + CI drift guard emit a versioned JSON
// Schema from it (schema/work-units.schema.json). Gate evaluation and writing
// work-units.json are separate, out-of-scope work.

import { z } from "zod";

// ── Versioned schema identifier ──
//
// The published file carries a `$schema` URI whose path embeds a semver, and a
// matching `schemaVersion` string kept consistent with it. A breaking change
// ships a major bump; additive optional fields do not bump the version.

export const WORK_UNITS_SCHEMA_ID = "https://roubo.dev/schema/work-units/v1.0.0.json";
export const WORK_UNITS_SCHEMA_VERSION = "1.0.0";

// ── tracker (the tracker manifestation; absent before a unit is filed) ──
//
// Tracker-agnostic: `system` spans github | ghe | jira so a unit can be filed
// into any supported tracker. `blocked_by_refs` is a derived projection of
// `depends_on` into this tracker's ref space (R1); required, may be empty.
export const TrackerSchema = z
  .object({
    system: z.enum(["github", "ghe", "jira"]),
    // The tracker's external id: an issue number (GitHub) or issue key (Jira).
    ref: z.string(),
    url: z.string(),
    // GitHub GraphQL node id.
    node_id: z.string().optional(),
    // GitHub REST id.
    db_id: z.number().optional(),
    // Derived projection of `depends_on` into this tracker's `ref` space (R1).
    blocked_by_refs: z.array(z.string()),
  })
  .strict();
export type Tracker = z.infer<typeof TrackerSchema>;

// ── implements (test/requirement/story linkage, first-class on every unit, R4) ──
export const ImplementsSchema = z
  .object({
    requirement_ids: z.array(z.string()),
    user_story_ids: z.array(z.string()),
    // The TC- ids a unit is verified by. For a `kind: "verify"` unit this is the
    // gating test set and must be non-empty (R4); enforced by the root refine.
    test_case_ids: z.array(z.string()),
  })
  .strict();
export type Implements = z.infer<typeof ImplementsSchema>;

// ── Unit ──
//
// `.strict()` so the generated JSON Schema emits `additionalProperties: false`
// and an unknown extra field is rejected. Fields and requiredness follow the
// work-unit-model.md "Unit" table exactly.
export const UnitSchema = z
  .object({
    // Minted WU-NNN (bare) or <id_code>-WU-NNN (coded). Permanent identity.
    id: z.string(),
    title: z.string(),
    // Our tracker-agnostic work category; the integration plugin maps it to the
    // tracker's native type.
    type: z.enum(["feature", "task", "spike", "bug"]),
    // Optional durable semantic role. Absent means a plain delivery slice.
    kind: z.enum(["e2e", "doc", "verify"]).optional(),
    description: z.string(),
    acceptance_criteria: z.array(z.string()),
    milestone: z.string().optional(),
    labels: z.array(z.string()).optional(),
    estimate: z.number().optional(),
    // `WU-` ids. The dependency authority (R1). Required, may be empty.
    depends_on: z.array(z.string()),
    // Required on every unit (R4).
    implements: ImplementsSchema,
    // `WU-` ids this unit spans (used by e2e / verify units).
    covers: z.array(z.string()).optional(),
    // Doc-unit only: the documentation artifact it updates.
    target_path: z.string().optional(),
    // Doc-unit only: which doc-standard rule fired.
    trigger_reason: z.string().optional(),
    // The tracker manifestation. Absent before the unit is filed.
    tracker: TrackerSchema.optional(),
  })
  .strict();
export type Unit = z.infer<typeof UnitSchema>;

// ── work-units.json (the versioned envelope) ──
//
// `$schema` is constrained to the literal WORK_UNITS_SCHEMA_ID so a wrong
// `$schema` is rejected, and `schemaVersion` must match WORK_UNITS_SCHEMA_VERSION
// so the two stay consistent. The verify rule (R4) is enforced at the root: a
// `kind: "verify"` unit must carry a non-empty `implements.test_case_ids`.
export const WorkUnitsFileSchema = z
  .object({
    $schema: z.literal(WORK_UNITS_SCHEMA_ID),
    schemaVersion: z.literal(WORK_UNITS_SCHEMA_VERSION),
    // The `.specifications/<slug>/` folder name this file lives in.
    specSlug: z.string(),
    units: z.array(UnitSchema),
  })
  .strict()
  // Pass the literal `$id` key through `.meta()` so `z.toJSONSchema()` emits a
  // top-level `$id` carrying the versioned identifier. The generate script + CI
  // drift guard consume this.
  .meta({ $id: WORK_UNITS_SCHEMA_ID });
export type WorkUnitsFile = z.infer<typeof WorkUnitsFileSchema>;

// ── Runtime validator ──
//
// Wraps `safeParse` (never throws) and returns a discriminated result, mirroring
// validateTestCases / validateTestResults. On failure, each zod issue becomes a
// clear `path: message` string keyed by the field that failed. The `kind:
// "verify"` rule is enforced here as a refinement so it produces a field-named
// error against `implements.test_case_ids` rather than a vague envelope error.

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function zodIssuesToFieldErrors(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateWorkUnits(raw: unknown): ValidationResult<WorkUnitsFile> {
  const parsed = WorkUnitsFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  // R4: a `kind: "verify"` unit must have a non-empty implements.test_case_ids.
  // Enforced after the structural parse so the error is precise and field-named.
  // Modeled as a post-parse check (rather than a schema-level union) to keep the
  // generated JSON Schema's per-field errors clean; the rule is still validated
  // at runtime on every call.
  const errors: string[] = [];
  parsed.data.units.forEach((unit, index) => {
    if (unit.kind === "verify" && unit.implements.test_case_ids.length === 0) {
      errors.push(
        `units.${index}.implements.test_case_ids: a kind:"verify" unit must list at least one test case id`,
      );
    }
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data: parsed.data };
}
