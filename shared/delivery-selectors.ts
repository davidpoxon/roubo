// Selectors over a `DeliverySnapshot` (SB-FR-008, SB-FR-011): the readings every
// view takes, so the server summary and the client views agree on what a unit's
// status, a gate's state, the progress and the next boundary are. Each selector
// is a pure function of the snapshot; none reads a clock or fetches.
//
// Status words are open strings, read through `classifyUnitStatus` and
// `isDecisionOpen` from the reducer, each with an "other" fallback. The module
// is open to the later decision-mode selectors (mode, review stack, thread,
// provisional marks): they are more functions over the same snapshot.

import type {
  DeliveryDecision,
  DeliverySteering,
  DeliveryUnit,
} from "@roubo/shared/delivery-observation-contract";
import {
  classifyUnitStatus,
  isDecisionOpen,
  type DeliveryGateView,
  type DeliveryProgress,
  type DeliverySnapshot,
  type UnitStatusKind,
} from "@roubo/shared/delivery-reducer";

export { classifyUnitStatus, isDecisionOpen } from "@roubo/shared/delivery-reducer";

export interface UnitStatusView {
  // The record's own status word, or null for a unit the snapshot does not carry.
  status: string | null;
  kind: UnitStatusKind | null;
}

export function selectUnitStatus(snapshot: DeliverySnapshot, unitId: string): UnitStatusView {
  const unit = snapshot.unitsById[unitId];
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
  const unit = snapshot.unitsById[unitId];
  if (unit === undefined) {
    return null;
  }
  const members = snapshot.stacks[unit.stack] ?? [];
  return { stack: unit.stack, layer: unit.layer, members, index: members.indexOf(unitId) };
}

export function selectGateState(
  snapshot: DeliverySnapshot,
  gateId: string,
): DeliveryGateView | null {
  return snapshot.gatesById[gateId] ?? null;
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
      const unit = snapshot.unitsById[id];
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
