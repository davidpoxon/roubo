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
// rejected, and a later minor version can add a field (the architecture
// amendment adds `mode`, a `review` section, decision review fields, a gate
// status and new event types) without a major bump. Status vocabularies are
// open strings for the same reason: a reader that switches on a status treats
// an unknown value as "other", and the vocabulary can grow inside one major.
// Removing or renaming a field, or making an optional field required, is a
// breaking change and bumps the major. scripts/contract-compatibility.ts
// classifies a change against the committed baseline (the render of the last
// published version, pinned by version and sha256 in
// shared/__fixtures__/contract-baselines/published.json) and the suite enforces
// the bump rule: an additive change needs at least a minor bump, a breaking one
// a major bump. Publishing a version regenerates schema/, copies the render
// over the baseline and re-pins it.

import { z } from "zod";

// ── Versioned schema identifiers ──
//
// Each published document carries a `$schema` URI whose path embeds a semver
// and a matching `schemaVersion` string. The two schemas version independently.

export const DELIVERY_RECORD_SCHEMA_ID = "https://roubo.dev/schema/delivery-record/v1.0.0.json";
export const DELIVERY_RECORD_SCHEMA_VERSION = "1.0.0";

export const DELIVERY_EVENT_SCHEMA_ID = "https://roubo.dev/schema/delivery-event/v1.0.0.json";
export const DELIVERY_EVENT_SCHEMA_VERSION = "1.0.0";

// ── Shared scalars ──

// An RFC 3339 timestamp with any offset, e.g. 2026-10-16T09:30:00Z.
const TimestampSchema = z.iso.datetime({ offset: true });
// A non-empty identifier: a unit id, a gate id, a decision id, a stack name.
const IdSchema = z.string().min(1);
// An open status word. See the compatibility posture above.
const StatusSchema = z.string().min(1);

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
    cost_usd: z.number().min(0).optional(),
  })
  .loose();
export type DeliveryUnit = z.infer<typeof DeliveryUnitSchema>;

// ── stack ──
//
// `stacks` maps a stack name to the ordered unit ids on it, base first. A gate
// runs after the units in `after` are done and judges `cases`.
export const DeliveryGateSchema = z
  .object({
    id: IdSchema,
    after: z.array(IdSchema).min(1),
    status: StatusSchema,
    cases: z.array(IdSchema),
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
export const DeliveryDecisionSchema = z
  .object({
    id: IdSchema,
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    default: z.string().min(1),
    status: StatusSchema,
    unit_id: IdSchema.optional(),
    raised_at: TimestampSchema,
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
export const DeliveryBudgetSchema = z
  .object({
    estimate_usd: z.number().min(0),
    soft_budget_usd: z.number().min(0),
    spent_usd: z.number().min(0),
  })
  .loose();
export type DeliveryBudget = z.infer<typeof DeliveryBudgetSchema>;

// ── roles ──
//
// Keyed by role name. `tier` is the alias of the model tier the role runs at,
// as the delivery tooling names it; the contract gives it no vocabulary.
export const DeliveryRoleSchema = z
  .object({
    tier: z.string().min(1),
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
export const DeliveryDriftSchema = z
  .object({
    kind: z.string().min(1),
    detail: z.string().min(1),
    detected_at: TimestampSchema,
    unit_id: IdSchema.optional(),
  })
  .loose();
export type DeliveryDrift = z.infer<typeof DeliveryDriftSchema>;

// ── seams ──
//
// Keyed by seam name: one entry per command the delivery tooling runs for the
// bench (plan, merge results, gate status, and so on), with its last outcome.
export const DeliverySeamSchema = z
  .object({
    status: StatusSchema,
    last_run_at: TimestampSchema.optional(),
    detail: z.string().optional(),
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

// ── The delivery record ──
//
// `$schema` is the literal DELIVERY_RECORD_SCHEMA_ID and `schemaVersion` the
// matching literal, as every published contract in shared/ does. The ten
// sections SB-FR-005 names are required; `.loose()` keeps the root open to the
// amended additions.
export const DeliveryRecordSchema = z
  .object({
    $schema: z.literal(DELIVERY_RECORD_SCHEMA_ID),
    schemaVersion: z.literal(DELIVERY_RECORD_SCHEMA_VERSION),
    delivery_id: IdSchema,
    // The `.specifications/<slug>/` folder name of the delivered spec.
    spec_slug: IdSchema,
    // The digest of the test plan the delivery runs against.
    plan_hash: z.string().min(1),
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

// ── The delivery event envelope ──
//
// Payload decision for 1.0.0: the payload is OPEN, a JSON object with any keys,
// and `type` is an open string. A typed payload per event type would freeze the
// event vocabulary into the envelope, and the architecture amendment already
// adds seven event types inside this major; an open payload lets a producer add
// a type and a reader ignore the ones it does not know. A reader that wants a
// typed view layers a discriminated union over `type` on its own side, which
// changes nothing here. Revisit at 2.0.0 if the vocabulary settles.
export const DeliveryEventSchema = z
  .object({
    $schema: z.literal(DELIVERY_EVENT_SCHEMA_ID),
    schemaVersion: z.literal(DELIVERY_EVENT_SCHEMA_VERSION),
    delivery_id: IdSchema,
    type: z.string().min(1),
    // Dense, 1-based, strictly increasing per delivery.
    seq: z.number().int().min(1),
    ts: TimestampSchema,
    unit_id: IdSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .loose()
  .meta({
    $id: DELIVERY_EVENT_SCHEMA_ID,
    title: "Delivery event",
    description:
      "One event of a spec delivery's stream (SB-FR-006). The payload is an open object; `type` names the event.",
  });
export type DeliveryEvent = z.infer<typeof DeliveryEventSchema>;

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
  parsed.data.decisions.forEach((decision, index) => {
    if (!decision.options.includes(decision.default)) {
      errors.push(`decisions.${index}.default: must be one of the decision's options`);
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

export function validateDeliveryEvent(raw: unknown): ValidationResult<DeliveryEvent> {
  const parsed = DeliveryEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
