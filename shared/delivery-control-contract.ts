// Delivery control contract: the compile-time source of truth (in `shared/`)
// for the published, versioned shape of one operator CONTROL (SB-FR-014,
// SB-US-005). A control is one line of the control outbox: the bench writes it
// when the operator answers a decision, overturns one, adds a steering note,
// changes a role's tier, pauses, winds down, resumes, approves, switches the
// mode, accepts an agent decision or writes on a decision's thread, and the
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
// option per kind with that kind's typed body; a twelfth option is additive, a
// lost one breaking. The suite enforces the bump rule against the committed
// baseline under shared/__fixtures__/contract-baselines/.
//
// Decision mode (SB-FR-040): three kinds join 1.0.0 (no version has shipped).
// `mode_switch` asks for the other mode, `review_accept` accepts an agent
// decision as it stands, and `thread_message` carries one operator message of a
// decision's thread. Each control carries its `durability`: a durable control
// is written to the outbox and survives a restart of the bench; a volatile one
// is held for the next read only, so a thread message the tooling never read
// is lost, never replayed. The three kinds and the read response are defined
// here; the routes that serve them come with a later unit.

import { z } from "zod";
import { DELIVERY_TEXT_MAX_LENGTH, DeliveryModeValueSchema } from "./delivery-observation-contract";

// ── Versioned schema identifier ──

export const DELIVERY_CONTROL_SCHEMA_ID = "https://roubo.dev/schema/delivery-control/v1.0.0.json";
export const DELIVERY_CONTROL_SCHEMA_VERSION = "1.0.0";
// The control read response is its own generated artifact at the same
// contract version (see "The control read response" below).
export const DELIVERY_CONTROL_READ_RESPONSE_SCHEMA_ID =
  "https://roubo.dev/schema/delivery-control-read-response/v1.0.0.json";

// ── Shared scalars ──

// An RFC 3339 timestamp with any offset, e.g. 2026-10-16T09:30:00Z.
const TimestampSchema = z.iso.datetime({ offset: true });
// A non-empty identifier: a delivery id, a decision id, a unit id, a role name.
const IdSchema = z.string().min(1);
// A non-empty text: an option, a note, a tier alias, a reason.
const TextSchema = z.string().min(1);

// ── status ──
//
// Where the control is in the outbox, in the order a control moves through:
//   pending     written to the outbox by the bench, not yet read by the tooling
//   queued      held by the bench for the next read (a volatile control, which
//               the outbox never stores), not yet read by the tooling
//   delivered   read by the tooling, not yet acted on
//   applied     acted on
//   rejected    refused by the tooling
//   superseded  replaced by a later control, such as an overturn of the answer
// The operator chose this wider vocabulary over the three-state one so the
// bench can show a control on its way and one that no longer counts. A closed
// enum; see the compatibility posture above.
export const DELIVERY_CONTROL_STATUSES = [
  "pending",
  "queued",
  "delivered",
  "applied",
  "rejected",
  "superseded",
] as const;
export const DeliveryControlStatusSchema = z.enum(DELIVERY_CONTROL_STATUSES);
export type DeliveryControlStatus = z.infer<typeof DeliveryControlStatusSchema>;

// ── durability ──
//
// Whether the control outlives the next read. See the header.
export const DELIVERY_CONTROL_DURABILITIES = ["durable", "volatile"] as const;
export const DeliveryControlDurabilitySchema = z.enum(DELIVERY_CONTROL_DURABILITIES);
export type DeliveryControlDurability = z.infer<typeof DeliveryControlDurabilitySchema>;

// ── kind ──
//
// The eleven control kinds of 1.0.0. The eight delivery controls are spelled in
// kebab-case as the recipe step kinds are; the three decision-mode controls
// carry the names SB-FR-040 gives them. `target_id` names what a kind acts on:
// the decision of a decision-answer, an overturn, a review_accept or a
// thread_message, the role of a role-change, what an approval approves. A
// delivery-wide control (pause, wind-down, resume, mode_switch, a steering note
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
  "mode_switch",
  "review_accept",
  "thread_message",
] as const;
export const DeliveryControlKindSchema = z.enum(DELIVERY_CONTROL_KINDS);
export type DeliveryControlKind = z.infer<typeof DeliveryControlKindSchema>;

// The durability of each kind. Every control but a thread message is durable.
export const DELIVERY_CONTROL_DURABILITY: Readonly<
  Record<DeliveryControlKind, DeliveryControlDurability>
> = {
  "decision-answer": "durable",
  overturn: "durable",
  "steering-note": "durable",
  "role-change": "durable",
  pause: "durable",
  "wind-down": "durable",
  resume: "durable",
  approval: "durable",
  mode_switch: "durable",
  review_accept: "durable",
  thread_message: "volatile",
};

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

// Overturn the decision `target_id` names with another option. The target is
// an answered decision, or one the session decided on its own in auto mode (an
// agent decision, whose `author` is `agent`): overturning it is the review
// outcome `overturned`, which the tooling reads back as a `review.outcome`
// event that names this control's `control_seq`.
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

// Ask for the mode `mode` names. The tooling reads it back as a `mode.changed`
// event; until then the record's `mode.pending` shows it on its way.
export const ModeSwitchBodySchema = z
  .object({
    mode: DeliveryModeValueSchema,
  })
  .loose();
export type ModeSwitchBody = z.infer<typeof ModeSwitchBodySchema>;

// Accept the agent decision `target_id` names as it stands. The body is empty
// at 1.0.0 but for an optional summary the operator wrote.
export const ReviewAcceptBodySchema = z
  .object({
    summary: z.string().max(DELIVERY_TEXT_MAX_LENGTH).optional(),
  })
  .loose();
export type ReviewAcceptBody = z.infer<typeof ReviewAcceptBodySchema>;

// One operator message on the thread of the decision `target_id` names. A
// bounded plain string; the tooling reads it back as a `review.reply`.
export const ThreadMessageBodySchema = z
  .object({
    text: z.string().min(1).max(DELIVERY_TEXT_MAX_LENGTH),
  })
  .loose();
export type ThreadMessageBody = z.infer<typeof ThreadMessageBodySchema>;

// ── The delivery control ──
//
// `$schema` is the literal DELIVERY_CONTROL_SCHEMA_ID and `schemaVersion` the
// matching literal, as every published contract in shared/ does. The control
// is a discriminated union over `kind`: the eleven options share these common
// fields and each pins `kind` to one literal, `body` to that kind's body and
// `durability` to that kind's durability, so a wrong body fails at
// `body.<field>`. zod renders the union as a root `oneOf`, one option per
// kind, and the version `$id` sits beside it.
const commonFields = {
  $schema: z.literal(DELIVERY_CONTROL_SCHEMA_ID),
  schemaVersion: z.literal(DELIVERY_CONTROL_SCHEMA_VERSION),
  delivery_id: IdSchema,
  // Dense, 1-based, strictly increasing per delivery: the outbox's own
  // sequence, separate from the event stream's `seq`. A volatile control
  // takes a seq of the same sequence, so a read-back can name it.
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
      durability: z.literal(DELIVERY_CONTROL_DURABILITY[kind]),
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
export const ModeSwitchControlSchema = control("mode_switch", ModeSwitchBodySchema);
export const ReviewAcceptControlSchema = control("review_accept", ReviewAcceptBodySchema);
export const ThreadMessageControlSchema = control("thread_message", ThreadMessageBodySchema);

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
      ModeSwitchControlSchema,
      ReviewAcceptControlSchema,
      ThreadMessageControlSchema,
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
      "One operator control of a spec delivery's outbox (SB-FR-014). `kind` names the control and picks the typed body, `target_id` what it acts on; `durability` says whether the control outlives the next read, `status` where it is in the outbox.",
  });
export type DeliveryControl = z.infer<typeof DeliveryControlSchema>;

// ── The control read response ──
//
// What the tooling gets when it reads the outbox (SB-FR-040). The read is a
// long poll, and its route answers with one of two bodies:
//   the normal reply      `{controls, latestSeq}`: the controls after the seq
//                         the reader asked for, in `control_seq` order, durable
//                         and volatile alike, and `latestSeq`, the highest
//                         `control_seq` the bench has issued (0 before any),
//                         so a reader that got an empty list still knows where
//                         the outbox is. It carries no `superseded`.
//   the superseded reply  `{controls: [], superseded: true}`: the boolean that
//                         ends a first read when a second read for the same
//                         bench arrives. It carries no controls and no
//                         `latestSeq`; the second read is the one that gets
//                         them.
// The schema is the union of the two, rendered into schema/ as its own
// versioned artifact with a committed baseline and a published pin, as the
// control itself is. Each option forbids the other's key, so a body that mixes
// them (a `superseded` list beside `latestSeq`) matches neither.
const NOT_IN_A_NORMAL_REPLY =
  "a normal reply carries no superseded: only the superseded reply does, as the boolean true";
const NOT_IN_A_SUPERSEDED_REPLY =
  "a superseded reply carries no latestSeq: the read that superseded it gets the controls";

export const DeliveryControlReadReplySchema = z
  .object({
    controls: z.array(DeliveryControlSchema),
    latestSeq: z.number().int().min(0),
    superseded: z.never({ error: NOT_IN_A_NORMAL_REPLY }).optional(),
  })
  .loose();
export type DeliveryControlReadReply = z.infer<typeof DeliveryControlReadReplySchema>;

export const DeliveryControlReadSupersededSchema = z
  .object({
    controls: z.tuple([], { error: "a superseded reply carries no controls" }),
    superseded: z.literal(true),
    latestSeq: z.never({ error: NOT_IN_A_SUPERSEDED_REPLY }).optional(),
  })
  .loose();
export type DeliveryControlReadSuperseded = z.infer<typeof DeliveryControlReadSupersededSchema>;

export const DeliveryControlReadResponseSchema = z
  .union([DeliveryControlReadReplySchema, DeliveryControlReadSupersededSchema])
  .meta({
    $id: DELIVERY_CONTROL_READ_RESPONSE_SCHEMA_ID,
    title: "Delivery control read response",
    description:
      "The body of one read of a spec delivery's control outbox (SB-FR-040): the normal reply {controls, latestSeq}, or the superseded reply {controls: [], superseded: true} that ends a first read when a second read for the same bench arrives.",
  });
export type DeliveryControlReadResponse = z.infer<typeof DeliveryControlReadResponseSchema>;

// ── Runtime validator ──
//
// Wraps `safeParse` (never throws) and returns a discriminated result, as
// validateDeliveryEvent does. On failure each zod issue becomes a
// `path: message` string keyed by the field that failed, so a wrong body reads
// `body.<field>: ...` and a kind outside the eleven reads `kind: ...`.

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

export function validateDeliveryControlReadResponse(
  raw: unknown,
): ValidationResult<DeliveryControlReadResponse> {
  // Pick the option by the presence of `superseded`, so an error names the
  // field that failed rather than the union as a whole.
  const superseded =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && "superseded" in raw;
  const parsed = superseded
    ? DeliveryControlReadSupersededSchema.safeParse(raw)
    : DeliveryControlReadReplySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
