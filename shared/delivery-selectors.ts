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

import type {
  DeliveryDecision,
  DeliveryDrift,
  DeliveryGate,
  DeliveryMode,
  DeliveryReview,
  DeliverySteering,
  DeliveryUnit,
  ProvisionalCase,
} from "./delivery-observation-contract";
import {
  classifyUnitStatus,
  computeStaleness,
  isDecisionOpen,
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
  const fill =
    softBudgetUsd > 0 ? Math.min(1, spentUsd / softBudgetUsd) : spentUsd > 0 ? 1 : 0;
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
// jammed, else `stale` once the delivery has been quiet for 2 minutes, else
// `fresh`. `disconnected` is the stream's word, which a view that holds the
// stream state passes in.
export type DeliveryHealthWord = "fresh" | "stale" | "disconnected" | "blocked";

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
  options: { disconnected?: boolean } = {},
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
