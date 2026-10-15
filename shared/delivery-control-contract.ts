// Delivery control contract: the compile-time source of truth (in `shared/`)
// for the published, versioned shape of one operator CONTROL (SB-FR-014,
// SB-US-005). A control is one line of the control outbox: the bench writes it
// when the operator answers a decision, overturns one, adds a steering note,
// changes a role's tier, pauses, winds down, resumes or approves, and the
// delivery tooling reads and applies it. The outbox is the inverse of the event
// stream in delivery-observation-contract.ts: events flow from the tooling to
// the bench, controls from the bench to the tooling.
//
// Mirrors delivery-observation-contract.ts: a zod source schema, the inferred
// type, a runtime validator returning field-named errors, and a versioned `$id`
// constant. The generate script renders it into schema/ and the CI drift guard
// keeps the committed JSON equal to the zod source.
//
// Agent-agnostic by construction (SB-NFR-001): a control names a role, a tier,
// a decision or a unit by id, never a vendor, a model or a tool.
//
// Compatibility posture (SB-NFR-007), as the observation contract: every object
// is `.loose()`, so a later minor version adds a field without a major bump, and
// `status` is an open string. `kind` is a CLOSED enum: a reader that applies a
// control cannot act on a kind it does not know, so a new kind is an additive
// enum change that bumps the minor, which scripts/contract-compatibility.ts
// classifies. The suite enforces the bump rule against the committed baseline
// under shared/__fixtures__/contract-baselines/.

import { z } from "zod";

// ── Versioned schema identifier ──

export const DELIVERY_CONTROL_SCHEMA_ID = "https://roubo.dev/schema/delivery-control/v1.0.0.json";
export const DELIVERY_CONTROL_SCHEMA_VERSION = "1.0.0";

// ── Shared scalars ──

// An RFC 3339 timestamp with any offset, e.g. 2026-10-16T09:30:00Z.
const TimestampSchema = z.iso.datetime({ offset: true });
// A non-empty identifier: a delivery id, a decision id, a unit id, a role name.
const IdSchema = z.string().min(1);
// An open status word (pending, delivered, applied, rejected, and so on). See
// the compatibility posture above.
const StatusSchema = z.string().min(1);

// ── kind ──
//
// The eight control kinds of 1.0.0, spelled in kebab-case as the recipe step
// kinds are. `target_id` names what a kind acts on: the decision of a
// decision-answer or an overturn, the unit of a steering note that applies to
// one unit, the role of a role-change. A delivery-wide control (pause, wind-down,
// resume, approval, a steering note for every unit) carries no target.
export const DELIVERY_CONTROL_KINDS = [
  "decision-answer",
  "overturn",
  "steering-note",
  "role-change",
  "pause",
  "wind-down",
  "resume",
  "approval",
] as const;
export const DeliveryControlKindSchema = z.enum(DELIVERY_CONTROL_KINDS);
export type DeliveryControlKind = z.infer<typeof DeliveryControlKindSchema>;

// ── The delivery control ──
//
// `$schema` is the literal DELIVERY_CONTROL_SCHEMA_ID and `schemaVersion` the
// matching literal, as every published contract in shared/ does. The body is an
// OPEN object, as the event payload is: what a kind carries (the chosen option,
// the note text, the new tier) is the producer's, and a reader that wants a
// typed body layers a discriminated union over `kind` on its own side.
export const DeliveryControlSchema = z
  .object({
    $schema: z.literal(DELIVERY_CONTROL_SCHEMA_ID),
    schemaVersion: z.literal(DELIVERY_CONTROL_SCHEMA_VERSION),
    delivery_id: IdSchema,
    // Dense, 1-based, strictly increasing per delivery: the outbox's own
    // sequence, separate from the event stream's `seq`.
    control_seq: z.number().int().min(1),
    kind: DeliveryControlKindSchema,
    target_id: IdSchema.optional(),
    body: z.record(z.string(), z.unknown()),
    issued_at: TimestampSchema,
    status: StatusSchema,
  })
  .loose()
  // Pass the literal `$id` key through `.meta()` so `z.toJSONSchema()` emits a
  // top-level `$id` carrying the versioned identifier.
  .meta({
    $id: DELIVERY_CONTROL_SCHEMA_ID,
    title: "Delivery control",
    description:
      "One operator control of a spec delivery's outbox (SB-FR-014). `kind` names the control, `target_id` what it acts on; the body is an open object.",
  });
export type DeliveryControl = z.infer<typeof DeliveryControlSchema>;

// ── Runtime validator ──
//
// Wraps `safeParse` (never throws) and returns a discriminated result, as
// validateDeliveryEvent does. On failure each zod issue becomes a
// `path: message` string keyed by the field that failed.

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function zodIssuesToFieldErrors(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateDeliveryControl(raw: unknown): ValidationResult<DeliveryControl> {
  const parsed = DeliveryControlSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
