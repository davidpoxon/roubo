// Delivery observation contract: the compile-time source of truth (in `shared/`)
// for the two published, versioned shapes a Spec Bench reads from any delivery
// tooling (SB-FR-005, SB-FR-006): the delivery RECORD, one document that
// describes the whole delivery at a point in time, and the delivery EVENT
// envelope, one line of the append-only event stream that moves the record.
//
// Mirrors work-units-contract.ts: a zod source schema, the inferred type, a
// runtime validator returning field-named errors, and a versioned `$id`
// constant per schema. The generate script renders both into schema/ and the CI
// drift guard keeps the committed JSON equal to the zod source.
//
// Agent-agnostic by construction (SB-NFR-001). The contract names roles
// (`main`, `unit-manager`, `unit-coder`, `gate-verifier`) and tiers, never a
// vendor, a model or a tool; every string a tool writes into the record is a
// value, not a key the schema knows.
//
// Compatibility posture (SB-NFR-007). Additive change is the normal change:
// every object in both schemas is `.loose()`, so an unknown key is kept, never
// rejected, and a later minor version can add a field without a major bump.
// Status vocabularies are open strings for the same reason: a reader that
// switches on a status treats an unknown value as "other", and the vocabulary
// can grow inside one major. The decision-mode vocabularies (the mode value, the
// review statuses, a provisional mark) are the exception: they are closed enums,
// because a reader acts on them (SB-FR-040) and a value outside them is a
// malformed event, not an "other"; a closed enum grows by a minor bump.
// Removing or renaming a field, or making an optional field required, is a
// breaking change and bumps the major. scripts/contract-compatibility.ts
// classifies a change against the committed baseline (the render of the last
// published version, pinned by version and sha256 in
// shared/__fixtures__/contract-baselines/published.json) and the suite enforces
// the bump rule: an additive change needs at least a minor bump, a breaking one
// a major bump. Publishing a version regenerates schema/, copies the render
// over the baseline and re-pins it.
//
// Decision mode (SB-FR-040). The record carries the mode (`attended` or `auto`),
// a `review` section, per decision the fields a review reads (`author`,
// `chosen`, `rationale`, `affected_units`, `review`) and per gate a provisional
// state. Seven event types move them; their payloads are typed here (see
// "Decision-mode event payloads").
//
// Record 1.1.0 (SB-FR-018, SB-FR-020) adds two optional, additive parts: a
// per-role cost map on the budget (`by_role`), and the spec-edit fields of a
// drift entry (`file`, `summary`, `ids`, `pr_url`). A 1.0.0 record still reads:
// it is the same major (see checkDeliveryRecord in delivery-bench.ts).
//
// Event 2.0.0 (SB-FR-006, SB-NFR-007) makes the event schema a union: one typed
// member per event type the reducer applies, each with its payload typed, and a
// last catch-all member with an open `type` and an open payload for any other
// type (see "The delivery event union"). A payload that 1.0.0 accepted can now
// fail, so the major moved. The record did not change and stays at 1.1.0.
//
// Record 1.2.0 and event 2.1.0 (SB-FR-021, #1615) add an optional `effort` to
// a role, beside its `tier`: the reasoning effort the role runs at, as the
// delivery tooling names it. A role in the record and in `delivery.planned`
// carries it, and so does the `roles.applied` read-back. A record or an event
// without it still reads, and an event stamped at an earlier minor of the same
// major still validates (see validateDeliveryEvent).
//
// Record 1.3.0 and event 2.2.0 (#1684) say when each session of the delivery
// started and ended. The record carries an optional `sessions` list, and two
// event types move it: `session.started` and `session.ended`. Each payload
// carries its own time, because the tooling can date a session's end only
// after the fact (a session that crashed ended when it was last seen, which
// the tooling knows once a later session resumes the delivery), so the
// envelope's `ts` is not the bound. A record without `sessions` says nothing
// about its sessions; a reader then falls back on the lifecycle.
//
// Record 1.4.0 (#1680) adds three optional times to the `review` section:
// `called_at`, `opened_at` and `closed_at`. A review that becomes `pending` or
// closes sends no event, so without them a reader cannot tell when either
// happened. The event schema did not change and stays at 2.2.0.

import { z } from "zod";

// ── Versioned schema identifiers ──
//
// Each published document carries a `$schema` URI whose path embeds a semver
// and a matching `schemaVersion` string. The two schemas version independently.

export const DELIVERY_RECORD_SCHEMA_ID = "https://roubo.dev/schema/delivery-record/v1.4.0.json";
export const DELIVERY_RECORD_SCHEMA_VERSION = "1.4.0";

export const DELIVERY_EVENT_SCHEMA_ID = "https://roubo.dev/schema/delivery-event/v2.2.0.json";
export const DELIVERY_EVENT_SCHEMA_VERSION = "2.2.0";

// ── Shared scalars ──

// An RFC 3339 timestamp with any offset, e.g. 2026-10-16T09:30:00Z.
const TimestampSchema = z.iso.datetime({ offset: true });

// True when `value` is a timestamp the contract accepts, so a reader that
// copies a time out of an open payload into the record keeps the record valid.
export function isDeliveryTimestamp(value: unknown): value is string {
  return TimestampSchema.safeParse(value).success;
}
// A non-empty identifier: a unit id, a gate id, a decision id, a stack name.
const IdSchema = z.string().min(1);
// An open status word. See the compatibility posture above.
const StatusSchema = z.string().min(1);

// The longest text a session writes into the record or an event: a decision's
// rationale, a review summary, a provisional mark's evidence, a thread message.
// Every such field is a bounded plain string, never markup or an object, so a
// view can render it as text and a store can size it.
export const DELIVERY_TEXT_MAX_LENGTH = 4000;
const BoundedTextSchema = z.string().max(DELIVERY_TEXT_MAX_LENGTH);
// A session-authored line that cannot be empty: a decision's question, one of
// its options, the chosen option, an author or reviewer name, a review trigger.
// Bounded by the same limit, so no session-authored string escapes it.
const BoundedLineSchema = BoundedTextSchema.min(1);

// ── Decision-mode vocabularies ──
//
// Closed enums (see the compatibility posture above).

// The delivery's mode: `attended` stops at each boundary for the operator,
// `auto` lets the session decide and queues each decision for review.
export const DELIVERY_MODES = ["attended", "auto"] as const;
export const DeliveryModeValueSchema = z.enum(DELIVERY_MODES);
export type DeliveryModeValue = z.infer<typeof DeliveryModeValueSchema>;

// The review section's status: `none` when nothing waits for review, `pending`
// when unreviewed items exist but no review is open, `open` while one is.
export const DELIVERY_REVIEW_STATUSES = ["none", "pending", "open"] as const;
export const DeliveryReviewStatusSchema = z.enum(DELIVERY_REVIEW_STATUSES);
export type DeliveryReviewStatus = z.infer<typeof DeliveryReviewStatusSchema>;

// A decision's review status: `unreviewed` until the operator reads it,
// `accepted` when the choice stands, `overturned` when the operator chose
// another option.
export const DECISION_REVIEW_STATUSES = ["unreviewed", "accepted", "overturned"] as const;
export const DecisionReviewStatusSchema = z.enum(DECISION_REVIEW_STATUSES);
export type DecisionReviewStatus = z.infer<typeof DecisionReviewStatusSchema>;

// A provisional mark on a gating case: what the session judged while the
// operator was away.
export const PROVISIONAL_MARKS = ["met", "not_met"] as const;
export const ProvisionalMarkSchema = z.enum(PROVISIONAL_MARKS);
export type ProvisionalMark = z.infer<typeof ProvisionalMarkSchema>;

// The author of a decision: the literal `agent` when the session decided it on
// its own (auto mode), else the name of the person who answered.
export const AGENT_AUTHOR = "agent";

// The gate status word that says the session judged the gate provisionally.
// A gate's `status` is an open string, and this is the one value of it the
// decision-mode readers act on: a gate is provisional when, and only when, its
// `status` is this word.
export const GATE_PROVISIONAL_STATUS = "provisional";

// ── units[] ──
//
// One entry per work unit the delivery plans, gates excluded (gates live under
// `stack.gates`). `stack` and `layer` place the unit in its stack: layer 0 is
// the stack's base, and a unit on its own stack names itself as `stack`.
export const DeliveryUnitSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    status: StatusSchema,
    stack: IdSchema,
    layer: z.number().int().min(0),
    depends_on: z.array(IdSchema),
    // The unit branch and its last commit, once the unit has a worktree.
    branch: z.string().optional(),
    head: z.string().optional(),
    // The pull request of the unit branch, once the delivery session opened
    // one. A view links a case the unit met to it (SB-FR-011). A plain string,
    // like `branch`: a reader links it only when it is an http(s) URL.
    pr_url: z.string().optional(),
    cost_usd: z.number().min(0).optional(),
  })
  .loose();
export type DeliveryUnit = z.infer<typeof DeliveryUnitSchema>;

// ── stack ──
//
// `stacks` maps a stack name to the ordered unit ids on it, base first. A gate
// runs after the units in `after` are done and judges `cases`.
//
// Provisional state (SB-FR-040). In auto mode a gate the session judged while
// the operator was away has the `status` `provisional` (GATE_PROVISIONAL_STATUS):
// `provisionalCases` then carries the mark the session gave each gating case,
// with its evidence, and `confirmed` turns true when the operator confirms that
// mark. The status word is the one key of the provisional state; there is no
// separate flag.
export const ProvisionalCaseSchema = z
  .object({
    case: IdSchema,
    mark: ProvisionalMarkSchema,
    evidence: BoundedTextSchema,
    confirmed: z.boolean(),
  })
  .loose();
export type ProvisionalCase = z.infer<typeof ProvisionalCaseSchema>;

export const DeliveryGateSchema = z
  .object({
    id: IdSchema,
    after: z.array(IdSchema).min(1),
    status: StatusSchema,
    cases: z.array(IdSchema),
    provisionalCases: z.array(ProvisionalCaseSchema).optional(),
  })
  .loose();
export type DeliveryGate = z.infer<typeof DeliveryGateSchema>;

export const DeliveryStackSchema = z
  .object({
    stacks: z.record(IdSchema, z.array(IdSchema).min(1)),
    gates: z.array(DeliveryGateSchema),
  })
  .loose();
export type DeliveryStack = z.infer<typeof DeliveryStackSchema>;

// ── decisions[] ──
//
// A choice a unit took on its default while the operator was away. `default`
// is one of `options`; the runtime validator checks that.
//
// Review fields (SB-FR-040). Once decided, `author` names who chose (`agent`
// when the session did, in auto mode, else the person), `chosen` the option,
// `rationale` why, `affected_units` the units that build on it, and `review`
// where the operator's review of an agent decision stands: `reviewer` and
// `summary` come with the outcome. All five are absent on an open decision.
export const DecisionReviewSchema = z
  .object({
    status: DecisionReviewStatusSchema,
    reviewer: BoundedLineSchema.optional(),
    summary: BoundedTextSchema.optional(),
  })
  .loose();
export type DecisionReview = z.infer<typeof DecisionReviewSchema>;

export const DeliveryDecisionSchema = z
  .object({
    id: IdSchema,
    question: BoundedLineSchema,
    options: z.array(BoundedLineSchema).min(2),
    default: BoundedLineSchema,
    status: StatusSchema,
    unit_id: IdSchema.optional(),
    raised_at: TimestampSchema,
    author: BoundedLineSchema.optional(),
    chosen: BoundedLineSchema.optional(),
    rationale: BoundedTextSchema.optional(),
    affected_units: z.array(IdSchema).optional(),
    review: DecisionReviewSchema.optional(),
    decided_at: TimestampSchema.optional(),
  })
  .loose();
export type DeliveryDecision = z.infer<typeof DeliveryDecisionSchema>;

// ── steering[] ──
//
// A note from the operator that reaches a unit through the brief of a later
// dispatch. `unit_ids` names the units it applies to; empty means every unit.
export const DeliverySteeringSchema = z
  .object({
    id: IdSchema,
    note: z.string().min(1),
    unit_ids: z.array(IdSchema),
    created_at: TimestampSchema,
  })
  .loose();
export type DeliverySteering = z.infer<typeof DeliverySteeringSchema>;

// ── budget ──
//
// `by_role` (1.1.0) is the spend so far per role, keyed by role name as `roles`
// is, for the burn meter's per-role breakdown (SB-FR-018). The per-unit
// breakdown reads each unit's own `cost_usd`.
export const DeliveryBudgetSchema = z
  .object({
    estimate_usd: z.number().min(0),
    soft_budget_usd: z.number().min(0),
    spent_usd: z.number().min(0),
    by_role: z.record(IdSchema, z.number().min(0)).optional(),
  })
  .loose();
export type DeliveryBudget = z.infer<typeof DeliveryBudgetSchema>;

// ── roles ──
//
// Keyed by role name. `tier` is the alias of the model tier the role runs at,
// as the delivery tooling names it; the contract gives it no vocabulary.
// `effort` (1.2.0) is the reasoning effort the role runs at, also as the
// tooling names it and also with no vocabulary; a tooling that has no effort
// per role leaves it out.
export const DeliveryRoleSchema = z
  .object({
    tier: z.string().min(1),
    effort: z.string().min(1).optional(),
  })
  .loose();
export type DeliveryRole = z.infer<typeof DeliveryRoleSchema>;

// ── health ──
export const DeliveryHealthSchema = z
  .object({
    status: StatusSchema,
    checked_at: TimestampSchema,
    detail: z.string().optional(),
  })
  .loose();
export type DeliveryHealth = z.infer<typeof DeliveryHealthSchema>;

// ── drift[] ──
//
// Something moved under the delivery: the spec changed after the plan was
// made, or a worktree carries work no unit of the delivery made.
//
// A spec edit (1.1.0, SB-FR-020) also names the spec `file` it changed, a one
// line `summary`, the `ids` it minted (requirement, story or case ids) and
// `pr_url`, the pull request of the spec layer that carries the edit. A plain
// string, like a unit's `pr_url`: a reader links it only when it is an http(s)
// URL.
export const DeliveryDriftSchema = z
  .object({
    kind: z.string().min(1),
    detail: z.string().min(1),
    detected_at: TimestampSchema,
    unit_id: IdSchema.optional(),
    file: z.string().min(1).optional(),
    summary: BoundedLineSchema.optional(),
    ids: z.array(IdSchema).optional(),
    pr_url: z.string().optional(),
  })
  .loose();
export type DeliveryDrift = z.infer<typeof DeliveryDriftSchema>;

// ── seams ──
//
// Keyed by seam name: one entry per command the delivery tooling runs for the
// bench (plan, merge results, gate status, and so on), with its last outcome.
// `unit_id` names the unit the seam ran inside, so a unit's drill-in marks it
// on that unit's timeline (SB-FR-013); a seam without one marks no unit.
export const DeliverySeamSchema = z
  .object({
    status: StatusSchema,
    last_run_at: TimestampSchema.optional(),
    detail: z.string().optional(),
    unit_id: IdSchema.optional(),
  })
  .loose();
export type DeliverySeam = z.infer<typeof DeliverySeamSchema>;

// ── lifecycle ──
export const DeliveryLifecycleSchema = z
  .object({
    state: StatusSchema,
    armed: z.boolean(),
    started_at: TimestampSchema,
    ended_at: TimestampSchema.nullable().optional(),
  })
  .loose();
export type DeliveryLifecycle = z.infer<typeof DeliveryLifecycleSchema>;

// ── sessions[] ──
//
// One entry per session of the delivery (1.3.0, #1684), oldest first. `id` is
// the tooling's own name for the session. A session is live from `started_at`
// until `ended_at`; a null or absent `ended_at` means it has not ended, as far
// as the tooling knows. Several sessions can be live at once. The list is
// optional: a tooling that cannot date its sessions leaves it out.
export const DeliverySessionSchema = z
  .object({
    id: IdSchema,
    started_at: TimestampSchema,
    ended_at: TimestampSchema.nullable().optional(),
  })
  .loose();
export type DeliverySession = z.infer<typeof DeliverySessionSchema>;

// ── mode ──
//
// `value` is the mode in effect. `pending` is the mode a switch asked for that
// the delivery tooling has not applied yet (a `mode_switch` control on its
// way), or null when none is.
export const DeliveryModeSchema = z
  .object({
    value: DeliveryModeValueSchema,
    pending: DeliveryModeValueSchema.nullable().optional(),
  })
  .loose();
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

// ── review ──
//
// The operator's review of what the session decided in auto mode. `trigger`
// says what opened the review (a boundary, a gate, the operator); the contract
// gives it no vocabulary. `unreviewed` lists the decisions whose review is
// still `unreviewed`, oldest first.
//
// The times (1.4.0, #1680) describe the latest review: `called_at` is when the
// status last left `none` (to `pending`, or straight to `open`), `opened_at`
// when it last became `open`, and `closed_at` when it last went back to `none`.
// A later review moves them again, so a `closed_at` before `opened_at` belongs
// to an earlier review. A writer that does not know a time leaves its key out.
export const DeliveryReviewSchema = z
  .object({
    status: DeliveryReviewStatusSchema,
    trigger: BoundedLineSchema.optional(),
    unreviewed: z.array(IdSchema),
    called_at: TimestampSchema.optional(),
    opened_at: TimestampSchema.optional(),
    closed_at: TimestampSchema.optional(),
  })
  .loose();
export type DeliveryReview = z.infer<typeof DeliveryReviewSchema>;

// ── The delivery record ──
//
// `$schema` is the literal DELIVERY_RECORD_SCHEMA_ID and `schemaVersion` the
// matching literal, as every published contract in shared/ does. The ten
// sections SB-FR-005 names and the two decision-mode sections (SB-FR-040) are
// required; `.loose()` keeps the root open to later additions.
export const DeliveryRecordSchema = z
  .object({
    $schema: z.literal(DELIVERY_RECORD_SCHEMA_ID),
    schemaVersion: z.literal(DELIVERY_RECORD_SCHEMA_VERSION),
    delivery_id: IdSchema,
    // The `.specifications/<slug>/` folder name of the delivered spec.
    spec_slug: IdSchema,
    // The digest of the test plan the delivery runs against.
    plan_hash: z.string().min(1),
    mode: DeliveryModeSchema,
    review: DeliveryReviewSchema,
    stack: DeliveryStackSchema,
    units: z.array(DeliveryUnitSchema),
    decisions: z.array(DeliveryDecisionSchema),
    steering: z.array(DeliverySteeringSchema),
    budget: DeliveryBudgetSchema,
    roles: z.record(IdSchema, DeliveryRoleSchema),
    health: DeliveryHealthSchema,
    drift: z.array(DeliveryDriftSchema),
    seams: z.record(IdSchema, DeliverySeamSchema),
    lifecycle: DeliveryLifecycleSchema,
    sessions: z.array(DeliverySessionSchema).optional(),
    // The `seq` of the last event folded into this record, 0 before any.
    last_event_seq: z.number().int().min(0),
    updated_at: TimestampSchema,
  })
  .loose()
  // Pass the literal `$id` key through `.meta()` so `z.toJSONSchema()` emits a
  // top-level `$id` carrying the versioned identifier.
  .meta({
    $id: DELIVERY_RECORD_SCHEMA_ID,
    title: "Delivery record",
    description:
      "One document describing a spec delivery at a point in time (SB-FR-005). Unknown keys are kept: a minor version adds fields, a major version removes them.",
  });
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

// ── Decision-mode event payloads (SB-FR-040) ──
//
// One typed payload per decision-mode event type. Each is `.loose()`, so a
// producer may add a key. A payload field a session writes as prose is a
// bounded plain string. The envelope addresses the unit by `unit_id`; every
// other entity is named by a payload key (`decision_id`, `gate_id`).
//
// Read-back. When an event reports that the tooling applied an operator
// control, it is a read-back of that control and carries the control's
// `control_seq`, or `in_reply_to` naming the message it answers. `mode.changed`
// reads back a `mode_switch`, `review.outcome` a `review_accept` or an
// `overturn`, `review.reply` a `thread_message`, `roles.applied` a
// `role-change`; a `review.reply` is always a read-back, so it must carry one
// of the two.
const readBackFields = {
  control_seq: z.number().int().min(1).optional(),
  in_reply_to: IdSchema.optional(),
} as const;

export const ModeChangedPayloadSchema = z
  .object({
    value: DeliveryModeValueSchema,
    pending: DeliveryModeValueSchema.nullable().optional(),
    ...readBackFields,
  })
  .loose();
export type ModeChangedPayload = z.infer<typeof ModeChangedPayloadSchema>;

// The session decided a decision on its own (auto mode), or the tooling
// recorded an answer. A decision the stream never raised can come whole:
// `question`, `options` and `default` then describe it.
export const DecisionDecidedPayloadSchema = z
  .object({
    decision_id: IdSchema,
    chosen: BoundedLineSchema,
    author: BoundedLineSchema.optional(),
    rationale: BoundedTextSchema.optional(),
    affected_units: z.array(IdSchema).optional(),
    status: StatusSchema.optional(),
    decided_at: TimestampSchema.optional(),
    question: BoundedLineSchema.optional(),
    options: z.array(BoundedLineSchema).min(2).optional(),
    default: BoundedLineSchema.optional(),
    ...readBackFields,
  })
  .loose();
export type DecisionDecidedPayload = z.infer<typeof DecisionDecidedPayloadSchema>;

export const ReviewOpenedPayloadSchema = z
  .object({
    trigger: BoundedLineSchema.optional(),
    unreviewed: z.array(IdSchema).optional(),
    ...readBackFields,
  })
  .loose();
export type ReviewOpenedPayload = z.infer<typeof ReviewOpenedPayloadSchema>;

// The operator's review of one decision landed: `accepted` or `overturned`,
// with the option an overturn chose in `chosen`.
export const ReviewOutcomePayloadSchema = z
  .object({
    decision_id: IdSchema,
    status: z.enum(["accepted", "overturned"]),
    reviewer: BoundedLineSchema.optional(),
    summary: BoundedTextSchema.optional(),
    chosen: BoundedLineSchema.optional(),
    reviewed_at: TimestampSchema.optional(),
    ...readBackFields,
  })
  .loose();
export type ReviewOutcomePayload = z.infer<typeof ReviewOutcomePayloadSchema>;

// One message of a decision's thread.
export const ReviewReplyPayloadSchema = z
  .object({
    decision_id: IdSchema,
    text: BoundedLineSchema,
    author: BoundedLineSchema.optional(),
    ...readBackFields,
  })
  .loose()
  .refine((payload) => payload.control_seq !== undefined || payload.in_reply_to !== undefined, {
    message: "a review.reply reads back a thread message, so it carries control_seq or in_reply_to",
    path: ["in_reply_to"],
  });
export type ReviewReplyPayload = z.infer<typeof ReviewReplyPayloadSchema>;

// The session judged a gate provisionally: one mark per gating case. The gate's
// `status` becomes `provisional`; the payload carries no status of its own.
export const GateProvisionalPayloadSchema = z
  .object({
    gate_id: IdSchema,
    cases: z.array(
      z
        .object({
          case: IdSchema,
          mark: ProvisionalMarkSchema,
          evidence: BoundedTextSchema.optional(),
          confirmed: z.boolean().optional(),
        })
        .loose(),
    ),
    ...readBackFields,
  })
  .loose();
export type GateProvisionalPayload = z.infer<typeof GateProvisionalPayloadSchema>;

// The operator confirmed a provisional gate's marks: the cases named, or every
// provisional case when `cases` is absent. Once every mark is confirmed the
// gate leaves the `provisional` status for `status` when given, else
// `confirmed`.
export const GateConfirmedPayloadSchema = z
  .object({
    gate_id: IdSchema,
    cases: z.array(IdSchema).optional(),
    status: StatusSchema.optional(),
    ...readBackFields,
  })
  .loose();
export type GateConfirmedPayload = z.infer<typeof GateConfirmedPayloadSchema>;

// ── Section event payloads ──
//
// One typed payload per event type that moves a record section. Each is the
// patch the reducer reads (see the `*Payload` views of delivery-reducer.ts):
// every key is optional, so a sparser payload is valid and the reducer applies
// what it carries, and every key that a record field also names has that
// field's type, so a wrongly typed key fails here instead of reaching the fold.
// Each is `.loose()`, like the sections they patch. The envelope addresses the
// unit by `unit_id`; every other entity is named by a payload key.

// The plan, whole or in part: the units, the stacks, the gates, the budget and
// the roles the tooling planned.
export const DeliveryPlannedPayloadSchema = z
  .object({
    units: z.array(DeliveryUnitSchema).optional(),
    stacks: z.record(IdSchema, z.array(IdSchema)).optional(),
    gates: z.array(DeliveryGateSchema).optional(),
    budget: DeliveryBudgetSchema.partial().optional(),
    roles: z.record(IdSchema, DeliveryRoleSchema).optional(),
  })
  .loose();

export const LifecycleChangedPayloadSchema = DeliveryLifecycleSchema.partial();

// One role's tier and effort, applied (SB-FR-021), named by `role`. It reads
// back a `role-change` control by its `control_seq`.
export const RolesAppliedPayloadSchema = z
  .object({
    role: IdSchema.optional(),
    tier: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    ...readBackFields,
  })
  .loose();

// A patch of the unit the envelope's `unit_id` names.
export const UnitChangedPayloadSchema = DeliveryUnitSchema.omit({ id: true }).partial();

export const GateChangedPayloadSchema = DeliveryGateSchema.omit({ id: true })
  .partial()
  .extend({ gate_id: IdSchema.optional() });

// A decision raised, whole. Its id is `decision_id`, or `id`.
export const DecisionRaisedPayloadSchema = DeliveryDecisionSchema.omit({ id: true })
  .partial()
  .extend({ decision_id: IdSchema.optional(), id: IdSchema.optional() });

export const DecisionAnsweredPayloadSchema = z
  .object({
    decision_id: IdSchema.optional(),
    id: IdSchema.optional(),
    status: StatusSchema.optional(),
    answer: BoundedLineSchema.optional(),
    answered_at: TimestampSchema.optional(),
  })
  .loose();

// The session went on with a decision's default (SB-FR-015); `chosen` names
// the applied option when it is not the default.
export const DecisionDefaultedPayloadSchema = z
  .object({
    decision_id: IdSchema.optional(),
    id: IdSchema.optional(),
    status: StatusSchema.optional(),
    chosen: BoundedLineSchema.optional(),
    defaulted_at: TimestampSchema.optional(),
  })
  .loose();

// The operator's overturn of a default landed: `chosen`, or `option` as the
// overturn control's body names it, is the option that replaced it.
export const DecisionOverturnedPayloadSchema = z
  .object({
    decision_id: IdSchema.optional(),
    id: IdSchema.optional(),
    status: StatusSchema.optional(),
    chosen: BoundedLineSchema.optional(),
    option: BoundedLineSchema.optional(),
    overturned_at: TimestampSchema.optional(),
    ...readBackFields,
  })
  .loose();

// A steering note. Its id is `steering_id`, or `id`; `control_seq` names the
// steering-note control it reads back.
export const SteeringAddedPayloadSchema = DeliverySteeringSchema.omit({ id: true })
  .partial()
  .extend({ steering_id: IdSchema.optional(), id: IdSchema.optional(), ...readBackFields });

export const BudgetChangedPayloadSchema = DeliveryBudgetSchema.partial();

export const HealthChangedPayloadSchema = DeliveryHealthSchema.partial();

export const DriftDetectedPayloadSchema = DeliveryDriftSchema.partial();

// One run of the seam that `seam` names.
export const SeamRanPayloadSchema = DeliverySeamSchema.partial().extend({
  seam: IdSchema.optional(),
});

// ── Session event payloads (#1684) ──
//
// One typed payload per session event type: the session's entry of the record
// (see "sessions[]"), or the part of it that moved. Unlike a section patch,
// each names its session by `id` and carries its time, both required: an event
// without them says nothing.

// A session of the delivery started (1.3.0, #1684), named by `id`, at
// `started_at`.
export const SessionStartedPayloadSchema = z
  .object({
    id: IdSchema,
    started_at: TimestampSchema,
  })
  .loose();
export type SessionStartedPayload = z.infer<typeof SessionStartedPayloadSchema>;

// A session of the delivery ended, at `ended_at`. The tooling may send it
// after the fact, so `ended_at` can be earlier than the envelope's `ts`.
export const SessionEndedPayloadSchema = z
  .object({
    id: IdSchema,
    ended_at: TimestampSchema,
  })
  .loose();
export type SessionEndedPayload = z.infer<typeof SessionEndedPayloadSchema>;

// ── The delivery event union ──
//
// Every event type the reducer applies, each with the payload it carries: the
// seven decision-mode types, the fourteen section types and the two session types. The validator
// reads this table by own key, so a type it does not list goes to the
// catch-all.
export const DELIVERY_EVENT_PAYLOADS = {
  "delivery.planned": DeliveryPlannedPayloadSchema,
  "lifecycle.changed": LifecycleChangedPayloadSchema,
  "session.started": SessionStartedPayloadSchema,
  "session.ended": SessionEndedPayloadSchema,
  "roles.applied": RolesAppliedPayloadSchema,
  "unit.changed": UnitChangedPayloadSchema,
  "gate.changed": GateChangedPayloadSchema,
  "decision.raised": DecisionRaisedPayloadSchema,
  "decision.answered": DecisionAnsweredPayloadSchema,
  "decision.defaulted": DecisionDefaultedPayloadSchema,
  "decision.overturned": DecisionOverturnedPayloadSchema,
  "steering.added": SteeringAddedPayloadSchema,
  "budget.changed": BudgetChangedPayloadSchema,
  "health.changed": HealthChangedPayloadSchema,
  "drift.detected": DriftDetectedPayloadSchema,
  "seam.ran": SeamRanPayloadSchema,
  "mode.changed": ModeChangedPayloadSchema,
  "decision.decided": DecisionDecidedPayloadSchema,
  "review.opened": ReviewOpenedPayloadSchema,
  "review.outcome": ReviewOutcomePayloadSchema,
  "review.reply": ReviewReplyPayloadSchema,
  "gate.provisional": GateProvisionalPayloadSchema,
  "gate.confirmed": GateConfirmedPayloadSchema,
} as const;
export type DeliveryEventType = keyof typeof DELIVERY_EVENT_PAYLOADS;
export const DELIVERY_EVENT_TYPES = Object.keys(DELIVERY_EVENT_PAYLOADS) as DeliveryEventType[];

// The seven decision-mode types (SB-FR-040), a subset of the union's types.
export const DECISION_MODE_EVENT_TYPES = [
  "mode.changed",
  "decision.decided",
  "review.opened",
  "review.outcome",
  "review.reply",
  "gate.provisional",
  "gate.confirmed",
] as const satisfies readonly DeliveryEventType[];
export type DecisionModeEventType = (typeof DECISION_MODE_EVENT_TYPES)[number];

// The two session types (#1684), a subset of the union's types.
export const SESSION_EVENT_TYPES = [
  "session.started",
  "session.ended",
] as const satisfies readonly DeliveryEventType[];
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

// One envelope: the fields every event carries, with the member's `type` and
// payload.
function envelope<TType extends z.ZodType, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z
    .object({
      $schema: z.literal(DELIVERY_EVENT_SCHEMA_ID),
      schemaVersion: z.literal(DELIVERY_EVENT_SCHEMA_VERSION),
      delivery_id: IdSchema,
      type,
      // Dense, 1-based, strictly increasing per delivery.
      seq: z.number().int().min(1),
      ts: TimestampSchema,
      unit_id: IdSchema.optional(),
      payload,
    })
    .loose();
}

// The catch-all member: any non-empty `type`, any JSON object as payload. A
// reader at an older minor accepts an event type it does not know and ignores
// it, instead of rejecting the stream.
export const DeliveryEventCatchAllSchema = envelope(
  z.string().min(1),
  z.record(z.string(), z.unknown()),
);

const typedEventMembers = {} as Record<DeliveryEventType, z.ZodType>;
for (const type of DELIVERY_EVENT_TYPES) {
  typedEventMembers[type] = envelope(z.literal(type), DELIVERY_EVENT_PAYLOADS[type]);
}

// The union, typed members first in table order and the catch-all LAST.
//
// Routing. A JSON Schema `anyOf` validator cannot exclude a known type from the
// catch-all: a `unit.changed` event with a malformed payload still matches the
// last member, so a plain JSON Schema check accepts it. `validateDeliveryEvent`
// is what routes by `type`: a known type is parsed by its typed member and
// reports field-named payload errors, and only an unknown type reaches the
// catch-all. A reader that needs the typed check calls it, not a generic JSON
// Schema library.
//
// The compatibility classifier matches the members by their `type` const and
// the catch-all by its place (scripts/contract-compatibility.ts), so a new
// typed member is additive and a removed or changed one is breaking.
export const DeliveryEventSchema = z
  .union([
    ...DELIVERY_EVENT_TYPES.map((type) => typedEventMembers[type]),
    DeliveryEventCatchAllSchema,
  ] as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
  .meta({
    $id: DELIVERY_EVENT_SCHEMA_ID,
    title: "Delivery event",
    description:
      "One event of a spec delivery's stream (SB-FR-006). A known `type` carries its typed payload; the last member accepts any other type with an open payload.",
  });

// The validated event a caller reads: the envelope, with `type` and `payload`
// as the catch-all gives them. A reader narrows the payload by `type` on its own
// side (see the `*Payload` views of delivery-reducer.ts).
export type DeliveryEvent = z.infer<typeof DeliveryEventCatchAllSchema>;

function eventMember(type: unknown): z.ZodType {
  return typeof type === "string" && Object.hasOwn(DELIVERY_EVENT_PAYLOADS, type)
    ? typedEventMembers[type as DeliveryEventType]
    : DeliveryEventCatchAllSchema;
}

// ── Runtime validators ──
//
// Wrap `safeParse` (never throws) and return a discriminated result, mirroring
// validateWorkUnits. On failure each zod issue becomes a `path: message` string
// keyed by the field that failed.

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function zodIssuesToFieldErrors(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateDeliveryRecord(raw: unknown): ValidationResult<DeliveryRecord> {
  const parsed = DeliveryRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  // Cross-field rules, checked after the structural parse so each error names
  // its field: a decision's default is one of its options, a gate and a stack
  // name only units the record carries, and a unit's stack is one of `stacks`.
  const errors: string[] = [];
  const unitIds = new Set(parsed.data.units.map((unit) => unit.id));
  const decisionIds = new Set(parsed.data.decisions.map((decision) => decision.id));
  parsed.data.decisions.forEach((decision, index) => {
    if (!decision.options.includes(decision.default)) {
      errors.push(`decisions.${index}.default: must be one of the decision's options`);
    }
    if (decision.chosen !== undefined && !decision.options.includes(decision.chosen)) {
      errors.push(`decisions.${index}.chosen: must be one of the decision's options`);
    }
  });
  parsed.data.review.unreviewed.forEach((decisionId, index) => {
    if (!decisionIds.has(decisionId)) {
      errors.push(`review.unreviewed.${index}: names a decision the record does not carry`);
    }
  });
  for (const [name, members] of Object.entries(parsed.data.stack.stacks)) {
    members.forEach((unitId, index) => {
      if (!unitIds.has(unitId)) {
        errors.push(`stack.stacks.${name}.${index}: names a unit the record does not carry`);
      }
    });
  }
  parsed.data.stack.gates.forEach((gate, gateIndex) => {
    gate.after.forEach((unitId, index) => {
      if (!unitIds.has(unitId)) {
        errors.push(
          `stack.gates.${gateIndex}.after.${index}: names a unit the record does not carry`,
        );
      }
    });
  });
  parsed.data.units.forEach((unit, index) => {
    if (!(unit.stack in parsed.data.stack.stacks)) {
      errors.push(`units.${index}.stack: names a stack the record does not carry`);
    }
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data: parsed.data };
}

// Routes by `type` (see "Routing" above): a known type is parsed by its typed
// member, so a `review.outcome` with no decision id fails at
// `payload.decision_id` and a `gate.provisional` mark outside the vocabulary at
// `payload.cases.<i>.mark`; any other type is parsed by the catch-all. The
// parsed event keeps the raw keys (every member and payload is loose), so the
// event a caller gets back is the one it sent, validated.
//
// An event stamped at another minor or patch of this major (a tooling pinned to
// 2.0.0, say) is read as the version this bench knows, as checkDeliveryRecord
// reads a record: every member and payload keeps an unknown key, so the
// additions a minor brings pass through (SB-NFR-007). The stamp must be whole:
// `$schema` the event `$id` of exactly that `schemaVersion`. The event a caller
// gets back then carries this bench's `$schema` and `schemaVersion`. Any other
// stamp fails at `$schema` or `schemaVersion`.
export function validateDeliveryEvent(raw: unknown): ValidationResult<DeliveryEvent> {
  const type = isObject(raw) ? raw.type : undefined;
  const parsed = eventMember(type).safeParse(sameMajorEvent(raw));
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data as DeliveryEvent };
}

const EVENT_MAJOR = DELIVERY_EVENT_SCHEMA_VERSION.split(".")[0];
const EVENT_ID_PREFIX = DELIVERY_EVENT_SCHEMA_ID.slice(
  0,
  DELIVERY_EVENT_SCHEMA_ID.lastIndexOf(`/v${DELIVERY_EVENT_SCHEMA_VERSION}.json`),
);

// The event restamped at this bench's version when its own stamp is a whole
// one of the same major; otherwise the event unchanged.
function sameMajorEvent(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const version = raw.schemaVersion;
  if (typeof version !== "string" || version === DELIVERY_EVENT_SCHEMA_VERSION) return raw;
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (match?.[1] !== EVENT_MAJOR) return raw;
  if (raw.$schema !== `${EVENT_ID_PREFIX}/v${version}.json`) return raw;
  return {
    ...raw,
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
