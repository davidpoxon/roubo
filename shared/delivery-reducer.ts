// The delivery reducer: one pure fold of a validated delivery record plus an
// ordered event list into a `DeliverySnapshot` (SB-FR-008, SB-FR-010, SB-FR-011).
// The server (`server/lib/delivery-snapshot.ts`) and the client
// (`client/src/hooks/useDeliverySnapshot.ts`) both call this module and neither
// stores a snapshot: the record and the events are the state, the snapshot is a
// projection of them.
//
// Purity. `foldDelivery` does no I/O, reads no clock (the caller passes `now`
// when it wants a staleness age) and mutates none of its inputs: every section it
// changes is copied first, so the record and the event objects a caller holds are
// untouched, and the snapshot a memoised fold remembers cannot be changed by a
// later fold either.
//
// Event vocabulary. The contract leaves `type` and `payload` open, so this module
// is the typed view over them (see the `*Payload` types below). The handlers sit
// in a table keyed by type (`EVENT_HANDLERS`), not in a closed switch, so a later
// minor version adds a type by adding a row. An event whose type has no row is
// skipped and still advances the accepted seq: unknown is never an error. A
// handler that finds a payload without the keys it needs ignores the event the
// same way, so a producer that writes a sparser payload degrades to a no-op, not
// to a throw.
//
// Addressing. The unit an event is about is the envelope's `unit_id`. Every
// other entity is named by a payload key: `gate_id`, `decision_id` (or `id`),
// `steering_id` (or `id`), `seam`.
//
// Seq rules. An event whose `seq` is at or below the accepted seq (the record's
// `last_event_seq`, then the last applied event) is ignored. The next event must
// carry `accepted + 1`; when it does not, the fold records `gap` and stops, so a
// caller refetches the record rather than showing a stream with a hole in it.
//
// Status words are open strings (the contract's compatibility posture).
// `classifyUnitStatus` and `isDecisionOpen` give the fold and the selectors one
// reading of them, each with an "other" fallback for a word they do not know.

import type {
  DeliveryBudget,
  DeliveryDecision,
  DeliveryDrift,
  DeliveryEvent,
  DeliveryGate,
  DeliveryHealth,
  DeliveryLifecycle,
  DeliveryRecord,
  DeliveryRole,
  DeliverySeam,
  DeliverySteering,
  DeliveryUnit,
} from "@roubo/shared/delivery-observation-contract";
import type { BenchResults, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import {
  effectiveCaseStatus,
  evaluateGate,
  type GateLifecycle,
  type GateState,
  type VerifyUnit,
} from "@roubo/shared/gate-evaluator";

// ── Inputs ──

// The recorded results the fold reads for gate state and progress, as the gate
// evaluator takes them: the `caseResults` body plus the file's own `planHash`.
export type DeliveryResults = BenchResults & { planHash: string };

export interface DeliveryFoldInputs {
  record: DeliveryRecord;
  // The event stream after the record, in seq order. Events at or below
  // `record.last_event_seq` are ignored, so a caller may pass the whole stream.
  events: readonly DeliveryEvent[];
  // The spec's test plan. Absent, gate state fails closed to `stale` and progress
  // reports nothing met.
  plan?: TestCasesPlan;
  // The spec's recorded results. Absent, same fail-closed reading.
  results?: DeliveryResults;
  // The caller-threaded lifecycle resolutions, as `evaluateGate` takes them.
  lifecycle?: GateLifecycle;
  // Epoch milliseconds the staleness age is computed against. Absent, the age
  // is null: the fold never reads a clock.
  now?: number;
}

// ── Snapshot ──

export interface DeliveryGap {
  // The seq the fold expected next (accepted + 1).
  expected: number;
  // The seq the next event carried.
  got: number;
}

export type DeliveryEdgeKind = "depends_on" | "stack";

// A directed edge between two units: `from` comes before `to`. A `depends_on`
// edge is a unit's declared dependency; a `stack` edge joins consecutive units of
// one stack, base first, so a view can draw the stack order even where no
// dependency was declared.
export interface DeliveryEdge {
  from: string;
  to: string;
  kind: DeliveryEdgeKind;
}

export interface DeliveryGateView {
  // The gate as the record carries it, with its own `status` word.
  gate: DeliveryGate;
  // The evaluated state over the plan and results (fail-closed to `stale` when
  // either is absent).
  state: GateState;
}

export interface DeliveryProgressCount {
  met: number;
  total: number;
}

// Progress counts test cases met and requirements covered (SB-FR-011), never
// units done.
export interface DeliveryProgress {
  cases: DeliveryProgressCount;
  requirements: DeliveryProgressCount;
}

export interface DeliveryStaleness {
  // The record's `updated_at`, verbatim.
  updatedAt: string;
  // Milliseconds between `updated_at` and the caller's `now`, floored at zero.
  // Null when the caller passed no `now`, or `updated_at` does not parse.
  ageMs: number | null;
}

export interface DeliverySnapshot {
  deliveryId: string;
  // The last accepted seq.
  seq: number;
  gap?: DeliveryGap;
  unitsById: Record<string, DeliveryUnit>;
  // Stack name to its ordered unit ids, base first (from the record).
  stacks: Record<string, string[]>;
  edges: DeliveryEdge[];
  gatesById: Record<string, DeliveryGateView>;
  decisionsById: Record<string, DeliveryDecision>;
  steeringById: Record<string, DeliverySteering>;
  budget: DeliveryBudget;
  roles: Record<string, DeliveryRole>;
  health: DeliveryHealth;
  // The ids of the units whose status reads as jammed (see `classifyUnitStatus`).
  jams: string[];
  drift: DeliveryDrift[];
  lifecycle: DeliveryLifecycle;
  seams: Record<string, DeliverySeam>;
  progress: DeliveryProgress;
  staleness: DeliveryStaleness;
}

// ── Status readings ──

export type UnitStatusKind = "pending" | "running" | "done" | "jammed" | "skipped" | "other";

const UNIT_STATUS_KINDS: Readonly<Record<string, UnitStatusKind>> = {
  pending: "pending",
  planned: "pending",
  queued: "pending",
  ready: "pending",
  running: "running",
  active: "running",
  in_progress: "running",
  dispatched: "running",
  done: "done",
  merged: "done",
  landed: "done",
  complete: "done",
  completed: "done",
  jammed: "jammed",
  blocked: "jammed",
  held: "jammed",
  stuck: "jammed",
  failed: "jammed",
  skipped: "skipped",
};

// Read an open unit status word. A word the table does not know is "other".
export function classifyUnitStatus(status: string): UnitStatusKind {
  return UNIT_STATUS_KINDS[status.toLowerCase()] ?? "other";
}

const CLOSED_DECISION_STATUSES: ReadonlySet<string> = new Set([
  "answered",
  "closed",
  "resolved",
  "declined",
  "dismissed",
  "superseded",
]);

// A decision is open unless its status word says it was settled. An unknown word
// reads as open, so a decision never silently leaves the queue.
export function isDecisionOpen(decision: DeliveryDecision): boolean {
  return !CLOSED_DECISION_STATUSES.has(decision.status.toLowerCase());
}

// ── Event payload views ──
//
// Typed views over the open payload, one per event type the fold applies. Every
// key is optional: the handlers read what is present and ignore the rest.

export interface DeliveryPlannedPayload {
  units?: DeliveryUnit[];
  stacks?: Record<string, string[]>;
  gates?: DeliveryGate[];
  budget?: Partial<DeliveryBudget>;
  roles?: Record<string, DeliveryRole>;
}

export type LifecycleChangedPayload = Partial<DeliveryLifecycle>;

export type UnitChangedPayload = Partial<Omit<DeliveryUnit, "id">>;

export interface GateChangedPayload extends Partial<Omit<DeliveryGate, "id">> {
  gate_id?: string;
}

export interface DecisionRaisedPayload extends Partial<Omit<DeliveryDecision, "id">> {
  decision_id?: string;
  id?: string;
}

export interface DecisionAnsweredPayload {
  decision_id?: string;
  id?: string;
  status?: string;
  answer?: string;
  answered_at?: string;
}

export interface SteeringAddedPayload extends Partial<Omit<DeliverySteering, "id">> {
  steering_id?: string;
  id?: string;
}

export type BudgetChangedPayload = Partial<DeliveryBudget>;

export type HealthChangedPayload = Partial<DeliveryHealth>;

export type DriftDetectedPayload = Partial<DeliveryDrift>;

export interface SeamRanPayload extends Partial<DeliverySeam> {
  seam?: string;
}

// ── The fold state ──
//
// The part of the snapshot the events move. Everything else (edges, jams, gate
// evaluation, progress, staleness) is derived from it after the walk, so the
// memoised reducer remembers only this and derives the rest per call.

interface FoldState {
  seq: number;
  gap?: DeliveryGap;
  unitsById: Record<string, DeliveryUnit>;
  stacks: Record<string, string[]>;
  gates: DeliveryGate[];
  decisionsById: Record<string, DeliveryDecision>;
  steeringById: Record<string, DeliverySteering>;
  budget: DeliveryBudget;
  roles: Record<string, DeliveryRole>;
  health: DeliveryHealth;
  drift: DeliveryDrift[];
  lifecycle: DeliveryLifecycle;
  seams: Record<string, DeliverySeam>;
}

type EventHandler = (state: FoldState, event: DeliveryEvent) => FoldState;

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexById<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) {
    out[item.id] = item;
  }
  return out;
}

// Copy the defined keys of `patch` over `base`, dropping `undefined` so a sparse
// payload never erases a field.
function merge<T extends object>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

function looksLikeUnit(value: unknown): value is DeliveryUnit {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.status) &&
    isString(value.stack) &&
    isNumber(value.layer) &&
    isStringArray(value.depends_on)
  );
}

function looksLikeGate(value: unknown): value is DeliveryGate {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.status) &&
    isStringArray(value.after) &&
    isStringArray(value.cases)
  );
}

const onDeliveryPlanned: EventHandler = (state, event) => {
  const payload = event.payload as DeliveryPlannedPayload;
  let next = state;
  if (Array.isArray(payload.units) && payload.units.every(looksLikeUnit)) {
    next = { ...next, unitsById: indexById(payload.units) };
  }
  if (isRecord(payload.stacks) && Object.values(payload.stacks).every(isStringArray)) {
    next = { ...next, stacks: { ...(payload.stacks as Record<string, string[]>) } };
  }
  if (Array.isArray(payload.gates) && payload.gates.every(looksLikeGate)) {
    next = { ...next, gates: [...payload.gates] };
  }
  if (isRecord(payload.budget)) {
    next = { ...next, budget: merge(next.budget, pickBudget(payload.budget)) };
  }
  if (isRecord(payload.roles)) {
    const roles: Record<string, DeliveryRole> = { ...next.roles };
    for (const [name, role] of Object.entries(payload.roles)) {
      if (isRecord(role) && isString(role.tier)) {
        roles[name] = role as DeliveryRole;
      }
    }
    next = { ...next, roles };
  }
  return next;
};

const onLifecycleChanged: EventHandler = (state, event) => {
  const payload = event.payload as LifecycleChangedPayload;
  const patch: Partial<DeliveryLifecycle> = {};
  if (isString(payload.state)) patch.state = payload.state;
  if (typeof payload.armed === "boolean") patch.armed = payload.armed;
  if (isString(payload.started_at)) patch.started_at = payload.started_at;
  if (isString(payload.ended_at) || payload.ended_at === null) patch.ended_at = payload.ended_at;
  if (Object.keys(patch).length === 0) return state;
  return { ...state, lifecycle: merge(state.lifecycle, patch) };
};

const onUnitChanged: EventHandler = (state, event) => {
  const unitId = event.unit_id;
  if (!isString(unitId)) return state;
  const current = state.unitsById[unitId];
  if (current === undefined) return state;
  const payload = event.payload as UnitChangedPayload;
  const patch: Partial<DeliveryUnit> = {};
  if (isString(payload.status)) patch.status = payload.status;
  if (typeof payload.title === "string") patch.title = payload.title;
  if (isString(payload.stack)) patch.stack = payload.stack;
  if (isNumber(payload.layer)) patch.layer = payload.layer;
  if (isStringArray(payload.depends_on)) patch.depends_on = payload.depends_on;
  if (typeof payload.branch === "string") patch.branch = payload.branch;
  if (typeof payload.head === "string") patch.head = payload.head;
  if (isNumber(payload.cost_usd)) patch.cost_usd = payload.cost_usd;
  if (Object.keys(patch).length === 0) return state;
  return { ...state, unitsById: { ...state.unitsById, [unitId]: merge(current, patch) } };
};

const onGateChanged: EventHandler = (state, event) => {
  const payload = event.payload as GateChangedPayload;
  if (!isString(payload.gate_id)) return state;
  const index = state.gates.findIndex((gate) => gate.id === payload.gate_id);
  if (index < 0) return state;
  const patch: Partial<DeliveryGate> = {};
  if (isString(payload.status)) patch.status = payload.status;
  if (isStringArray(payload.cases)) patch.cases = payload.cases;
  if (isStringArray(payload.after) && payload.after.length > 0) patch.after = payload.after;
  if (Object.keys(patch).length === 0) return state;
  const gates = [...state.gates];
  gates[index] = merge(state.gates[index], patch);
  return { ...state, gates };
};

const onDecisionRaised: EventHandler = (state, event) => {
  const payload = event.payload as DecisionRaisedPayload;
  const id = isString(payload.decision_id) ? payload.decision_id : payload.id;
  if (
    !isString(id) ||
    !isString(payload.question) ||
    !isStringArray(payload.options) ||
    payload.options.length < 2 ||
    !isString(payload.default) ||
    !payload.options.includes(payload.default)
  ) {
    return state;
  }
  const unitId = isString(payload.unit_id) ? payload.unit_id : event.unit_id;
  const decision: DeliveryDecision = {
    id,
    question: payload.question,
    options: [...payload.options],
    default: payload.default,
    status: isString(payload.status) ? payload.status : "open",
    raised_at: isString(payload.raised_at) ? payload.raised_at : event.ts,
    ...(isString(unitId) ? { unit_id: unitId } : {}),
  };
  return { ...state, decisionsById: { ...state.decisionsById, [id]: decision } };
};

const onDecisionAnswered: EventHandler = (state, event) => {
  const payload = event.payload as DecisionAnsweredPayload;
  const id = isString(payload.decision_id) ? payload.decision_id : payload.id;
  if (!isString(id)) return state;
  const current = state.decisionsById[id];
  if (current === undefined) return state;
  const patch: Record<string, unknown> = {
    status: isString(payload.status) ? payload.status : "answered",
  };
  if (isString(payload.answer)) patch.answer = payload.answer;
  patch.answered_at = isString(payload.answered_at) ? payload.answered_at : event.ts;
  const decision = merge(current, patch as Partial<DeliveryDecision>);
  return { ...state, decisionsById: { ...state.decisionsById, [id]: decision } };
};

const onSteeringAdded: EventHandler = (state, event) => {
  const payload = event.payload as SteeringAddedPayload;
  const id = isString(payload.steering_id) ? payload.steering_id : payload.id;
  if (!isString(id) || !isString(payload.note)) return state;
  const steering: DeliverySteering = {
    id,
    note: payload.note,
    unit_ids: isStringArray(payload.unit_ids) ? [...payload.unit_ids] : [],
    created_at: isString(payload.created_at) ? payload.created_at : event.ts,
  };
  return { ...state, steeringById: { ...state.steeringById, [id]: steering } };
};

function pickBudget(payload: Record<string, unknown>): Partial<DeliveryBudget> {
  const patch: Partial<DeliveryBudget> = {};
  if (isNumber(payload.estimate_usd)) patch.estimate_usd = payload.estimate_usd;
  if (isNumber(payload.soft_budget_usd)) patch.soft_budget_usd = payload.soft_budget_usd;
  if (isNumber(payload.spent_usd)) patch.spent_usd = payload.spent_usd;
  return patch;
}

const onBudgetChanged: EventHandler = (state, event) => {
  const patch = pickBudget(event.payload);
  if (Object.keys(patch).length === 0) return state;
  return { ...state, budget: merge(state.budget, patch) };
};

const onHealthChanged: EventHandler = (state, event) => {
  const payload = event.payload as HealthChangedPayload;
  if (!isString(payload.status)) return state;
  const health: DeliveryHealth = {
    ...state.health,
    status: payload.status,
    checked_at: isString(payload.checked_at) ? payload.checked_at : event.ts,
  };
  if (typeof payload.detail === "string") {
    health.detail = payload.detail;
  } else {
    delete health.detail;
  }
  return { ...state, health };
};

const onDriftDetected: EventHandler = (state, event) => {
  const payload = event.payload as DriftDetectedPayload;
  if (!isString(payload.kind) || !isString(payload.detail)) return state;
  const unitId = isString(payload.unit_id) ? payload.unit_id : event.unit_id;
  const drift: DeliveryDrift = {
    kind: payload.kind,
    detail: payload.detail,
    detected_at: isString(payload.detected_at) ? payload.detected_at : event.ts,
    ...(isString(unitId) ? { unit_id: unitId } : {}),
  };
  return { ...state, drift: [...state.drift, drift] };
};

const onSeamRan: EventHandler = (state, event) => {
  const payload = event.payload as SeamRanPayload;
  if (!isString(payload.seam) || !isString(payload.status)) return state;
  const seam: DeliverySeam = {
    ...(state.seams[payload.seam] ?? {}),
    status: payload.status,
    last_run_at: isString(payload.last_run_at) ? payload.last_run_at : event.ts,
  };
  if (typeof payload.detail === "string") {
    seam.detail = payload.detail;
  } else {
    delete seam.detail;
  }
  return { ...state, seams: { ...state.seams, [payload.seam]: seam } };
};

// The handler table. Adding an event type is adding a row; a type with no row is
// skipped (its seq is still accepted).
export const EVENT_HANDLERS: Readonly<Record<string, EventHandler>> = {
  "delivery.planned": onDeliveryPlanned,
  "lifecycle.changed": onLifecycleChanged,
  "unit.changed": onUnitChanged,
  "gate.changed": onGateChanged,
  "decision.raised": onDecisionRaised,
  "decision.answered": onDecisionAnswered,
  "steering.added": onSteeringAdded,
  "budget.changed": onBudgetChanged,
  "health.changed": onHealthChanged,
  "drift.detected": onDriftDetected,
  "seam.ran": onSeamRan,
};

export const DELIVERY_EVENT_TYPES: readonly string[] = Object.keys(EVENT_HANDLERS);

// ── The fold ──

function stateFromRecord(record: DeliveryRecord): FoldState {
  return {
    seq: record.last_event_seq,
    unitsById: indexById(record.units),
    stacks: { ...record.stack.stacks },
    gates: [...record.stack.gates],
    decisionsById: indexById(record.decisions),
    steeringById: indexById(record.steering),
    budget: record.budget,
    roles: record.roles,
    health: record.health,
    drift: record.drift,
    lifecycle: record.lifecycle,
    seams: record.seams,
  };
}

// Apply `events` on top of `state`, in list order. Returns a new state; the
// input state is never changed. Returns `state` itself when nothing applied.
function applyEvents(state: FoldState, events: readonly DeliveryEvent[]): FoldState {
  let next = state;
  for (const event of events) {
    if (event.seq <= next.seq) {
      continue;
    }
    if (event.seq !== next.seq + 1) {
      return { ...next, gap: { expected: next.seq + 1, got: event.seq } };
    }
    const handler: EventHandler | undefined = EVENT_HANDLERS[event.type];
    // Copy before stamping the seq: `next` may still be the caller's (or the
    // memo's) state when the handler changed nothing.
    next = { ...(handler ? handler(next, event) : next), seq: event.seq };
  }
  return next;
}

function buildEdges(unitsById: Record<string, DeliveryUnit>, stacks: Record<string, string[]>) {
  const edges: DeliveryEdge[] = [];
  for (const unit of Object.values(unitsById)) {
    for (const dependency of unit.depends_on) {
      edges.push({ from: dependency, to: unit.id, kind: "depends_on" });
    }
  }
  for (const members of Object.values(stacks)) {
    for (let index = 1; index < members.length; index += 1) {
      edges.push({ from: members[index - 1], to: members[index], kind: "stack" });
    }
  }
  return edges;
}

function verifyUnitOf(gate: DeliveryGate): VerifyUnit {
  return {
    id: gate.id,
    title: gate.id,
    type: "task",
    kind: "verify",
    description: "",
    acceptance_criteria: [],
    depends_on: [...gate.after],
    covers: [...gate.after],
    implements: {
      requirement_ids: [],
      user_story_ids: [],
      test_case_ids: [...gate.cases],
    },
  };
}

// Progress (SB-FR-011). Totals come from the plan when present. A case counts as
// met when the results are current (their planHash matches the record's) and
// its effective status is `passed`, the same reading `evaluateGate` applies: an
// override wins over the derived status, and an orphaned or absent result is not
// met. A case the lifecycle resolutions retire leaves both totals. A requirement
// is covered when every counted case that links it is met.
function computeProgress(
  record: DeliveryRecord,
  plan: TestCasesPlan | undefined,
  results: DeliveryResults | undefined,
  lifecycle: GateLifecycle | undefined,
): DeliveryProgress {
  if (plan === undefined) {
    return { cases: { met: 0, total: 0 }, requirements: { met: 0, total: 0 } };
  }
  const retired = new Set<string>();
  for (const resolution of lifecycle?.resolutions ?? []) {
    if (resolution.status === "retired") retired.add(resolution.origin.caseId);
  }
  const current =
    results !== undefined && results.planHash === record.plan_hash ? results : undefined;
  const requirementCases = new Map<string, { total: number; met: number }>();
  let total = 0;
  let met = 0;
  for (const planCase of plan.cases) {
    if (retired.has(planCase.id)) continue;
    total += 1;
    const result = current?.caseResults[planCase.id];
    const caseMet =
      result !== undefined && result.orphaned !== true && effectiveCaseStatus(result) === "passed";
    if (caseMet) met += 1;
    for (const requirementId of planCase.linked_requirement_ids) {
      const entry = requirementCases.get(requirementId) ?? { total: 0, met: 0 };
      entry.total += 1;
      if (caseMet) entry.met += 1;
      requirementCases.set(requirementId, entry);
    }
  }
  let covered = 0;
  for (const entry of requirementCases.values()) {
    if (entry.met === entry.total) covered += 1;
  }
  return {
    cases: { met, total },
    requirements: { met: covered, total: requirementCases.size },
  };
}

export function computeStaleness(updatedAt: string, now: number | undefined): DeliveryStaleness {
  if (now === undefined) {
    return { updatedAt, ageMs: null };
  }
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(updated)) {
    return { updatedAt, ageMs: null };
  }
  return { updatedAt, ageMs: Math.max(0, now - updated) };
}

function deriveSnapshot(state: FoldState, inputs: DeliveryFoldInputs): DeliverySnapshot {
  const { record, plan, results, lifecycle, now } = inputs;
  const gatesById: Record<string, DeliveryGateView> = {};
  for (const gate of state.gates) {
    gatesById[gate.id] = {
      gate,
      state: evaluateGate(verifyUnitOf(gate), results ?? null, record.plan_hash, plan, lifecycle),
    };
  }
  const jams = Object.values(state.unitsById)
    .filter((unit) => classifyUnitStatus(unit.status) === "jammed")
    .map((unit) => unit.id);
  const snapshot: DeliverySnapshot = {
    deliveryId: record.delivery_id,
    seq: state.seq,
    unitsById: state.unitsById,
    stacks: state.stacks,
    edges: buildEdges(state.unitsById, state.stacks),
    gatesById,
    decisionsById: state.decisionsById,
    steeringById: state.steeringById,
    budget: state.budget,
    roles: state.roles,
    health: state.health,
    jams,
    drift: state.drift,
    lifecycle: state.lifecycle,
    seams: state.seams,
    progress: computeProgress(record, plan, results, lifecycle),
    staleness: computeStaleness(record.updated_at, now),
  };
  if (state.gap !== undefined) {
    snapshot.gap = state.gap;
  }
  return snapshot;
}

// Fold a record and its events into a snapshot. Pure: see the module header.
export function foldDelivery(inputs: DeliveryFoldInputs): DeliverySnapshot {
  const state = applyEvents(stateFromRecord(inputs.record), inputs.events);
  return deriveSnapshot(state, inputs);
}

// ── The memoised reducer ──
//
// `createDeliveryReducer()` returns a `fold` whose result always deep-equals
// `foldDelivery(inputs)`, and that costs one step per new event when the caller
// keeps extending the same stream: it remembers, per delivery id, the record it
// folded, a shallow copy of the event list it consumed and the resulting state.
//
// A new call reuses the remembered state when the record is the same (the same
// object, or the same `delivery_id`, `last_event_seq` and `updated_at`) and the
// new list starts with the remembered events, compared one by one on seq and
// content. The list's identity plays no part: a caller that pushes onto the array
// it passed before, and one that rebuilds the array from a fresh fetch, both get
// the one-step fold, and a list whose prefix changed is folded from the record
// again. A fold that ended in a gap is not remembered, so the refetch that
// follows always starts clean.

interface MemoEntry {
  record: DeliveryRecord;
  // A shallow copy of the consumed events: a later push onto the caller's array
  // cannot change what was folded.
  events: DeliveryEvent[];
  state: FoldState;
}

export interface DeliveryReducer {
  fold(inputs: DeliveryFoldInputs): DeliverySnapshot;
  // Drop what is remembered for one delivery, or for every delivery.
  forget(deliveryId?: string): void;
}

function sameRecord(a: DeliveryRecord, b: DeliveryRecord): boolean {
  return (
    a === b ||
    (a.delivery_id === b.delivery_id &&
      a.last_event_seq === b.last_event_seq &&
      a.updated_at === b.updated_at)
  );
}

// Structural equality over JSON-shaped values (the event payload is one).
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !deepEqual(left[key], right[key])) return false;
  }
  return true;
}

function sameEvent(a: DeliveryEvent, b: DeliveryEvent): boolean {
  return a === b || (a.seq === b.seq && a.type === b.type && deepEqual(a, b));
}

function isPrefix(folded: readonly DeliveryEvent[], list: readonly DeliveryEvent[]): boolean {
  if (folded.length > list.length) return false;
  for (let index = 0; index < folded.length; index += 1) {
    if (!sameEvent(folded[index], list[index])) return false;
  }
  return true;
}

export function createDeliveryReducer(): DeliveryReducer {
  const memo = new Map<string, MemoEntry>();
  return {
    fold(inputs) {
      const { record, events } = inputs;
      const entry = memo.get(record.delivery_id);
      const resumable =
        entry !== undefined && sameRecord(entry.record, record) && isPrefix(entry.events, events)
          ? entry
          : undefined;
      const state =
        resumable !== undefined
          ? applyEvents(resumable.state, events.slice(resumable.events.length))
          : applyEvents(stateFromRecord(record), events);
      if (state.gap === undefined) {
        memo.set(record.delivery_id, { record, events: events.slice(), state });
      } else {
        memo.delete(record.delivery_id);
      }
      return deriveSnapshot(state, inputs);
    },
    forget(deliveryId) {
      if (deliveryId === undefined) {
        memo.clear();
      } else {
        memo.delete(deliveryId);
      }
    },
  };
}
