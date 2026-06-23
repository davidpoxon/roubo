// Gate-overrides contract: the single, compile-time source of truth (in
// `shared/`) for the Roubo-owned override document that records an operator's
// batch merge / split regroupings (#703, FR-002, US-007). This mirrors the
// work-units contract (work-units-contract.ts): a zod source schema, the
// inferred type, the runtime validator, and the versioned `$id` constant.
//
// Why a separate, Roubo-owned document: gates are `kind: "verify"` work units
// loaded read-only from each spec's externally-authored work-units.json (the
// `breakdown` plugin writes that file; Roubo never does, see
// work-unit-loader.ts). Merge / split must NOT mutate work-units.json, so the
// operator's regroupings live here, in a per-project store Roubo controls, and
// are applied as a pure transform over the loaded verify units before
// evaluation (server/lib/gate-overrides.ts).
//
// The document is a flat, ordered list of operations. Each op names the SOURCE
// gate ids it consumes (which must currently exist among the loaded verify
// units) and the synthetic gate(s) it produces. Applying the list reconciles
// defensively: an op that references a now-missing source gate is dropped, never
// fatal (the external breakdown may re-file gates under different ids).

import { z } from "zod";

// ── Versioned schema identifier ──
//
// A breaking change ships a major bump; additive optional fields do not bump.
export const GATE_OVERRIDES_SCHEMA_ID = "https://roubo.dev/schema/gate-overrides/v1.0.0.json";
export const GATE_OVERRIDES_SCHEMA_VERSION = "1.0.0";

// ── Merge op ──
//
// Replaces N (>= 2) source gates with one synthetic gate whose gating set is the
// deduped union of the sources' test_case_ids and whose `covers` is the deduped
// union of the sources' `covers`. The synthetic gate's id is minted
// deterministically from the sorted source ids (see gate-overrides.ts).
export const MergeOpSchema = z
  .object({
    op: z.literal("merge"),
    // The source gate ids consumed by this merge. At least two; deduped.
    gateIds: z.array(z.string()).min(2),
  })
  .strict();
export type MergeOp = z.infer<typeof MergeOpSchema>;

// One part of a split: a label plus the source gate's `covers` WU- ids assigned
// to this part. The part's gating set is computed by mapping each WU- id to the
// test_case_ids the non-verify unit of that id implements (gate-overrides.ts).
export const SplitPartSchema = z
  .object({
    // A short stable label used to mint the part's synthetic gate id.
    label: z.string().min(1),
    // The WU- ids (a subset of the source gate's `covers`) assigned to this part.
    coversWorkUnitIds: z.array(z.string()).min(1),
  })
  .strict();
export type SplitPart = z.infer<typeof SplitPartSchema>;

// ── Split op ──
//
// Replaces one source gate with M (>= 2) synthetic gates. The parts partition
// the source gate's `covers` with no loss and no overlap (validated at apply
// time against the live gate, where the WU- -> test_case_ids map is available).
export const SplitOpSchema = z
  .object({
    op: z.literal("split"),
    // The single source gate id consumed by this split.
    gateId: z.string(),
    // The parts the source is split into. At least two.
    parts: z.array(SplitPartSchema).min(2),
  })
  .strict();
export type SplitOp = z.infer<typeof SplitOpSchema>;

export const GateOverrideOpSchema = z.discriminatedUnion("op", [MergeOpSchema, SplitOpSchema]);
export type GateOverrideOp = z.infer<typeof GateOverrideOpSchema>;

// ── gate-overrides.json (the versioned envelope) ──
//
// `$schema` is constrained to the literal id, and `schemaVersion` must match the
// constant so the two stay consistent (mirrors the work-units envelope).
export const GateOverridesFileSchema = z
  .object({
    $schema: z.literal(GATE_OVERRIDES_SCHEMA_ID),
    schemaVersion: z.literal(GATE_OVERRIDES_SCHEMA_VERSION),
    ops: z.array(GateOverrideOpSchema),
  })
  .strict()
  .meta({ $id: GATE_OVERRIDES_SCHEMA_ID });
export type GateOverridesFile = z.infer<typeof GateOverridesFileSchema>;

// An empty, valid document: no operator regroupings recorded yet.
export function emptyGateOverrides(): GateOverridesFile {
  return {
    $schema: GATE_OVERRIDES_SCHEMA_ID,
    schemaVersion: GATE_OVERRIDES_SCHEMA_VERSION,
    ops: [],
  };
}

// ── Runtime validator ──
//
// Wraps `safeParse` (never throws) and returns a discriminated result, mirroring
// validateWorkUnits. On failure each zod issue becomes a clear `path: message`
// string keyed by the field that failed.

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function zodIssuesToFieldErrors(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateGateOverrides(raw: unknown): ValidationResult<GateOverridesFile> {
  const parsed = GateOverridesFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
