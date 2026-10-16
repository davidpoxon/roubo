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
// Compatibility posture (SB-NFR-007): closed enums per field, widened by a
// minor bump. `kind` and `status` are CLOSED enums: a reader that applies a
// control cannot act on a kind or a status it does not know, so a new value is
// an additive change that bumps the minor, which scripts/contract-compatibility.ts
// classifies. Every object stays `.loose()`: the control of each kind and its
// body keep an unknown key, so a later minor version adds a field without a
// major bump. The control itself is a discriminated union over `kind`, one
// option per kind with that kind's typed body; a ninth option is additive, a
// lost one breaking. The suite enforces the bump rule against the committed
// baseline under shared/__fixtures__/contract-baselines/.

import { z } from "zod";

// ── Versioned schema identifier ──

export const DELIVERY_CONTROL_SCHEMA_ID = "https://roubo.dev/schema/delivery-control/v1.0.0.json";
export const DELIVERY_CONTROL_SCHEMA_VERSION = "1.0.0";

// ── Shared scalars ──

// An RFC 3339 timestamp with any offset, e.g. 2026-10-16T09:30:00Z.
const TimestampSchema = z.iso.datetime({ offset: true });
// A non-empty identifier: a delivery id, a decision id, a unit id, a role name.
const IdSchema = z.string().min(1);
// A non-empty text: an option, a note, a tier alias, a reason.
const TextSchema = z.string().min(1);

// ── status ──
//
// Where the control is in the outbox: written and not yet read (`pending`),
// read and acted on (`applied`), or read and refused (`rejected`). A closed
// enum; see the compatibility posture above.
export const DELIVERY_CONTROL_STATUSES = ["pending", "applied", "rejected"] as const;
export const DeliveryControlStatusSchema = z.enum(DELIVERY_CONTROL_STATUSES);
export type DeliveryControlStatus = z.infer<typeof DeliveryControlStatusSchema>;

// ── kind ──
//
// The eight control kinds of 1.0.0, spelled in kebab-case as the recipe step
// kinds are. `target_id` names what a kind acts on: the decision of a
// decision-answer or an overturn, the role of a role-change, what an approval
// approves. A delivery-wide control (pause, wind-down, resume, a steering note
// for every unit) carries no target.
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

// ── body, per kind ──
//
// Each kind carries the least the tooling needs to apply it. Every body is
// loose, so a later minor version adds a field (a note on an answer, a scope on
// a pause) without a major bump.

// Answer the decision `target_id` names with one of its options.
export const DecisionAnswerBodySchema = z
  .object({
    option: TextSchema,
  })
  .loose();
export type DecisionAnswerBody = z.infer<typeof DecisionAnswerBodySchema>;

// Overturn the answered decision `target_id` names with another option.
export const OverturnBodySchema = z
  .object({
    option: TextSchema,
    reason: z.string().optional(),
  })
  .loose();
export type OverturnBody = z.infer<typeof OverturnBodySchema>;

// A note that reaches a unit through the brief of a later dispatch. `unit_ids`
// names the units it applies to; empty means every unit, as the observation
// contract's steering entry spells it.
export const SteeringNoteBodySchema = z
  .object({
    note: TextSchema,
    unit_ids: z.array(IdSchema),
  })
  .loose();
export type SteeringNoteBody = z.infer<typeof SteeringNoteBodySchema>;

// Move the role `target_id` names to the tier alias the delivery tooling
// names; the contract gives the alias no vocabulary.
export const RoleChangeBodySchema = z
  .object({
    tier: TextSchema,
  })
  .loose();
export type RoleChangeBody = z.infer<typeof RoleChangeBodySchema>;

// A delivery-wide control (pause, wind-down, resume) and an approval carry an
// optional reason and nothing else at 1.0.0.
export const ReasonBodySchema = z
  .object({
    reason: z.string().optional(),
  })
  .loose();
export type ReasonBody = z.infer<typeof ReasonBodySchema>;

export const PauseBodySchema = ReasonBodySchema;
export type PauseBody = ReasonBody;
export const WindDownBodySchema = ReasonBodySchema;
export type WindDownBody = ReasonBody;
export const ResumeBodySchema = ReasonBodySchema;
export type ResumeBody = ReasonBody;
export const ApprovalBodySchema = ReasonBodySchema;
export type ApprovalBody = ReasonBody;

// ── The delivery control ──
//
// `$schema` is the literal DELIVERY_CONTROL_SCHEMA_ID and `schemaVersion` the
// matching literal, as every published contract in shared/ does. The control
// is a discriminated union over `kind`: the eight options share these common
// fields and each pins `kind` to one literal and `body` to that kind's body, so
// a wrong body fails at `body.<field>`. zod renders the union as a root
// `oneOf`, one option per kind, and the version `$id` sits beside it.
const commonFields = {
  $schema: z.literal(DELIVERY_CONTROL_SCHEMA_ID),
  schemaVersion: z.literal(DELIVERY_CONTROL_SCHEMA_VERSION),
  delivery_id: IdSchema,
  // Dense, 1-based, strictly increasing per delivery: the outbox's own
  // sequence, separate from the event stream's `seq`.
  control_seq: z.number().int().min(1),
} as const;
const trailingFields = {
  issued_at: TimestampSchema,
  status: DeliveryControlStatusSchema,
} as const;

function control<K extends DeliveryControlKind, B extends z.ZodType>(kind: K, body: B) {
  return z
    .object({
      ...commonFields,
      kind: z.literal(kind),
      target_id: IdSchema.optional(),
      body,
      ...trailingFields,
    })
    .loose();
}

export const DecisionAnswerControlSchema = control("decision-answer", DecisionAnswerBodySchema);
export const OverturnControlSchema = control("overturn", OverturnBodySchema);
export const SteeringNoteControlSchema = control("steering-note", SteeringNoteBodySchema);
export const RoleChangeControlSchema = control("role-change", RoleChangeBodySchema);
export const PauseControlSchema = control("pause", PauseBodySchema);
export const WindDownControlSchema = control("wind-down", WindDownBodySchema);
export const ResumeControlSchema = control("resume", ResumeBodySchema);
export const ApprovalControlSchema = control("approval", ApprovalBodySchema);

const UNKNOWN_KIND_MESSAGE = `unknown control kind: expected one of ${DELIVERY_CONTROL_KINDS.join(", ")}`;

export const DeliveryControlSchema = z
  .discriminatedUnion(
    "kind",
    [
      DecisionAnswerControlSchema,
      OverturnControlSchema,
      SteeringNoteControlSchema,
      RoleChangeControlSchema,
      PauseControlSchema,
      WindDownControlSchema,
      ResumeControlSchema,
      ApprovalControlSchema,
    ],
    // zod reports an unmatched discriminator at the `kind` path, so the
    // field-named error reads `kind: unknown control kind: ...`.
    { error: UNKNOWN_KIND_MESSAGE },
  )
  // Pass the literal `$id` key through `.meta()` so `z.toJSONSchema()` emits a
  // top-level `$id` carrying the versioned identifier beside the root `oneOf`.
  .meta({
    $id: DELIVERY_CONTROL_SCHEMA_ID,
    title: "Delivery control",
    description:
      "One operator control of a spec delivery's outbox (SB-FR-014). `kind` names the control and picks the typed body, `target_id` what it acts on; `status` says where the control is in the outbox.",
  });
export type DeliveryControl = z.infer<typeof DeliveryControlSchema>;

// ── Runtime validator ──
//
// Wraps `safeParse` (never throws) and returns a discriminated result, as
// validateDeliveryEvent does. On failure each zod issue becomes a
// `path: message` string keyed by the field that failed, so a wrong body reads
// `body.<field>: ...` and a kind outside the eight reads `kind: ...`.

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
