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
// amendment adds `mode`, a `review` section and decision review fields) without
// a major bump. Status vocabularies are CLOSED enums, one per field, and the
// 1.0.0 vocabularies already name the states the amendment adds (gate
// `provisional`, unit `skipped`, lifecycle `armed`), so the amendment needs no
// bump for them inside this major. A value added to a vocabulary later is an
// additive change under the classifier (an enum that gained a value), so it
// moves the minor, not the major. Removing or renaming a field, making an
// optional field required, or dropping an enum value is a breaking change and
// bumps the major. scripts/contract-compatibility.ts classifies a change
// against the committed baseline (the render of the last published version,
// pinned by version and sha256 in
// shared/__fixtures__/contract-baselines/published.json) and the suite enforces
// the bump rule: an additive change needs at least a minor bump, a breaking one
// a major bump. Publishing a version regenerates schema/, copies the render
// over the baseline and re-pins it.
//
// Version history. 1.0.0 was republished once, before any consumer read it: the
// first render had a flat event envelope with an open `type` and open status
// strings, and the event union and the closed vocabularies below replaced it at
// the same version. From here on, a baseline refresh moves the version.

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

// ── Status vocabularies ──
//
// Closed, one per field. Each already carries the states the architecture
// amendment adds (`provisional`, `skipped`, `armed`); see the compatibility
// posture above for how a vocabulary grows.

export const DELIVERY_UNIT_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export const DeliveryUnitStatusSchema = z.enum(DELIVERY_UNIT_STATUSES);
export type DeliveryUnitStatus = z.infer<typeof DeliveryUnitStatusSchema>;

export const DELIVERY_GATE_STATUSES = [
  "pending",
  "running",
  "passed",
  "failed",
  "provisional",
] as const;
export const DeliveryGateStatusSchema = z.enum(DELIVERY_GATE_STATUSES);
export type DeliveryGateStatus = z.infer<typeof DeliveryGateStatusSchema>;

export const DELIVERY_LIFECYCLE_STATES = [
  "planned",
  "armed",
  "running",
  "paused",
  "done",
  "failed",
] as const;
export const DeliveryLifecycleStateSchema = z.enum(DELIVERY_LIFECYCLE_STATES);
export type DeliveryLifecycleState = z.infer<typeof DeliveryLifecycleStateSchema>;

export const DELIVERY_DECISION_STATUSES = ["open", "answered"] as const;
export const DeliveryDecisionStatusSchema = z.enum(DELIVERY_DECISION_STATUSES);
export type DeliveryDecisionStatus = z.infer<typeof DeliveryDecisionStatusSchema>;

export const DELIVERY_HEALTH_STATUSES = ["ok", "degraded", "failed"] as const;
export const DeliveryHealthStatusSchema = z.enum(DELIVERY_HEALTH_STATUSES);
export type DeliveryHealthStatus = z.infer<typeof DeliveryHealthStatusSchema>;

export const DELIVERY_SEAM_STATUSES = ["idle", "running", "ok", "failed"] as const;
export const DeliverySeamStatusSchema = z.enum(DELIVERY_SEAM_STATUSES);
export type DeliverySeamStatus = z.infer<typeof DeliverySeamStatusSchema>;

// ── units[] ──
//
// One entry per work unit the delivery plans, gates excluded (gates live under
// `stack.gates`). `stack` and `layer` place the unit in its stack: layer 0 is
// the stack's base, and a unit on its own stack names itself as `stack`.
export const DeliveryUnitSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    status: DeliveryUnitStatusSchema,
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
    status: DeliveryGateStatusSchema,
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
    status: DeliveryDecisionStatusSchema,
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
    status: DeliveryHealthStatusSchema,
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
    status: DeliverySeamStatusSchema,
    last_run_at: TimestampSchema.optional(),
    detail: z.string().optional(),
  })
  .loose();
export type DeliverySeam = z.infer<typeof DeliverySeamSchema>;

// ── lifecycle ──
export const DeliveryLifecycleSchema = z
  .object({
    state: DeliveryLifecycleStateSchema,
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
// The event schema is a union of full envelopes. One typed member per record
// section carries a literal `type` and reuses that section's schema as its
// payload, so a reader gets the section shape straight from the event. The
// LAST member is the catch-all: an open `type` and an open payload, so a
// reader at an older minor accepts an event type it does not know and ignores
// it, instead of rejecting the stream.
//
// Routing. A JSON Schema `anyOf` validator cannot exclude a known type from
// the catch-all: a `unit.changed` event with a malformed payload still matches
// the last member, so a plain JSON Schema check accepts it. The runtime
// validator below is what routes by `type`: a known type is parsed by its
// typed member and reports field-named payload errors, and only an unknown
// type reaches the catch-all. Readers that need the typed check call
// validateDeliveryEvent, not a generic JSON Schema library.
//
// The compatibility classifier compares the `anyOf` list as one value, so a
// change inside any member, a new member included, counts as breaking against
// the baseline until the classifier learns to diff union members.

function envelope<TType extends z.ZodType, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z
    .object({
      $schema: z.literal(DELIVERY_EVENT_SCHEMA_ID),
      schemaVersion: z.literal(DELIVERY_EVENT_SCHEMA_VERSION),
      delivery_id: IdSchema,
      // Dense, 1-based, strictly increasing per delivery.
      seq: z.number().int().min(1),
      ts: TimestampSchema,
      unit_id: IdSchema.optional(),
      type,
      payload,
    })
    .loose();
}

// A role or seam event names its record key, which the record's map form
// carries only as the key.
export const DeliveryRoleEventPayloadSchema = DeliveryRoleSchema.extend({ name: IdSchema });
export const DeliverySeamEventPayloadSchema = DeliverySeamSchema.extend({ name: IdSchema });

export const DELIVERY_EVENT_TYPES = [
  "unit.changed",
  "gate.changed",
  "decision.changed",
  "steering.added",
  "budget.changed",
  "role.changed",
  "health.changed",
  "drift.detected",
  "seam.changed",
  "lifecycle.changed",
] as const;
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

const typedEventMembers = {
  "unit.changed": envelope(z.literal("unit.changed"), DeliveryUnitSchema),
  "gate.changed": envelope(z.literal("gate.changed"), DeliveryGateSchema),
  "decision.changed": envelope(z.literal("decision.changed"), DeliveryDecisionSchema),
  "steering.added": envelope(z.literal("steering.added"), DeliverySteeringSchema),
  "budget.changed": envelope(z.literal("budget.changed"), DeliveryBudgetSchema),
  "role.changed": envelope(z.literal("role.changed"), DeliveryRoleEventPayloadSchema),
  "health.changed": envelope(z.literal("health.changed"), DeliveryHealthSchema),
  "drift.detected": envelope(z.literal("drift.detected"), DeliveryDriftSchema),
  "seam.changed": envelope(z.literal("seam.changed"), DeliverySeamEventPayloadSchema),
  "lifecycle.changed": envelope(z.literal("lifecycle.changed"), DeliveryLifecycleSchema),
} satisfies Record<DeliveryEventType, z.ZodType>;

// The catch-all member: any non-empty `type`, any JSON object as payload.
export const DeliveryEventCatchAllSchema = envelope(
  z.string().min(1),
  z.record(z.string(), z.unknown()),
);

export const DeliveryEventSchema = z
  .union([
    typedEventMembers["unit.changed"],
    typedEventMembers["gate.changed"],
    typedEventMembers["decision.changed"],
    typedEventMembers["steering.added"],
    typedEventMembers["budget.changed"],
    typedEventMembers["role.changed"],
    typedEventMembers["health.changed"],
    typedEventMembers["drift.detected"],
    typedEventMembers["seam.changed"],
    typedEventMembers["lifecycle.changed"],
    DeliveryEventCatchAllSchema,
  ])
  .meta({
    $id: DELIVERY_EVENT_SCHEMA_ID,
    title: "Delivery event",
    description:
      "One event of a spec delivery's stream (SB-FR-006). A known `type` carries its record section as the payload; the last member accepts any other type with an open payload.",
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

function isKnownEventType(type: unknown): type is DeliveryEventType {
  return typeof type === "string" && (DELIVERY_EVENT_TYPES as readonly string[]).includes(type);
}

// Routes by `type` (see "Routing" above): a known type is parsed by its typed
// member, so a malformed payload fails with a `payload.<field>` error instead
// of slipping through the catch-all; anything else is parsed by the catch-all.
export function validateDeliveryEvent(raw: unknown): ValidationResult<DeliveryEvent> {
  const type =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).type
      : undefined;
  const member: z.ZodType<DeliveryEvent> = isKnownEventType(type)
    ? typedEventMembers[type]
    : DeliveryEventCatchAllSchema;
  const parsed = member.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
