// Spec lifecycle record: the compile-time source of truth for the ONE subtree of
// a spec's `.specifications/<slug>/manifest.json` that Roubo understands (#765,
// SATCA-FR-013). Mirrors the shape of gate-overrides-contract.ts: a zod source
// schema, the inferred type, a runtime validator returning field-named errors,
// and a versioned `$id` constant.
//
// Deliberately narrow. The manifest is authored and owned by the `product-dev`
// toolchain, which mints stage trackers, id counters, and a spike list Roubo has
// no business validating. Two independently released toolchains write to that
// one file, so this schema validates the `lifecycle` subtree ALONE and says
// nothing about its siblings. Callers pluck `lifecycle` off the parsed manifest
// and hand only that value here; nothing in this module ever rejects a manifest
// for carrying keys it does not recognise.
//
// Absence is the live state (SATCA-FR-017). There is no `archived: false`
// record: a spec is live when the subtree is absent, when the manifest is
// absent, and when the spec folder carries only the legacy `flow-state.json`.
// That makes `archived` a literal `true` rather than a boolean, so a half-written
// `{ archived: false }` reads as a malformed record (surfaced, one spec degraded)
// instead of as a silently meaningful one.

import { z } from "zod";

// ── Versioned schema identifier ──
//
// A breaking change ships a major bump; additive optional fields do not bump.
export const SPEC_LIFECYCLE_SCHEMA_ID = "https://roubo.dev/schema/spec-lifecycle/v1.0.0.json";
export const SPEC_LIFECYCLE_SCHEMA_VERSION = "1.0.0";

// The shape of a spec slug, as a pointer VALUE inside the record. Kept here (in
// `shared/`, next to the schema that uses it) rather than imported from the
// server's safe-path module, because this contract is consumed by the client
// too; it is the same allowlist as SPEC_SLUG_RE (lowercase kebab/underscore,
// fronted by a negative lookahead rejecting "." and ".." so a pointer can never
// be a traversal segment, and a character class that excludes "/" and "\0" so it
// can never embed a separator).
export const SPEC_LIFECYCLE_SLUG_PATTERN = "^(?!\\.{1,2}$)[a-z0-9_-]+$";
const SPEC_LIFECYCLE_SLUG_RE = new RegExp(SPEC_LIFECYCLE_SLUG_PATTERN);

// ── The lifecycle subtree ──
//
// `.strict()` so an unrecognised key INSIDE the lifecycle record is a validation
// error. That is the opposite of the whole-manifest rule above, and deliberately
// so: Roubo owns this subtree outright, and a typo'd key here would otherwise
// silently archive nothing.
//
// `supersededBy` is validated for SHAPE only. Whether the named spec exists, is
// itself archived, or closes a supersession cycle is the LifecycleResolver's
// question (#763), not this schema's and not the reader's.
export const SpecLifecycleRecordSchema = z
  .object({
    // Literal true: absence, not `false`, is how a live spec is recorded.
    archived: z.literal(true),
    // Optional human-readable justification, e.g. "Shipped in #212".
    reason: z.string().min(1).optional(),
    // Optional pointer to the spec slug that replaced this one.
    supersededBy: z
      .string()
      .regex(SPEC_LIFECYCLE_SLUG_RE, "must be a spec slug (lowercase letters, digits, - and _)")
      .optional(),
  })
  .strict()
  .meta({
    $id: SPEC_LIFECYCLE_SCHEMA_ID,
    title: "Spec lifecycle record",
    description:
      "The `lifecycle` subtree of a spec's .specifications/<slug>/manifest.json (SATCA-FR-013). Absent subtree means the spec is live.",
  });
export type SpecLifecycleRecord = z.infer<typeof SpecLifecycleRecordSchema>;

// ── Runtime validator ──
//
// Wraps `safeParse` (never throws) and returns a discriminated result, mirroring
// validateGateOverrides. On failure each zod issue becomes a clear
// `path: message` string keyed by the field that failed, which is what lets one
// malformed record be reported against the spec that owns it (SATCA-FR-004).

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function zodIssuesToFieldErrors(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateSpecLifecycle(raw: unknown): ValidationResult<SpecLifecycleRecord> {
  const parsed = SpecLifecycleRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
