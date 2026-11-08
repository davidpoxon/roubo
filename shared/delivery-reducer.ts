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
//
// Open keys. Every table this module indexes by a string a producer wrote (an
// event type, a status word, a unit, gate, decision, steering or seam id, a role
// or stack name) is a plain object, and a plain object inherits
// `Object.prototype`: `table["toString"]` is a function, not undefined, and
// `table["__proto__"] = x` changes the prototype rather than adding a key. So
// every such read goes through `ownValue` and every such write through
// `setOwnValue`, which see own keys only. An event typed `toString` is then an
// unknown type like any other, and a unit whose id is `constructor` is a unit.

import {
  AGENT_AUTHOR,
  DECISION_REVIEW_STATUSES,
  DELIVERY_MODES,
  GATE_PROVISIONAL_STATUS,
  PROVISIONAL_MARKS,
  type DecisionReview,
  type DeliveryBudget,
  type DeliveryDecision,
  type DeliveryDrift,
  type DeliveryEvent,
  type DeliveryGate,
  type DeliveryHealth,
  type DeliveryLifecycle,
  type DeliveryMode,
  type DeliveryModeValue,
  type DeliveryRecord,
  type DeliveryReview,
  type DeliveryRole,
  type DeliverySeam,
  type DeliverySteering,
  type DeliveryUnit,
  type ProvisionalCase,
  type ProvisionalMark,
} from "./delivery-observation-contract";
import type { BenchResults, CaseResult, TestCasesPlan } from "./testbench-contracts";
import {
  evaluateGate,
  indexResolutions,
  isCaseMet,
  readCaseResult,
  type GateLifecycle,
  type GateState,
  type VerifyUnit,
} from "./gate-evaluator";

// ── Inputs ──

// The recorded results the fold reads for gate state and progress, as the gate
// evaluator takes them: the `caseResults` body plus the file's own `planHash`.
export type DeliveryResults = BenchResults & { planHash: string };

export interface DeliveryFoldInputs {
  record: DeliveryRecord;
  // The event stream after the record, in seq order. Events at or below
  // `record.last_event_seq` are ignored, so a caller may pass the whole stream.
  events: readonly DeliveryEvent[];
  // The spec's test plan. Absent, every gate fails closed to `stale` (even when
  // results are present: without the plan the gating set cannot be narrowed, so
  // the results are not read) and progress reports nothing met and no totals.
  plan?: TestCasesPlan;
  // The spec's recorded results. Absent, every gate is `stale` and nothing is
  // met; the totals still come from the gates' gating sets over the plan.
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
  // The gate as the record carries it, with its own `status` word and, in auto
  // mode, its provisional marks.
  gate: DeliveryGate;
  // The evaluated state over the plan and results. Fail-closed to `stale` when
  // either is absent: the fold passes `evaluateGate` null results until it has
  // both.
  state: GateState;
  // When the gate became provisional: the `ts` of the `gate.provisional` event,
  // or the record's `updated_at` for a gate the record already carried as
  // provisional. Null for a gate that is not provisional. The review stack
  // orders its cards by it.
  provisionalAt: string | null;
}

// One message of a decision's thread, from a `review.reply` event: the
// session's reply, or the tooling's read-back of an operator's thread message
// (then `controlSeq` names the control). The thread is not in the record: a
// thread message is volatile, so the fold builds it from the stream alone.
export interface DeliveryThreadMessage {
  seq: number;
  decisionId: string;
  text: string;
  // The author as the payload names it, or `agent` when it names none.
  author: string;
  ts: string;
  inReplyTo?: string;
  controlSeq?: number;
}

export interface DeliveryProgressCount {
  met: number;
  total: number;
}

// One counted case of the progress (SB-FR-011): whether it is met, the verify
// record it is judged by, and the unit that met it with that unit's pull
// request, so a view can open the record and link the pull request.
export interface DeliveryCaseProgress {
  id: string;
  met: boolean;
  // The result the case is read by, exactly as the met reading takes it (see
  // `computeProgress`). Null when the results are absent or not current, or no
  // result is recorded for the case.
  result: CaseResult | null;
  // The unit that met the case: the last unit in the `after` list of the first
  // gate (in record order) whose `cases` names it. Null when the case is not
  // met, or no gate names it.
  metBy: string | null;
  // The `pr_url` of the `metBy` unit, or null when that unit has none.
  prUrl: string | null;
}

// Progress counts test cases met and requirements covered (SB-FR-011), never
// units done. The counted cases are the gating cases of the record's gates, and a
// requirement is covered when every plan case that links it is met, gating or not
// (see `computeProgress`). `caseList` holds one entry per counted case, in plan order.
export interface DeliveryProgress {
  cases: DeliveryProgressCount;
  requirements: DeliveryProgressCount;
  caseList: DeliveryCaseProgress[];
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
  mode: DeliveryMode;
  review: DeliveryReview;
  unitsById: Record<string, DeliveryUnit>;
  // Stack name to its ordered unit ids, base first (from the record).
  stacks: Record<string, string[]>;
  edges: DeliveryEdge[];
  gatesById: Record<string, DeliveryGateView>;
  decisionsById: Record<string, DeliveryDecision>;
  // Decision id to its thread, in stream order.
  threadsByDecisionId: Record<string, DeliveryThreadMessage[]>;
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

// ── Open-key tables ──

// Read a key of a table keyed by an open string, own keys only: a key that names
// an `Object.prototype` member (`toString`, `constructor`, `__proto__`, ...)
// reads as absent, not as the inherited function.
export function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// Write a key of a table keyed by an open string as an own, enumerable property,
// so a key of `__proto__` adds an entry instead of changing the prototype.
export function setOwnValue<T>(table: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(table, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// Read an open unit status word. A word the table does not know is "other".
export function classifyUnitStatus(status: string): UnitStatusKind {
  return ownValue(UNIT_STATUS_KINDS, status.toLowerCase()) ?? "other";
}

const CLOSED_DECISION_STATUSES: ReadonlySet<string> = new Set([
  "answered",
  "decided",
  "accepted",
  "overturned",
  "closed",
  "resolved",
  "declined",
  "dismissed",
  "superseded",
]);

// A decision is open unless its status word says it was settled. An unknown word
// reads as open, so a decision never silently leaves the queue. A decision the
// session decided on its own (`decided`) is settled: it waits on the review
// stack, not in the open queue (see `isUnreviewedAgentDecision`).
export function isDecisionOpen(decision: DeliveryDecision): boolean {
  return !CLOSED_DECISION_STATUSES.has(decision.status.toLowerCase());
}

// A decision the session decided on its own that the operator has not reviewed:
// its author is `agent`, it carries a chosen option, and its review is absent or
// still `unreviewed`.
export function isUnreviewedAgentDecision(decision: DeliveryDecision): boolean {
  return (
    decision.author === AGENT_AUTHOR &&
    decision.chosen !== undefined &&
    (decision.review?.status ?? "unreviewed") === "unreviewed"
  );
}

// A gate is provisional when its status word is `provisional`: the session
// judged it while the operator was away (SB-FR-040). The status is the one key;
// `provisionalCases` carries the marks but does not make a gate provisional.
export function isProvisionalGate(gate: DeliveryGate): boolean {
  return gate.status === GATE_PROVISIONAL_STATUS;
}

// A provisional gate the operator has not confirmed in full: its status is
// `provisional` and at least one of its marks is unconfirmed (a provisional gate
// with no marks listed counts as unconfirmed).
export function isUnconfirmedProvisionalGate(gate: DeliveryGate): boolean {
  if (!isProvisionalGate(gate)) return false;
  const cases = gate.provisionalCases ?? [];
  return cases.length === 0 || cases.some((entry) => !entry.confirmed);
}

const MODE_VALUES: ReadonlySet<string> = new Set(DELIVERY_MODES);
const PROVISIONAL_MARK_VALUES: ReadonlySet<string> = new Set(PROVISIONAL_MARKS);
const DECISION_REVIEW_STATUS_VALUES: ReadonlySet<string> = new Set(DECISION_REVIEW_STATUSES);

function isModeValue(value: unknown): value is DeliveryModeValue {
  return typeof value === "string" && MODE_VALUES.has(value);
}

function isProvisionalMark(value: unknown): value is ProvisionalMark {
  return typeof value === "string" && PROVISIONAL_MARK_VALUES.has(value);
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

// The decision-mode payloads (SB-FR-040). The contract types them (see the
// `*PayloadSchema` exports of delivery-observation-contract.ts) and the
// validator checks them before the fold sees them; the handlers still read
// each key defensively, as every other handler does.

export interface ReadBackPayload {
  control_seq?: number;
  in_reply_to?: string;
}

export interface ModeChangedPayload extends ReadBackPayload {
  value?: string;
  pending?: string | null;
}

export interface DecisionDecidedPayload extends ReadBackPayload {
  decision_id?: string;
  id?: string;
  chosen?: string;
  author?: string;
  rationale?: string;
  affected_units?: string[];
  status?: string;
  decided_at?: string;
  question?: string;
  options?: string[];
  default?: string;
}

export interface ReviewOpenedPayload extends ReadBackPayload {
  trigger?: string;
  unreviewed?: string[];
}

export interface ReviewOutcomePayload extends ReadBackPayload {
  decision_id?: string;
  id?: string;
  status?: string;
  reviewer?: string;
  summary?: string;
  chosen?: string;
}

export interface ReviewReplyPayload extends ReadBackPayload {
  decision_id?: string;
  id?: string;
  text?: string;
  author?: string;
}

export interface GateProvisionalPayload extends ReadBackPayload {
  gate_id?: string;
  cases?: Array<Partial<ProvisionalCase>>;
}

export interface GateConfirmedPayload extends ReadBackPayload {
  gate_id?: string;
  cases?: string[];
  status?: string;
}

// ── The fold state ──
//
// The part of the snapshot the events move. Everything else (edges, jams, gate
// evaluation, progress, staleness) is derived from it after the walk, so the
// memoised reducer remembers only this and derives the rest per call.

interface FoldState {
  seq: number;
  gap?: DeliveryGap;
  mode: DeliveryMode;
  review: DeliveryReview;
  unitsById: Record<string, DeliveryUnit>;
  stacks: Record<string, string[]>;
  gates: DeliveryGate[];
  // Gate id to the time it became provisional (see DeliveryGateView). Holds an
  // entry for a gate while its status is `provisional` and no longer: every
  // handler that moves a gate's status passes through `trackProvisionalAt`.
  provisionalAt: Record<string, string>;
  decisionsById: Record<string, DeliveryDecision>;
  threadsByDecisionId: Record<string, DeliveryThreadMessage[]>;
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
    setOwnValue(out, item.id, item);
  }
  return out;
}

// Copy the defined keys of `patch` over `base`, dropping `undefined` so a sparse
// payload never erases a field.
function merge<T extends object>(base: T, patch: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>;
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

// The `provisionalAt` table after one gate moved from `before` to `after` at
// `ts`: a gate that became provisional is dated `ts`, a gate that left the
// provisional status loses its entry, and any other move keeps the table. A
// `gate.provisional` event re-dates a gate that already was provisional, so it
// passes `before` as undefined. Returns the same table when nothing changed.
function trackProvisionalAt(
  provisionalAt: Record<string, string>,
  before: DeliveryGate | undefined,
  after: DeliveryGate,
  ts: string,
): Record<string, string> {
  const wasProvisional = before !== undefined && isProvisionalGate(before);
  if (isProvisionalGate(after)) {
    if (wasProvisional) return provisionalAt;
    const next = { ...provisionalAt };
    setOwnValue(next, after.id, ts);
    return next;
  }
  if (!Object.hasOwn(provisionalAt, after.id)) return provisionalAt;
  return Object.fromEntries(Object.entries(provisionalAt).filter(([id]) => id !== after.id));
}

// The `provisionalAt` table for a gate list that replaced the current one: a
// gate that stays provisional keeps its time, a gate that is provisional now and
// was not (or did not exist) is dated `ts`, and every other entry is dropped.
function provisionalAtForGates(
  provisionalAt: Record<string, string>,
  before: readonly DeliveryGate[],
  after: readonly DeliveryGate[],
  ts: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const gate of after) {
    if (!isProvisionalGate(gate)) continue;
    const previous = before.find((entry) => entry.id === gate.id);
    const kept = previous !== undefined && isProvisionalGate(previous);
    setOwnValue(next, gate.id, (kept ? ownValue(provisionalAt, gate.id) : undefined) ?? ts);
  }
  return next;
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
    const gates = [...payload.gates];
    next = {
      ...next,
      gates,
      provisionalAt: provisionalAtForGates(next.provisionalAt, next.gates, gates, event.ts),
    };
    // The new list can add or drop an unconfirmed provisional gate, which
    // moves what the review waits on.
    next.review = settleReview(next, next.review);
  }
  if (isRecord(payload.budget)) {
    next = { ...next, budget: merge(next.budget, pickBudget(payload.budget)) };
  }
  if (isRecord(payload.roles)) {
    const roles: Record<string, DeliveryRole> = { ...next.roles };
    for (const [name, role] of Object.entries(payload.roles)) {
      if (isRecord(role) && isString(role.tier)) {
        setOwnValue(roles, name, role as DeliveryRole);
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
  const current = ownValue(state.unitsById, unitId);
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
  if (typeof payload.pr_url === "string") patch.pr_url = payload.pr_url;
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
  const before = state.gates[index];
  const gates = [...state.gates];
  gates[index] = merge(before, patch);
  const next = {
    ...state,
    gates,
    provisionalAt: trackProvisionalAt(state.provisionalAt, before, gates[index], event.ts),
  };
  // A status word alone can move a gate into or out of the provisional state.
  next.review = settleReview(next, state.review);
  return next;
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
  const next = { ...state, decisionsById: { ...state.decisionsById, [id]: decision } };
  // A raise replaces the decision whole, so an agent's earlier choice and its
  // review state go with it: bring the list into line with the decisions, so
  // the list, the status and the review stack agree.
  next.review = settleReview(next, {
    ...state.review,
    unreviewed: reconcileUnreviewed(next, state.review.unreviewed),
  });
  return next;
};

// A `decision.answered` merges its patch over the decision and keeps its
// author, choice and review state, so an unreviewed agent decision stays one
// and the review section needs no change.
const onDecisionAnswered: EventHandler = (state, event) => {
  const payload = event.payload as DecisionAnsweredPayload;
  const id = isString(payload.decision_id) ? payload.decision_id : payload.id;
  if (!isString(id)) return state;
  const current = ownValue(state.decisionsById, id);
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
    ...(ownValue(state.seams, payload.seam) ?? {}),
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

// ── Decision-mode handlers (SB-FR-040) ──

const onModeChanged: EventHandler = (state, event) => {
  const payload = event.payload as ModeChangedPayload;
  if (!isModeValue(payload.value)) return state;
  const mode: DeliveryMode = { ...state.mode, value: payload.value };
  if (isModeValue(payload.pending)) {
    mode.pending = payload.pending;
  } else if (payload.pending === null || payload.pending === undefined) {
    // The switch landed: nothing is pending any more unless the payload says so.
    mode.pending = null;
  }
  return { ...state, mode };
};

// The review section after a decision joined or left the unreviewed list, or
// a gate became provisional or confirmed. `none` when nothing waits, else
// `pending` until a `review.opened` sets `open`; an open review stays open
// while anything waits.
function settleReview(state: FoldState, review: DeliveryReview): DeliveryReview {
  const anyGate = state.gates.some(isUnconfirmedProvisionalGate);
  const waiting = review.unreviewed.length > 0 || anyGate;
  if (!waiting) return { ...review, status: "none" };
  if (review.status === "none") return { ...review, status: "pending" };
  return review;
}

const onDecisionDecided: EventHandler = (state, event) => {
  const payload = event.payload as DecisionDecidedPayload;
  const id = isString(payload.decision_id) ? payload.decision_id : payload.id;
  if (!isString(id) || !isString(payload.chosen)) return state;
  let current = ownValue(state.decisionsById, id);
  if (current === undefined) {
    // A decision the stream never raised comes whole, or not at all.
    if (
      !isString(payload.question) ||
      !isStringArray(payload.options) ||
      payload.options.length < 2 ||
      !isString(payload.default) ||
      !payload.options.includes(payload.default)
    ) {
      return state;
    }
    const unitId = event.unit_id;
    current = {
      id,
      question: payload.question,
      options: [...payload.options],
      default: payload.default,
      status: "open",
      raised_at: event.ts,
      ...(isString(unitId) ? { unit_id: unitId } : {}),
    };
  }
  if (!current.options.includes(payload.chosen)) return state;
  const author = isString(payload.author) ? payload.author : AGENT_AUTHOR;
  const patch: Record<string, unknown> = {
    status: isString(payload.status) ? payload.status : "decided",
    author,
    chosen: payload.chosen,
    decided_at: isString(payload.decided_at) ? payload.decided_at : event.ts,
  };
  if (typeof payload.rationale === "string") patch.rationale = payload.rationale;
  if (isStringArray(payload.affected_units)) patch.affected_units = [...payload.affected_units];
  if (author === AGENT_AUTHOR) {
    patch.review = { status: "unreviewed" } satisfies DecisionReview;
  }
  const decision = merge(current, patch as Partial<DeliveryDecision>);
  if (author !== AGENT_AUTHOR) {
    // A named author's choice supersedes an earlier agent choice whole: the
    // agent's review state and rationale no longer describe this decision, so
    // the decision leaves the review stack and the unreviewed list together.
    delete decision.review;
    if (typeof payload.rationale !== "string") delete decision.rationale;
  }
  const next = { ...state, decisionsById: { ...state.decisionsById } };
  setOwnValue(next.decisionsById, id, decision);
  const listed = state.review.unreviewed.includes(id);
  if (author === AGENT_AUTHOR && !listed) {
    next.review = settleReview(next, {
      ...state.review,
      unreviewed: [...state.review.unreviewed, id],
    });
  } else if (author !== AGENT_AUTHOR && listed) {
    next.review = settleReview(next, {
      ...state.review,
      unreviewed: state.review.unreviewed.filter((entry) => entry !== id),
    });
  }
  return next;
};

// The unreviewed list the review section carries, brought into line with the
// decisions: the ids of `listed` that name an unreviewed agent decision, in the
// order given, then every other unreviewed agent decision in snapshot order. An
// id that names no such decision is dropped, so the list and the review stack
// (see `selectReviewStack`) always name the same decisions.
function reconcileUnreviewed(state: FoldState, listed: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of listed) {
    const decision = ownValue(state.decisionsById, id);
    if (decision !== undefined && isUnreviewedAgentDecision(decision) && !out.includes(id)) {
      out.push(id);
    }
  }
  for (const decision of Object.values(state.decisionsById)) {
    if (isUnreviewedAgentDecision(decision) && !out.includes(decision.id)) {
      out.push(decision.id);
    }
  }
  return out;
}

const onReviewOpened: EventHandler = (state, event) => {
  const payload = event.payload as ReviewOpenedPayload;
  const review: DeliveryReview = { ...state.review, status: "open" };
  if (isString(payload.trigger)) review.trigger = payload.trigger;
  const listed = isStringArray(payload.unreviewed) ? payload.unreviewed : state.review.unreviewed;
  review.unreviewed = reconcileUnreviewed(state, listed);
  // An opened review with nothing to review settles at once.
  return { ...state, review: settleReview(state, review) };
};

const onReviewOutcome: EventHandler = (state, event) => {
  const payload = event.payload as ReviewOutcomePayload;
  const id = isString(payload.decision_id) ? payload.decision_id : payload.id;
  if (!isString(id)) return state;
  const current = ownValue(state.decisionsById, id);
  if (current === undefined) return state;
  const status = payload.status;
  if (!isString(status) || !DECISION_REVIEW_STATUS_VALUES.has(status) || status === "unreviewed") {
    return state;
  }
  const review: DecisionReview = { status: status as DecisionReview["status"] };
  if (isString(payload.reviewer)) review.reviewer = payload.reviewer;
  if (typeof payload.summary === "string") review.summary = payload.summary;
  const patch: Record<string, unknown> = { review };
  if (
    status === "overturned" &&
    isString(payload.chosen) &&
    current.options.includes(payload.chosen)
  ) {
    patch.chosen = payload.chosen;
  }
  const decision = merge(current, patch as Partial<DeliveryDecision>);
  const next = { ...state, decisionsById: { ...state.decisionsById } };
  setOwnValue(next.decisionsById, id, decision);
  next.review = settleReview(next, {
    ...state.review,
    unreviewed: state.review.unreviewed.filter((entry) => entry !== id),
  });
  return next;
};

const onReviewReply: EventHandler = (state, event) => {
  const payload = event.payload as ReviewReplyPayload;
  const id = isString(payload.decision_id) ? payload.decision_id : payload.id;
  if (!isString(id) || !isString(payload.text)) return state;
  const message: DeliveryThreadMessage = {
    seq: event.seq,
    decisionId: id,
    text: payload.text,
    author: isString(payload.author) ? payload.author : AGENT_AUTHOR,
    ts: event.ts,
  };
  if (isString(payload.in_reply_to)) message.inReplyTo = payload.in_reply_to;
  if (isNumber(payload.control_seq)) message.controlSeq = payload.control_seq;
  const thread = [...(ownValue(state.threadsByDecisionId, id) ?? []), message];
  const threadsByDecisionId = { ...state.threadsByDecisionId };
  setOwnValue(threadsByDecisionId, id, thread);
  return { ...state, threadsByDecisionId };
};

function looksLikeProvisionalCase(value: unknown): value is Partial<ProvisionalCase> & {
  case: string;
  mark: ProvisionalMark;
} {
  return isRecord(value) && isString(value.case) && isProvisionalMark(value.mark);
}

const onGateProvisional: EventHandler = (state, event) => {
  const payload = event.payload as GateProvisionalPayload;
  if (!isString(payload.gate_id)) return state;
  const index = state.gates.findIndex((gate) => gate.id === payload.gate_id);
  if (index < 0) return state;
  if (!Array.isArray(payload.cases) || !payload.cases.every(looksLikeProvisionalCase)) {
    return state;
  }
  const provisionalCases: ProvisionalCase[] = payload.cases.map((entry) => ({
    case: entry.case,
    mark: entry.mark,
    evidence: typeof entry.evidence === "string" ? entry.evidence : "",
    confirmed: entry.confirmed === true,
  }));
  const gates = [...state.gates];
  gates[index] = merge(state.gates[index], {
    status: GATE_PROVISIONAL_STATUS,
    provisionalCases,
  });
  // A gate judged again is dated from this event, so `before` is left out.
  const next = {
    ...state,
    gates,
    provisionalAt: trackProvisionalAt(state.provisionalAt, undefined, gates[index], event.ts),
  };
  next.review = settleReview(next, state.review);
  return next;
};

// Applies to a gate whose status is `provisional` only: confirming a gate that
// is not provisional is a no-op. Once every mark is confirmed the gate takes
// the payload's status, else `confirmed`; while a mark is unconfirmed it stays
// `provisional` unless the payload moves it.
const onGateConfirmed: EventHandler = (state, event) => {
  const payload = event.payload as GateConfirmedPayload;
  if (!isString(payload.gate_id)) return state;
  const index = state.gates.findIndex((gate) => gate.id === payload.gate_id);
  if (index < 0) return state;
  const gate = state.gates[index];
  if (!isProvisionalGate(gate)) return state;
  const named = isStringArray(payload.cases) ? new Set(payload.cases) : null;
  const provisionalCases = (gate.provisionalCases ?? []).map((entry) =>
    named === null || named.has(entry.case) ? { ...entry, confirmed: true } : entry,
  );
  const allConfirmed = provisionalCases.every((entry) => entry.confirmed);
  const patch: Partial<DeliveryGate> = { provisionalCases };
  if (isString(payload.status)) {
    patch.status = payload.status;
  } else if (allConfirmed) {
    patch.status = "confirmed";
  }
  const gates = [...state.gates];
  gates[index] = merge(gate, patch);
  const next = {
    ...state,
    gates,
    provisionalAt: trackProvisionalAt(state.provisionalAt, gate, gates[index], event.ts),
  };
  next.review = settleReview(next, state.review);
  return next;
};

// The handler table. Adding an event type is adding a row; a type with no row is
// skipped (its seq is still accepted). The fold reads it through `ownValue`, so
// a type that names an `Object.prototype` member has no row either.
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
  "mode.changed": onModeChanged,
  "decision.decided": onDecisionDecided,
  "review.opened": onReviewOpened,
  "review.outcome": onReviewOutcome,
  "review.reply": onReviewReply,
  "gate.provisional": onGateProvisional,
  "gate.confirmed": onGateConfirmed,
};

export const DELIVERY_EVENT_TYPES: readonly string[] = Object.keys(EVENT_HANDLERS);

// ── The fold ──

function stateFromRecord(record: DeliveryRecord): FoldState {
  // A gate the record carries as provisional became so before any event the
  // fold applies: the record's `updated_at` is the time the fold knows.
  const provisionalAt: Record<string, string> = {};
  for (const gate of record.stack.gates) {
    if (isProvisionalGate(gate)) setOwnValue(provisionalAt, gate.id, record.updated_at);
  }
  const state: FoldState = {
    seq: record.last_event_seq,
    mode: record.mode,
    review: record.review,
    unitsById: indexById(record.units),
    stacks: { ...record.stack.stacks },
    gates: [...record.stack.gates],
    provisionalAt,
    decisionsById: indexById(record.decisions),
    threadsByDecisionId: {},
    steeringById: indexById(record.steering),
    budget: record.budget,
    roles: record.roles,
    health: record.health,
    drift: record.drift,
    lifecycle: record.lifecycle,
    seams: record.seams,
  };
  // A valid record can still carry a review section that disagrees with its
  // decisions and gates: a list that names an accepted decision, or a `none`
  // status while a card waits. Bring it into line here, with the helpers the
  // event handlers use, so the list, the status and the review stack agree from
  // the first snapshot on.
  state.review = settleReview(state, {
    ...record.review,
    unreviewed: reconcileUnreviewed(state, record.review.unreviewed),
  });
  return state;
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
    const handler = ownValue(EVENT_HANDLERS, event.type);
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

// Progress (SB-FR-011), derived from the record's gates through `evaluateGate`.
// The counted cases are the union of the gating sets that `evaluateGate`
// resolved for the record's gates (`gatesById`, in record order): a case that no
// gate names, a case the default level/type policy leaves out of its gate (L3
// and L4 that are not e2e_flow), and a case the lifecycle resolutions retire are
// never counted in `cases`. A counted case is met when the gate that gates it
// read it as resolved: the gate's state is not `stale` (the results are present
// and current) and the case is not in its `unresolvedCaseIds`, so the lifecycle
// decides which result it is read by, an override wins over the derived status,
// and an orphaned or absent result is not met, exactly as the gate reads it.
//
// A requirement is covered when every plan case that links it is met, gating or
// not. A counted case is met as its gate reads it. Any other plan case (one no
// gate names, or one the level/type policy leaves out) is met only when its
// current result (results whose `planHash` is the record's plan hash, read
// through `readCaseResult` with the lifecycle's resolutions) reads as met by
// `isCaseMet`: no current result, an unresolvable pointer, or a failed, blocked
// or unverified result is not met. A case the lifecycle retires ends its
// obligation, as it leaves a gate's set, so it never holds a requirement open;
// a requirement that only retired cases link is not counted. `requirements.total`
// is the number of requirements that a plan case still in force links.
//
// `caseList` holds one entry per counted case, in plan order, then any gating id
// the plan lacks in gate order. Each entry carries the result the case is read
// by (`readCaseResult` over current results) and the unit that met it, read from
// the record's gates and units only (see `DeliveryCaseProgress`). Without the
// plan nothing is counted.
function computeProgress(
  record: DeliveryRecord,
  state: Pick<FoldState, "gates" | "unitsById">,
  gatesById: Readonly<Record<string, DeliveryGateView>>,
  plan: TestCasesPlan | undefined,
  results: DeliveryResults | undefined,
  lifecycle: GateLifecycle | undefined,
): DeliveryProgress {
  if (plan === undefined) {
    return { cases: { met: 0, total: 0 }, requirements: { met: 0, total: 0 }, caseList: [] };
  }
  // Each gating case with the reading of the first gate that gates it. Every
  // gate reads the same results through the same lifecycle, so a case that two
  // gates name reads the same in both.
  const metById = new Map<string, boolean>();
  for (const gate of state.gates) {
    const view = ownValue(gatesById, gate.id);
    if (view === undefined) continue;
    const unresolved = new Set(view.state.unresolvedCaseIds);
    for (const id of view.state.gatingCaseIds) {
      if (metById.has(id)) continue;
      metById.set(id, view.state.status !== "stale" && !unresolved.has(id));
    }
  }
  const resolutionById = indexResolutions(lifecycle);
  const current =
    results !== undefined && results.planHash === record.plan_hash ? results : undefined;
  const planCaseById = new Map(plan.cases.map((planCase) => [planCase.id, planCase]));
  const countedIds = [
    ...plan.cases.map((planCase) => planCase.id).filter((id) => metById.has(id)),
    ...[...metById.keys()].filter((id) => !planCaseById.has(id)),
  ];
  const requirementCases = new Map<string, { total: number; met: number }>();
  const caseList: DeliveryCaseProgress[] = [];
  let met = 0;
  for (const id of countedIds) {
    const caseMet = metById.get(id) === true;
    if (caseMet) met += 1;
    const result =
      current === undefined
        ? undefined
        : readCaseResult(id, current.caseResults, resolutionById, lifecycle);
    const metBy = caseMet ? unitThatMet(state.gates, id) : null;
    const metByUnit = metBy === null ? undefined : ownValue(state.unitsById, metBy);
    caseList.push({
      id,
      met: caseMet,
      result: result ?? null,
      metBy,
      prUrl: metByUnit?.pr_url ?? null,
    });
  }
  // Every plan case in force that links a requirement, gating or not.
  for (const planCase of plan.cases) {
    if (resolutionById.get(planCase.id)?.status === "retired") continue;
    const gatingMet = metById.get(planCase.id);
    const caseMet =
      gatingMet !== undefined
        ? gatingMet
        : current !== undefined &&
          isCaseMet(readCaseResult(planCase.id, current.caseResults, resolutionById, lifecycle));
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
    cases: { met, total: countedIds.length },
    requirements: { met: covered, total: requirementCases.size },
    caseList,
  };
}

// The unit that met a case: the last unit in the `after` list of the first gate
// whose `cases` names it, or null when no gate names it.
function unitThatMet(gates: readonly DeliveryGate[], caseId: string): string | null {
  const gate = gates.find((candidate) => candidate.cases.includes(caseId));
  if (gate === undefined || gate.after.length === 0) return null;
  return gate.after[gate.after.length - 1];
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
  // Without the plan the gate reads `stale`, whatever the results say: the
  // evaluator would otherwise judge an un-narrowed gating set over results it
  // cannot relate to the plan, while progress in the same snapshot reports no
  // totals. Passing null results takes the evaluator's own STALE rung.
  const gateResults = plan === undefined ? null : (results ?? null);
  const gatesById: Record<string, DeliveryGateView> = {};
  for (const gate of state.gates) {
    setOwnValue(gatesById, gate.id, {
      gate,
      state: evaluateGate(verifyUnitOf(gate), gateResults, record.plan_hash, plan, lifecycle),
      provisionalAt: isProvisionalGate(gate)
        ? (ownValue(state.provisionalAt, gate.id) ?? null)
        : null,
    });
  }
  const jams = Object.values(state.unitsById)
    .filter((unit) => classifyUnitStatus(unit.status) === "jammed")
    .map((unit) => unit.id);
  const snapshot: DeliverySnapshot = {
    deliveryId: record.delivery_id,
    seq: state.seq,
    mode: state.mode,
    review: state.review,
    unitsById: state.unitsById,
    stacks: state.stacks,
    edges: buildEdges(state.unitsById, state.stacks),
    gatesById,
    decisionsById: state.decisionsById,
    threadsByDecisionId: state.threadsByDecisionId,
    steeringById: state.steeringById,
    budget: state.budget,
    roles: state.roles,
    health: state.health,
    jams,
    drift: state.drift,
    lifecycle: state.lifecycle,
    seams: state.seams,
    progress: computeProgress(record, state, gatesById, plan, results, lifecycle),
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
