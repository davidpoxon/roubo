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
// decision-mode selectors (SB-FR-040: the mode, the review stack, a decision's
// thread, a gate's provisional marks) are more functions over the same
// snapshot, at the end of the module.

import type {
  DeliveryDecision,
  DeliveryGate,
  DeliveryMode,
  DeliveryReview,
  DeliverySteering,
  DeliveryUnit,
  ProvisionalCase,
} from "./delivery-observation-contract";
import {
  classifyUnitStatus,
  isDecisionOpen,
  isUnconfirmedProvisionalGate,
  isUnreviewedAgentDecision,
  ownValue,
  type DeliveryGateView,
  type DeliveryProgress,
  type DeliverySnapshot,
  type DeliveryThreadMessage,
  type UnitStatusKind,
} from "./delivery-reducer";

export {
  classifyUnitStatus,
  isDecisionOpen,
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
// a gate that is not provisional or that the snapshot does not carry.
export function selectProvisionalMarks(
  snapshot: DeliverySnapshot,
  gateId: string,
): ProvisionalCase[] {
  const view = ownValue(snapshot.gatesById, gateId);
  if (view === undefined || view.gate.provisional !== true) return [];
  return view.gate.provisionalCases ?? [];
}
