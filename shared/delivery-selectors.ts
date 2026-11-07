// Selectors over a `DeliverySnapshot` (SB-FR-008, SB-FR-011): the readings every
// view takes, so the server summary and the client views agree on what a unit's
// status, a gate's state, the progress and the next boundary are. Each selector
// is a pure function of the snapshot; none reads a clock or fetches.
//
// Status words are open strings, read through `classifyUnitStatus` and
// `isDecisionOpen` from the reducer, each with an "other" fallback. An id or a
// stack name is an open string too, so every `byId` or `stacks` read goes
// through the reducer's `ownValue`: a unit called `toString` is a unit, and a
// stack called `constructor` that the snapshot does not list has no members. The
// dependency-order selectors (SB-FR-010) give the delivery map its order, its
// edges and the place of each gate. The
// decision-mode selectors (SB-FR-040: the mode, the review stack, a decision's
// thread, a gate's provisional marks) are more functions over the same
// snapshot, at the end of the module.

import {
  AGENT_AUTHOR,
  type DeliveryDecision,
  type DeliveryDrift,
  type DeliveryGate,
  type DeliveryMode,
  type DeliveryModeValue,
  type DeliveryReview,
  type DeliverySteering,
  type DeliveryUnit,
  type ProvisionalCase,
} from "./delivery-observation-contract";
import type { DeliveryControl } from "./delivery-control-contract";
import {
  DECISION_DEFAULTED_STATUS,
  DECISION_OVERTURNED_STATUS,
  classifyUnitStatus,
  computeStaleness,
  isDecisionOpen,
  isModeValue,
  isProvisionalGate,
  isUnconfirmedProvisionalGate,
  isUnreviewedAgentDecision,
  ownValue,
  type DeliveryStaleness,
  type DeliveryCaseProgress,
  type DeliveryEdge,
  type DeliveryGateView,
  type DeliveryProgress,
  type DeliverySnapshot,
  type DeliveryThreadMessage,
  type UnitStatusKind,
} from "./delivery-reducer";

export {
  classifyUnitStatus,
  isDecisionDefaulted,
  isDecisionOpen,
  isProvisionalGate,
  isUnconfirmedProvisionalGate,
  isUnreviewedAgentDecision,
} from "./delivery-reducer";

export interface UnitStatusView {
  // The record's own status word, or null for a unit the snapshot does not carry.
  status: string | null;
  kind: UnitStatusKind | null;
}

export function selectUnitStatus(snapshot: DeliverySnapshot, unitId: string): UnitStatusView {
  const unit = ownValue(snapshot.unitsById, unitId);
  if (unit === undefined) {
    return { status: null, kind: null };
  }
  return { status: unit.status, kind: classifyUnitStatus(unit.status) };
}

export interface UnitStackView {
  stack: string;
  layer: number;
  // The stack's ordered unit ids, base first.
  members: string[];
  // The unit's position in `members`, or -1 when the stack list does not name it.
  index: number;
}

export function selectUnitStack(snapshot: DeliverySnapshot, unitId: string): UnitStackView | null {
  const unit = ownValue(snapshot.unitsById, unitId);
  if (unit === undefined) {
    return null;
  }
  const members = ownValue(snapshot.stacks, unit.stack) ?? [];
  return { stack: unit.stack, layer: unit.layer, members, index: members.indexOf(unitId) };
}

export function selectGateState(
  snapshot: DeliverySnapshot,
  gateId: string,
): DeliveryGateView | null {
  return ownValue(snapshot.gatesById, gateId) ?? null;
}

export function selectProgress(snapshot: DeliverySnapshot): DeliveryProgress {
  return snapshot.progress;
}

// The met cases of the progress, in plan order, each with its verify record and
// the unit that met it (SB-FR-011).
export function selectMetCases(snapshot: DeliverySnapshot): DeliveryCaseProgress[] {
  return snapshot.progress.caseList.filter((entry) => entry.met);
}

// Every unit in stack order: the stacks in the record's key order, each base
// first. A unit no stack lists comes last, in `unitsById` order.
export function selectUnitsInStackOrder(snapshot: DeliverySnapshot): DeliveryUnit[] {
  const seen = new Set<string>();
  const ordered: DeliveryUnit[] = [];
  for (const members of Object.values(snapshot.stacks)) {
    for (const id of members) {
      const unit = ownValue(snapshot.unitsById, id);
      if (unit !== undefined && !seen.has(id)) {
        seen.add(id);
        ordered.push(unit);
      }
    }
  }
  for (const unit of Object.values(snapshot.unitsById)) {
    if (!seen.has(unit.id)) {
      seen.add(unit.id);
      ordered.push(unit);
    }
  }
  return ordered;
}

// ── Dependency order (SB-FR-010) ──

// The `depends_on` edges between two units the snapshot carries: a dependency
// on an id that no unit has is not drawn and does not order anything.
export function selectDependencyEdges(snapshot: DeliverySnapshot): DeliveryEdge[] {
  return snapshot.edges.filter(
    (edge) =>
      edge.kind === "depends_on" &&
      ownValue(snapshot.unitsById, edge.from) !== undefined &&
      ownValue(snapshot.unitsById, edge.to) !== undefined,
  );
}

// The ids of the units a unit depends on, in the order its `depends_on` lists
// them, each once; empty for a unit the snapshot does not carry.
export function selectUnitDependencies(snapshot: DeliverySnapshot, unitId: string): string[] {
  const dependencies: string[] = [];
  for (const edge of selectDependencyEdges(snapshot)) {
    if (edge.to === unitId && !dependencies.includes(edge.from)) dependencies.push(edge.from);
  }
  return dependencies;
}

// Every unit in dependency order (each after the units it depends on), or the
// cycle that leaves no such order. Among the units that are ready at a step,
// stack order (`selectUnitsInStackOrder`) breaks the tie, so a delivery with no
// cross-stack dependency reads stack by stack, base first. A cycle lists its
// unit ids so that each depends on the next and the last on the first.
export type DependencyOrder =
  { kind: "ordered"; units: DeliveryUnit[] } | { kind: "cycle"; cycle: string[] };

export function selectDependencyOrder(snapshot: DeliverySnapshot): DependencyOrder {
  const base = selectUnitsInStackOrder(snapshot);
  const rank = new Map(base.map((unit, index) => [unit.id, index]));
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const waiting = new Map<string, number>();
  for (const unit of base) {
    dependencies.set(unit.id, []);
    dependents.set(unit.id, []);
    waiting.set(unit.id, 0);
  }
  for (const edge of selectDependencyEdges(snapshot)) {
    const before = dependencies.get(edge.to);
    if (before === undefined || before.includes(edge.from)) continue;
    before.push(edge.from);
    dependents.get(edge.from)?.push(edge.to);
    waiting.set(edge.to, (waiting.get(edge.to) ?? 0) + 1);
  }

  const byRank = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  const ready = base.filter((unit) => waiting.get(unit.id) === 0).map((unit) => unit.id);
  const ordered: DeliveryUnit[] = [];
  while (ready.length > 0) {
    ready.sort(byRank);
    const id = ready.shift() as string;
    const unit = ownValue(snapshot.unitsById, id);
    if (unit !== undefined) ordered.push(unit);
    for (const next of dependents.get(id) ?? []) {
      const left = (waiting.get(next) ?? 0) - 1;
      waiting.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (ordered.length === base.length) {
    return { kind: "ordered", units: ordered };
  }

  // Every unit left over still waits on a unit that is left over, so a walk
  // along those dependencies must come back to a unit it already met.
  const placed = new Set(ordered.map((unit) => unit.id));
  const left = base.map((unit) => unit.id).filter((id) => !placed.has(id));
  const at = new Map<string, number>();
  const path: string[] = [];
  let current = left[0];
  while (!at.has(current)) {
    at.set(current, path.length);
    path.push(current);
    const next = (dependencies.get(current) ?? []).find((id) => !placed.has(id));
    if (next === undefined) break;
    current = next;
  }
  return { kind: "cycle", cycle: path.slice(at.get(current) ?? 0) };
}

// Where each gate sits in a dependency order: after the last of its `after`
// units in `orderedIds`. A gate none of whose `after` units is in the order has
// no place and is left out.
export function selectGateAnchors(
  snapshot: DeliverySnapshot,
  orderedIds: readonly string[],
): Map<string, DeliveryGateView[]> {
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  const anchors = new Map<string, DeliveryGateView[]>();
  for (const view of Object.values(snapshot.gatesById)) {
    let anchor: string | undefined;
    for (const id of view.gate.after) {
      const index = position.get(id);
      if (index !== undefined && (anchor === undefined || index > (position.get(anchor) ?? -1))) {
        anchor = id;
      }
    }
    if (anchor === undefined) continue;
    const list = anchors.get(anchor) ?? [];
    list.push(view);
    anchors.set(anchor, list);
  }
  return anchors;
}

// The gates that run after a unit: every gate whose `after` names it.
export function selectGatesAfterUnit(
  snapshot: DeliverySnapshot,
  unitId: string,
): DeliveryGateView[] {
  return Object.values(snapshot.gatesById).filter((view) => view.gate.after.includes(unitId));
}

export type BoundaryKind = "finish" | "start";

// The next unit boundary: the first running unit in stack order (it finishes
// next), else the first pending one (it starts next), with the open decisions
// and the steering notes queued for that unit.
export interface DeliveryBoundary {
  unitId: string;
  kind: BoundaryKind;
  decisions: DeliveryDecision[];
  steering: DeliverySteering[];
}

export function selectOpenDecisions(
  snapshot: DeliverySnapshot,
  unitId?: string,
): DeliveryDecision[] {
  return Object.values(snapshot.decisionsById).filter(
    (decision) => isDecisionOpen(decision) && (unitId === undefined || decision.unit_id === unitId),
  );
}

// The decision pile of the Delivery tab (SB-FR-014, SB-FR-015): every decision
// the session asked that is still open, defaulted (its default applied and open
// to an overturn) or overturned (the option that replaced its default applied),
// newest first by `raised_at`, then by id for a tie. An answered decision has
// left the pile, and a decision the agent decided on its own waits on the
// review stack instead.
export function selectDecisionPile(snapshot: DeliverySnapshot): DeliveryDecision[] {
  return Object.values(snapshot.decisionsById)
    .filter((decision) => {
      const status = decision.status.toLowerCase();
      return (
        isDecisionOpen(decision) ||
        status === DECISION_DEFAULTED_STATUS ||
        status === DECISION_OVERTURNED_STATUS
      );
    })
    .sort((a, b) => {
      const byTime = Date.parse(b.raised_at) - Date.parse(a.raised_at);
      if (!Number.isNaN(byTime) && byTime !== 0) return byTime;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
}

// What an open decision holds and what goes on without it (SB-FR-014): a
// decision blocks only the units that build on its choice, and the rest of the
// delivery continues. The units that build on it are its `affected_units` when
// the decision names them, else every unit that depends on the decision's unit,
// directly or through another unit. The decision's own unit is not held: it
// goes on with the default until an answer lands. Of the units that have not
// finished (neither done nor skipped), `held` lists those that build on the
// decision and `continuing` every other, in the snapshot's unit order.
export interface DecisionHolds {
  held: string[];
  continuing: string[];
}

function dependentsOf(snapshot: DeliverySnapshot, unitId: string): Set<string> {
  const found = new Set<string>();
  const queue = [unitId];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const unit of Object.values(snapshot.unitsById)) {
      if (unit.id === unitId || found.has(unit.id)) continue;
      if (unit.depends_on.includes(current)) {
        found.add(unit.id);
        queue.push(unit.id);
      }
    }
  }
  return found;
}

export function selectDecisionHolds(
  snapshot: DeliverySnapshot,
  decision: DeliveryDecision,
): DecisionHolds {
  const buildsOn =
    decision.affected_units !== undefined
      ? new Set(decision.affected_units)
      : decision.unit_id !== undefined
        ? dependentsOf(snapshot, decision.unit_id)
        : new Set<string>();
  if (decision.unit_id !== undefined) buildsOn.delete(decision.unit_id);
  const held: string[] = [];
  const continuing: string[] = [];
  for (const unit of Object.values(snapshot.unitsById)) {
    const kind = classifyUnitStatus(unit.status);
    if (kind === "done" || kind === "skipped") continue;
    (buildsOn.has(unit.id) ? held : continuing).push(unit.id);
  }
  return { held, continuing };
}

// The steering notes that reach a unit: those naming it, and those naming no
// unit (which apply to every unit).
export function selectSteeringFor(snapshot: DeliverySnapshot, unitId: string): DeliverySteering[] {
  return Object.values(snapshot.steeringById).filter(
    (note) => note.unit_ids.length === 0 || note.unit_ids.includes(unitId),
  );
}

export function selectNextBoundary(snapshot: DeliverySnapshot): DeliveryBoundary | null {
  const ordered = selectUnitsInStackOrder(snapshot);
  const running = ordered.find((unit) => classifyUnitStatus(unit.status) === "running");
  const pending = running ?? ordered.find((unit) => classifyUnitStatus(unit.status) === "pending");
  if (pending === undefined) {
    return null;
  }
  return {
    unitId: pending.id,
    kind: running !== undefined ? "finish" : "start",
    decisions: selectOpenDecisions(snapshot, pending.id),
    steering: selectSteeringFor(snapshot, pending.id),
  };
}

// ── Steering and the boundary panel (SB-FR-016, SB-FR-017) ──

// The statuses of a control the session has not read back yet.
const OUTSTANDING_CONTROL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "queued",
  "delivered",
]);

function isOutstandingControl(control: DeliveryControl): boolean {
  return OUTSTANDING_CONTROL_STATUSES.has(control.status);
}

// Where a steering note is: queued until the session reads it back, applied
// once it has, or rejected when the session refused it.
export type SteeringNoteState = "queued" | "applied" | "rejected";

// One operator steering note of the outbox, as the Steering note component of
// DESIGN.md shows it.
export interface SteeringNoteView {
  controlSeq: number;
  note: string;
  // The unit boundary the composer named, or null when the control names none.
  appliesAt: string | null;
  state: SteeringNoteState;
  // The session's read-back: the note of the `steering.added` that names this
  // control's control_seq, or null while there is none.
  readBack: string | null;
  issuedAt: string;
}

function steeringNoteOf(control: DeliveryControl): { note: string; appliesAt: string | null } {
  const body = control.body as { note?: unknown; applies_at?: unknown };
  return {
    note: typeof body.note === "string" ? body.note : "",
    appliesAt:
      typeof body.applies_at === "string" && body.applies_at.length > 0 ? body.applies_at : null,
  };
}

// The read-back text of each steering-note control, by control_seq: the note of
// each steering entry that names one.
function steeringReadBacks(snapshot: DeliverySnapshot): Map<number, string> {
  const readBacks = new Map<number, string>();
  for (const entry of Object.values(snapshot.steeringById)) {
    const seq = (entry as { control_seq?: unknown }).control_seq;
    if (typeof seq === "number") readBacks.set(seq, entry.note);
  }
  return readBacks;
}

// Every steering note the operator sent, in control_seq order: queued ones,
// applied ones with their read-back, and refused ones. A superseded note is
// left out. A note is applied only once the session has read it back: the
// boundary alone moves nothing.
export function selectSteeringNotes(snapshot: DeliverySnapshot): SteeringNoteView[] {
  const readBacks = steeringReadBacks(snapshot);
  const notes: SteeringNoteView[] = [];
  for (const control of snapshot.controls) {
    if (control.kind !== "steering-note") continue;
    let state: SteeringNoteState;
    if (isOutstandingControl(control)) state = "queued";
    else if (control.status === "applied") state = "applied";
    else if (control.status === "rejected") state = "rejected";
    else continue;
    const { note, appliesAt } = steeringNoteOf(control);
    notes.push({
      controlSeq: control.control_seq,
      note,
      appliesAt,
      state,
      readBack: state === "applied" ? (readBacks.get(control.control_seq) ?? null) : null,
      issuedAt: control.issued_at,
    });
  }
  return notes;
}

// One item queued for the next unit boundary: a steering note, or a change of
// a role's tier.
export type BoundaryQueueItem =
  | { kind: "steering-note"; controlSeq: number; note: string; appliesAt: string | null }
  | { kind: "role-change"; controlSeq: number; role: string; tier: string };

// The boundary panel: the next unit boundary, and everything queued for it.
export interface BoundaryPanelView {
  boundary: DeliveryBoundary | null;
  queued: BoundaryQueueItem[];
}

// The next unit boundary and every steering note and role change that waits
// for it in the outbox, in control_seq order. An item leaves the queue only on
// its read-back, so after a boundary with read-backs the panel names the
// following boundary with an empty queue.
export function selectBoundaryPanel(snapshot: DeliverySnapshot): BoundaryPanelView {
  const queued: BoundaryQueueItem[] = [];
  for (const control of snapshot.controls) {
    if (!isOutstandingControl(control)) continue;
    if (control.kind === "steering-note") {
      queued.push({
        kind: "steering-note",
        controlSeq: control.control_seq,
        ...steeringNoteOf(control),
      });
    } else if (control.kind === "role-change") {
      const tier = (control.body as { tier?: unknown }).tier;
      queued.push({
        kind: "role-change",
        controlSeq: control.control_seq,
        role: control.target_id ?? "",
        tier: typeof tier === "string" ? tier : "",
      });
    }
  }
  return { boundary: selectNextBoundary(snapshot), queued };
}

// Milliseconds since the record's `updated_at`, or null when the fold had no
// `now` to compare against.
export function selectStalenessAge(snapshot: DeliverySnapshot): number | null {
  return snapshot.staleness.ageMs;
}

// ── Cost, health and drift (SB-FR-018, SB-FR-019, SB-FR-020, SB-NFR-006) ──

// The staleness of the snapshot at `now`, from the record's `updated_at` and the
// time of the last event the fold applied. A view passes its own clock, so the
// stale indicator appears 2 minutes after the last event even when no new
// snapshot arrives; without `now` it is the staleness the fold computed.
export function selectStaleness(snapshot: DeliverySnapshot, now?: number): DeliveryStaleness {
  if (now === undefined) return snapshot.staleness;
  return computeStaleness(snapshot.staleness.updatedAt, snapshot.staleness.lastEventAt, now);
}

export interface BurnUnitCost {
  unitId: string;
  title: string;
  costUsd: number;
}

export interface BurnRoleCost {
  role: string;
  costUsd: number;
}

// The burn meter (SB-FR-018): spend against the soft budget, with the cost per
// unit (each unit's `cost_usd`, in stack order, units with no cost left out)
// and per role (the budget's `by_role`, in its key order).
export interface DeliveryBurn {
  spentUsd: number;
  softBudgetUsd: number;
  estimateUsd: number;
  // Spend over the soft budget, from 0 to 1; 1 once the budget is spent or when
  // it is zero and anything is spent.
  fill: number;
  overBudget: boolean;
  byUnit: BurnUnitCost[];
  byRole: BurnRoleCost[];
}

export function selectBurn(snapshot: DeliverySnapshot): DeliveryBurn {
  const { spent_usd: spentUsd, soft_budget_usd: softBudgetUsd } = snapshot.budget;
  const fill = softBudgetUsd > 0 ? Math.min(1, spentUsd / softBudgetUsd) : spentUsd > 0 ? 1 : 0;
  const byUnit: BurnUnitCost[] = [];
  for (const unit of selectUnitsInStackOrder(snapshot)) {
    if (unit.cost_usd === undefined) continue;
    byUnit.push({ unitId: unit.id, title: unit.title, costUsd: unit.cost_usd });
  }
  const byRole = Object.entries(snapshot.budget.by_role ?? {}).map(([role, costUsd]) => ({
    role,
    costUsd,
  }));
  return {
    spentUsd,
    softBudgetUsd,
    estimateUsd: snapshot.budget.estimate_usd,
    fill,
    overBudget: spentUsd > softBudgetUsd,
    byUnit,
    byRole,
  };
}

// ── Lifecycle and the role matrix (SB-FR-021, SB-FR-022) ──

// The lifecycle states the bench knows, matched case-insensitively: the
// running state and the states a pause, a wind-down and an approval lead to.
// Any other word is `other`.
export type DeliveryLifecycleState = "running" | "paused" | "wound_down" | "complete" | "other";

const LIFECYCLE_STATES: Readonly<Record<string, DeliveryLifecycleState>> = {
  running: "running",
  paused: "paused",
  wound_down: "wound_down",
  complete: "complete",
};

export function classifyLifecycleState(state: string): DeliveryLifecycleState {
  return ownValue(LIFECYCLE_STATES, state.toLowerCase()) ?? "other";
}

const LIFECYCLE_HEALTH: Partial<
  Record<DeliveryLifecycleState, { word: DeliveryHealthWord; reason: string }>
> = {
  paused: { word: "paused", reason: "The delivery is paused: resume it to go on" },
  wound_down: {
    word: "wound down",
    reason: "The delivery is wound down: resume it to go on",
  },
  complete: { word: "complete", reason: "The delivery is complete" },
};

// An operator action on the delivery's lifecycle, as its route names it.
// `sit` opens a gate sitting (POST .../delivery/sittings).
export type DeliveryLifecycleAction = "pause" | "wind-down" | "resume" | "approve" | "sit";

// The lifecycle states each action is open in. A resume is open while the
// delivery reads `running` too: a session that ended without a pause leaves the
// record running, and the resume launches it again (the bench's own live
// session is refused apart, by the resume route). A gate sitting is open in the
// states an approval is. Nothing acts on a complete delivery, nor on a state
// the bench does not know.
const LIFECYCLE_ACTION_STATES: Readonly<
  Record<DeliveryLifecycleAction, ReadonlySet<DeliveryLifecycleState>>
> = {
  pause: new Set(["running"]),
  "wind-down": new Set(["running", "paused"]),
  resume: new Set(["running", "paused", "wound_down"]),
  approve: new Set(["running", "paused", "wound_down"]),
  sit: new Set(["running", "paused", "wound_down"]),
};

const LIFECYCLE_ACTION_WORDS: Readonly<Record<DeliveryLifecycleAction, string>> = {
  pause: "paused",
  "wind-down": "wound down",
  resume: "resumed",
  approve: "approved",
  sit: "given a gate sitting",
};

export interface LifecycleActionAvailability {
  available: boolean;
  // The record's lifecycle state, as it is recorded.
  state: string;
  // Why the action is not open, naming the state; null when it is.
  reason: string | null;
}

// Whether a lifecycle action is open in the delivery's lifecycle state. The
// lifecycle routes and the lifecycle buttons read the same answer, so a button
// is enabled exactly when its route would not answer 409 WRONG_LIFECYCLE_STATE.
export function selectLifecycleAction(
  snapshot: DeliverySnapshot,
  action: DeliveryLifecycleAction,
): LifecycleActionAvailability {
  const state = snapshot.lifecycle.state;
  if (LIFECYCLE_ACTION_STATES[action].has(classifyLifecycleState(state))) {
    return { available: true, state, reason: null };
  }
  return {
    available: false,
    state,
    reason: `The delivery is ${state}, so it cannot be ${LIFECYCLE_ACTION_WORDS[action]}`,
  };
}

// One row of the role matrix (DESIGN.md Role matrix row): the role, the tier
// in effect, the tier a change asked for while its role-change control waits
// for the session's read-back (null when none waits), and the role's spend so
// far from the budget's `by_role` (null when the budget names none).
export interface RoleMatrixRow {
  role: string;
  tier: string;
  pendingTier: string | null;
  pendingControlSeq: number | null;
  spentUsd: number | null;
}

// Every role of the delivery in the record's key order, each with the last
// outstanding role-change control that targets it. The control stops waiting
// on its read-back (a `roles.applied` that names its control_seq), which also
// makes its tier the role's current one.
export function selectRoleMatrix(snapshot: DeliverySnapshot): RoleMatrixRow[] {
  const pending = new Map<string, { tier: string; controlSeq: number }>();
  for (const control of snapshot.controls) {
    if (control.kind !== "role-change" || !isOutstandingControl(control)) continue;
    const tier = (control.body as { tier?: unknown }).tier;
    if (control.target_id === undefined || typeof tier !== "string") continue;
    pending.set(control.target_id, { tier, controlSeq: control.control_seq });
  }
  const byRole = snapshot.budget.by_role ?? {};
  return Object.entries(snapshot.roles).map(([role, value]) => {
    const waiting = pending.get(role);
    const spent = ownValue(byRole, role);
    return {
      role,
      tier: value.tier,
      pendingTier: waiting?.tier ?? null,
      pendingControlSeq: waiting?.controlSeq ?? null,
      spentUsd: typeof spent === "number" ? spent : null,
    };
  });
}

// The ids of the jammed units, in stack order (SB-FR-019).
export function selectJammedUnits(snapshot: DeliverySnapshot): string[] {
  const jammed = new Set(snapshot.jams);
  return selectUnitsInStackOrder(snapshot)
    .filter((unit) => jammed.has(unit.id))
    .map((unit) => unit.id);
}

export function isJammedUnit(snapshot: DeliverySnapshot, unitId: string): boolean {
  return snapshot.jams.includes(unitId);
}

// The drift ledger (SB-FR-020): every drift entry, oldest first, as the record
// and the stream added them.
export function selectDriftLedger(snapshot: DeliverySnapshot): DeliveryDrift[] {
  return snapshot.drift;
}

// The health chip's one word (DESIGN.md Health chip): `blocked` while a unit is
// jammed, else `disconnected` while the stream is down (the stream's word, which
// a view that holds the stream state passes in), else the lifecycle's word while
// the delivery is paused, wound down or complete (SB-FR-022), else `attached`
// while an attached bench holds no session and no event has arrived since it
// attached (SB-FR-003: the view passes `attached` for an attached bench with no
// session), else `stale` once the delivery has been quiet for 2 minutes, else
// `fresh`. A paused delivery sends no event, so its lifecycle word goes before
// `stale`, and so does `attached`: a delivery started elsewhere is quiet until a
// session runs it again, and the first event it sends clears the word.
export type DeliveryHealthWord =
  | "fresh"
  | "stale"
  | "disconnected"
  | "blocked"
  | "paused"
  | "wound down"
  | "complete"
  | "attached";

export interface DeliveryHealthView {
  word: DeliveryHealthWord;
  // What the chip opens: why the delivery reads as it does.
  reason: string;
  jammed: string[];
  staleness: DeliveryStaleness;
}

function minutes(ms: number): string {
  const whole = Math.floor(ms / 60_000);
  return whole === 1 ? "1 minute" : `${whole} minutes`;
}

export function selectHealth(
  snapshot: DeliverySnapshot,
  now?: number,
  options: { disconnected?: boolean; attached?: boolean } = {},
): DeliveryHealthView {
  const jammed = selectJammedUnits(snapshot);
  const staleness = selectStaleness(snapshot, now);
  if (jammed.length > 0) {
    const names = jammed.join(", ");
    return {
      word: "blocked",
      reason: `${jammed.length === 1 ? "Unit" : "Units"} ${names} ${jammed.length === 1 ? "is" : "are"} jammed`,
      jammed,
      staleness,
    };
  }
  if (options.disconnected === true) {
    return {
      word: "disconnected",
      reason: "The event stream is down, so the delivery may have moved since",
      jammed,
      staleness,
    };
  }
  const lifecycle = LIFECYCLE_HEALTH[classifyLifecycleState(snapshot.lifecycle.state)];
  if (lifecycle !== undefined) {
    return { ...lifecycle, jammed, staleness };
  }
  if (options.attached === true && staleness.lastEventAt === null) {
    return {
      word: "attached",
      reason: "Attached to a delivery started elsewhere: no session runs it on this bench yet",
      jammed,
      staleness,
    };
  }
  if (staleness.stale && staleness.quietMs !== null) {
    return {
      word: "stale",
      reason: `No event for ${minutes(staleness.quietMs)}`,
      jammed,
      staleness,
    };
  }
  return { word: "fresh", reason: "The delivery is moving", jammed, staleness };
}

// ── Decision mode (SB-FR-040) ──

export function selectMode(snapshot: DeliverySnapshot): DeliveryMode {
  return snapshot.mode;
}

// The Mode switch of the delivery's controls (SB-FR-032): the mode in effect,
// and the mode a switch asked for while it waits for the session (null when
// none waits). A switch waits while its `mode_switch` control is outstanding:
// the session's `mode.changed` that names its control_seq reads it back, and
// only then does the mode in effect change. With no switch in the outbox, the
// record's own pending mode stands. `pendingControlSeq` names the last
// outstanding switch, or null.
export interface ModeSwitchView {
  value: DeliveryModeValue;
  pending: DeliveryModeValue | null;
  pendingControlSeq: number | null;
}

export function selectModeSwitch(snapshot: DeliverySnapshot): ModeSwitchView {
  let waiting: { mode: DeliveryModeValue; controlSeq: number } | undefined;
  for (const control of snapshot.controls) {
    if (control.kind !== "mode_switch" || !isOutstandingControl(control)) continue;
    const mode = (control.body as { mode?: unknown }).mode;
    if (!isModeValue(mode)) continue;
    if (waiting === undefined || control.control_seq > waiting.controlSeq) {
      waiting = { mode, controlSeq: control.control_seq };
    }
  }
  const recordPending = snapshot.mode.pending;
  return {
    value: snapshot.mode.value,
    pending: waiting?.mode ?? (isModeValue(recordPending) ? recordPending : null),
    pendingControlSeq: waiting?.controlSeq ?? null,
  };
}

export function selectReview(snapshot: DeliverySnapshot): DeliveryReview {
  return snapshot.review;
}

// One card of the review stack: an agent decision the operator has not
// reviewed, or a provisional gate the operator has not confirmed. `at` is when
// the card arose (the decision's `decided_at`, else its `raised_at`; the gate's
// `provisionalAt`), and the stack is ordered by it, oldest first.
export type ReviewCard =
  | { kind: "decision"; id: string; at: string; decision: DeliveryDecision }
  | { kind: "gate"; id: string; at: string; gate: DeliveryGate; view: DeliveryGateView };

function cardTime(at: string): number {
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function decidedAt(decision: DeliveryDecision): string {
  return decision.decided_at ?? decision.raised_at;
}

// The review stack: every unreviewed agent decision and every unconfirmed
// provisional gate, oldest first. Two cards of one time keep snapshot order
// (decisions before gates).
export function selectReviewStack(snapshot: DeliverySnapshot): ReviewCard[] {
  const cards: ReviewCard[] = [];
  for (const decision of Object.values(snapshot.decisionsById)) {
    if (isUnreviewedAgentDecision(decision)) {
      cards.push({ kind: "decision", id: decision.id, at: decidedAt(decision), decision });
    }
  }
  for (const view of Object.values(snapshot.gatesById)) {
    if (isUnconfirmedProvisionalGate(view.gate)) {
      cards.push({
        kind: "gate",
        id: view.gate.id,
        at: view.provisionalAt ?? snapshot.staleness.updatedAt,
        gate: view.gate,
        view,
      });
    }
  }
  // Array.prototype.sort is stable, so equal times keep insertion order.
  return cards.sort((a, b) => cardTime(a.at) - cardTime(b.at));
}

// The agent decisions the operator has reviewed (accepted or overturned),
// oldest first by when they were decided. A reviewed card leaves the review
// stack, and this list keeps its outcome and summary in view.
export function selectReviewedAgentDecisions(snapshot: DeliverySnapshot): DeliveryDecision[] {
  return Object.values(snapshot.decisionsById)
    .filter(
      (decision) =>
        decision.author === AGENT_AUTHOR &&
        decision.review !== undefined &&
        decision.review.status !== "unreviewed",
    )
    .sort((a, b) => cardTime(decidedAt(a)) - cardTime(decidedAt(b)));
}

// Whether the operator can approve the delivery now (SB-FR-034). Approval is
// refused while a review is open, and the reason names the open review with
// the count of its cards. The approve route and the Approve control read the
// same answer, so the two never disagree.
export interface ApprovalAvailability {
  available: boolean;
  reason: string | null;
}

export function selectApprovalAvailability(snapshot: DeliverySnapshot): ApprovalAvailability {
  if (snapshot.review.status !== "open") return { available: true, reason: null };
  const count = selectReviewStack(snapshot).length;
  const cards = count === 1 ? "1 card" : `${count} cards`;
  return {
    available: false,
    reason: `A review is open with ${cards} to review: approve once the review is done`,
  };
}

// The gates whose gating cases are not all met, in record order: a gate whose
// evaluated state is not `passed`. A gate with no gating case holds nothing
// back. A `stale` gate (no plan, no results, or results for another plan)
// counts as unmet: nothing shows its cases met.
export function selectUnmetGates(snapshot: DeliverySnapshot): string[] {
  return Object.values(snapshot.gatesById)
    .filter((view) => view.state.status !== "passed" && view.state.status !== "no_gating_cases")
    .map((view) => view.gate.id);
}

// ── The cross-check's blocking policy (SB-FR-029) ──
//
// A disagreement of the last cross-check, as far as the policy reads it: its
// class and whether that class blocks. The server's cross-check sets
// `blocking` from its one table, in which branch-missing, head-commit-differs,
// pr-state-differs, gate-state-differs and plan-hash-mismatch block and
// layer-order-differs, base-branch-differs, case-status-differs and
// record-stale are shown only.
export interface CrossCheckPolicyEntry {
  class: string;
  blocking: boolean;
}

// The actions the cross-check blocks: a gate sitting and the approval. Pause,
// wind-down, resume, steering notes and decision answers are never blocked by
// it, so none of them is here.
export type CrossCheckBlockedAction = "sit" | "approve";

const CROSS_CHECK_BLOCKED_WORDS: Readonly<Record<CrossCheckBlockedAction, string>> = {
  sit: "a gate sitting",
  approve: "the approval",
};

export interface CrossCheckBlock {
  code: "CROSSCHECK_BLOCKED";
  reason: string;
  // The blocking classes present, each once, in the order the list gives them.
  classes: string[];
}

// The refusal of an action the cross-check blocks, or null when no blocking
// class is present. With no list (none read yet), nothing is blocked.
export function selectCrossCheckBlock(
  disagreements: readonly CrossCheckPolicyEntry[] | undefined,
  action: CrossCheckBlockedAction,
): CrossCheckBlock | null {
  const classes: string[] = [];
  for (const entry of disagreements ?? []) {
    if (entry.blocking && !classes.includes(entry.class)) classes.push(entry.class);
  }
  if (classes.length === 0) return null;
  const found =
    classes.length === 1
      ? `${classes[0]}, a blocking disagreement`
      : `${classes.join(", ")}, blocking disagreements`;
  return {
    code: "CROSSCHECK_BLOCKED",
    reason: `The cross-check finds ${found}, which blocks ${CROSS_CHECK_BLOCKED_WORDS[action]}: reconcile the delivery record with its source of truth first`,
    classes,
  };
}

// Why a gate sitting cannot open now, or null when it can: the lifecycle state
// first, as the approval reads it, then a blocking class of the cross-check.
export type SittingRefusal =
  { code: "WRONG_LIFECYCLE_STATE"; reason: string; state: string } | CrossCheckBlock;

export function selectSittingRefusal(
  snapshot: DeliverySnapshot,
  disagreements?: readonly CrossCheckPolicyEntry[],
): SittingRefusal | null {
  const lifecycle = selectLifecycleAction(snapshot, "sit");
  if (!lifecycle.available) {
    return {
      code: "WRONG_LIFECYCLE_STATE",
      reason: lifecycle.reason ?? "",
      state: lifecycle.state,
    };
  }
  return selectCrossCheckBlock(disagreements, "sit");
}

// Why the delivery cannot be approved now (SB-FR-022, SB-FR-029, SB-FR-034), or
// null when it can. The checks run in order and the first that refuses answers:
// the lifecycle state, then a blocking class of the last cross-check (when the
// caller passes its disagreements), then an open review, then an unmet gating
// case. A later check (an unconfirmed provisional mark) slots in as one more
// step. The approve route answers 409 with the refusal's `code`, and the
// Approve button reads the same refusal.
export type ApprovalRefusal =
  | { code: "WRONG_LIFECYCLE_STATE"; reason: string; state: string }
  | CrossCheckBlock
  | { code: "REVIEW_OPEN"; reason: string; unreviewed: string[] }
  | { code: "GATING_UNMET"; reason: string; gates: string[] };

export function selectApprovalRefusal(
  snapshot: DeliverySnapshot,
  disagreements?: readonly CrossCheckPolicyEntry[],
): ApprovalRefusal | null {
  const lifecycle = selectLifecycleAction(snapshot, "approve");
  if (!lifecycle.available) {
    return {
      code: "WRONG_LIFECYCLE_STATE",
      reason: lifecycle.reason ?? "",
      state: lifecycle.state,
    };
  }
  const blocked = selectCrossCheckBlock(disagreements, "approve");
  if (blocked !== null) return blocked;
  const review = selectApprovalAvailability(snapshot);
  if (!review.available) {
    return {
      code: "REVIEW_OPEN",
      reason: review.reason ?? "",
      unreviewed: snapshot.review.unreviewed,
    };
  }
  const gates = selectUnmetGates(snapshot);
  if (gates.length > 0) {
    return {
      code: "GATING_UNMET",
      reason: `A gating case is not met at ${gates.join(", ")}: approve once every gating case is met`,
      gates,
    };
  }
  return null;
}

// A decision's thread in stream order; empty for a decision with no thread or
// one the snapshot does not carry.
export function selectDecisionThread(
  snapshot: DeliverySnapshot,
  decisionId: string,
): DeliveryThreadMessage[] {
  return ownValue(snapshot.threadsByDecisionId, decisionId) ?? [];
}

// A gate's provisional marks, one per gating case the session judged; empty for
// a gate whose status is not `provisional` or that the snapshot does not carry.
export function selectProvisionalMarks(
  snapshot: DeliverySnapshot,
  gateId: string,
): ProvisionalCase[] {
  const view = ownValue(snapshot.gatesById, gateId);
  if (view === undefined || !isProvisionalGate(view.gate)) return [];
  return view.gate.provisionalCases ?? [];
}
