import type { DeliveryGate, DeliveryUnit } from "@roubo/shared/delivery-observation-contract";
import type { DeliveryGateView, DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  classifyUnitStatus,
  selectDependencyEdges,
  selectGateAnchors,
  selectUnitsInStackOrder,
} from "@roubo/shared/delivery-selectors";
import type { StatusTone } from "../ui/styles";

// The delivery map's model (SB-FR-010): what the graph and the list draw, worked
// out from the snapshot through the shared selectors. Pure, so the views stay
// thin and the layout can be tested without a browser.

export type DeliveryMapView = "graph" | "list";

export const DEFAULT_DELIVERY_MAP_VIEW: DeliveryMapView = "graph";

// ── Unit status ──

const UNIT_STATUS_TONES: Record<ReturnType<typeof classifyUnitStatus>, StatusTone> = {
  done: "active",
  running: "preparing",
  jammed: "error",
  pending: "idle",
  skipped: "idle",
  other: "idle",
};

export function unitStatusTone(unit: DeliveryUnit): StatusTone {
  return UNIT_STATUS_TONES[classifyUnitStatus(unit.status)];
}

export function isLiveUnit(unit: DeliveryUnit): boolean {
  return classifyUnitStatus(unit.status) === "running";
}

export function isDoneUnit(unit: DeliveryUnit): boolean {
  return classifyUnitStatus(unit.status) === "done";
}

// ── Gate state ──
//
// A gate's marker reads its record status word as one of these kinds. Each kind
// has one entry in GATE_MARKERS, which holds everything the marker draws for it:
// the label, the status dot's tone, and the marker's ground and border. A further
// state (the provisional gate of SB-FR-038, which DESIGN.md draws on the base
// ground with the default border) is one more member, one more entry and the
// words that map to it, with no change to the graph or the list.
export type GateMarkerKind = "pending" | "passed" | "failed";

export interface GateMarkerStyle {
  label: string;
  tone: StatusTone;
  // The marker's ground and its border when it is not selected.
  ground: string;
  border: string;
}

// DESIGN.md Unit node: a gate node swaps the ground to `danger-surface` and the
// border to `status-error`.
const GATE_NODE = { ground: "bg-danger-surface", border: "border-status-error" };

export const GATE_MARKERS: Record<GateMarkerKind, GateMarkerStyle> = {
  pending: { label: "pending", tone: "idle", ...GATE_NODE },
  passed: { label: "passed", tone: "active", ...GATE_NODE },
  failed: { label: "failed", tone: "error", ...GATE_NODE },
};

const GATE_STATUS_KINDS: ReadonlyMap<string, GateMarkerKind> = new Map([
  ["passed", "passed"],
  ["pass", "passed"],
  ["met", "passed"],
  ["green", "passed"],
  ["failed", "failed"],
  ["fail", "failed"],
  ["not_met", "failed"],
  ["escalated", "failed"],
  ["red", "failed"],
]);

// A status word the map does not know reads as pending: the gate has not passed.
export function classifyGateMarker(gate: DeliveryGate): GateMarkerKind {
  return GATE_STATUS_KINDS.get(gate.status.toLowerCase()) ?? "pending";
}

// ── Accessible names ──

export function unitAccessibleName(unit: DeliveryUnit): string {
  return `${unit.id} ${unit.title}, ${unit.status}, stack ${unit.stack}, layer ${unit.layer}`;
}

// A list row has no gate marker of its own, so its name also names its gates.
export function rowAccessibleName(unit: DeliveryUnit, gates: readonly DeliveryGateView[]): string {
  const named = gates.map(
    (view) => `gate ${view.gate.id} ${GATE_MARKERS[classifyGateMarker(view.gate)].label}`,
  );
  return [unitAccessibleName(unit), ...named].join(", ");
}

export function gateAccessibleName(gate: DeliveryGate): string {
  return `Gate ${gate.id}, ${GATE_MARKERS[classifyGateMarker(gate)].label}, after ${gate.after.join(", ")}`;
}

export function dependencyLine(dependencies: readonly string[]): string {
  return dependencies.length === 0 ? "no dependencies" : `after ${dependencies.join(", ")}`;
}

// A cycle as `selectDependencyOrder` names it: each unit depends on the next,
// and the last on the first.
export function cycleMessage(cycle: readonly string[]): string {
  const pairs = cycle.map((id, index) => `${id} depends on ${cycle[(index + 1) % cycle.length]}`);
  return `${pairs.join(", ")}.`;
}

// ── Selection ──

export type MapTarget = { kind: "unit"; id: string } | { kind: "gate"; id: string };

export function targetKey(target: MapTarget): string {
  return `${target.kind}:${target.id}`;
}

// ── Graph layout ──
//
// Lanes are stacks, columns are layers (DESIGN.md Unit node). A gate sits in
// the lane of the unit it follows, in the gap before the next layer.

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 92;
export const GATE_WIDTH = 120;
export const GATE_HEIGHT = 44;
const GAP = 20;
const LANE_GAP = 28;
const COLUMN_WIDTH = NODE_WIDTH + GAP + GATE_WIDTH + GAP;
const LANE_HEIGHT = NODE_HEIGHT + LANE_GAP;
const EDGE_BEND = 32;

export interface PlacedUnit {
  kind: "unit";
  key: string;
  unit: DeliveryUnit;
  dependencies: string[];
  x: number;
  y: number;
}

export interface PlacedGate {
  kind: "gate";
  key: string;
  view: DeliveryGateView;
  x: number;
  y: number;
}

export type PlacedItem = PlacedUnit | PlacedGate;

export interface PlacedEdge {
  key: string;
  // The keys of the two items the edge joins, `from` first.
  from: string;
  to: string;
  kind: "depends_on" | "gate";
  // True when the edge leaves a unit that is done.
  fromDone: boolean;
  path: string;
}

export interface DeliveryMapLayout {
  // Every unit and gate in dependency order: the focus order of the graph.
  items: PlacedItem[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} C ${x1 + EDGE_BEND} ${y1}, ${x2 - EDGE_BEND} ${y2}, ${x2} ${y2}`;
}

export function unitKey(id: string): string {
  return targetKey({ kind: "unit", id });
}

export function gateKey(id: string): string {
  return targetKey({ kind: "gate", id });
}

export function layoutDeliveryMap(
  snapshot: DeliverySnapshot,
  ordered: readonly DeliveryUnit[],
): DeliveryMapLayout {
  const lanes = new Map<string, number>();
  for (const unit of selectUnitsInStackOrder(snapshot)) {
    if (!lanes.has(unit.stack)) lanes.set(unit.stack, lanes.size);
  }

  const dependencyEdges = selectDependencyEdges(snapshot);
  const dependenciesOf = new Map<string, string[]>();
  for (const edge of dependencyEdges) {
    const list = dependenciesOf.get(edge.to) ?? [];
    if (!list.includes(edge.from)) list.push(edge.from);
    dependenciesOf.set(edge.to, list);
  }

  const anchors = selectGateAnchors(
    snapshot,
    ordered.map((unit) => unit.id),
  );
  const items: PlacedItem[] = [];
  const unitsByKey = new Map<string, PlacedUnit>();
  const gatesPlaced: PlacedGate[] = [];
  let maxLayer = 0;
  for (const unit of ordered) {
    const lane = lanes.get(unit.stack) ?? 0;
    const x = unit.layer * COLUMN_WIDTH;
    const y = lane * LANE_HEIGHT;
    maxLayer = Math.max(maxLayer, unit.layer);
    const placed: PlacedUnit = {
      kind: "unit",
      key: unitKey(unit.id),
      unit,
      dependencies: dependenciesOf.get(unit.id) ?? [],
      x,
      y,
    };
    items.push(placed);
    unitsByKey.set(placed.key, placed);
    (anchors.get(unit.id) ?? []).forEach((view, index) => {
      const gate: PlacedGate = {
        kind: "gate",
        key: gateKey(view.gate.id),
        view,
        x: x + NODE_WIDTH + GAP,
        y: y + (NODE_HEIGHT - GATE_HEIGHT) / 2 + index * (GATE_HEIGHT + 4),
      };
      items.push(gate);
      gatesPlaced.push(gate);
    });
  }

  const edges: PlacedEdge[] = [];
  for (const edge of dependencyEdges) {
    const from = unitsByKey.get(unitKey(edge.from));
    const to = unitsByKey.get(unitKey(edge.to));
    if (from === undefined || to === undefined) continue;
    const key = `${from.key}->${to.key}`;
    if (edges.some((existing) => existing.key === key)) continue;
    edges.push({
      key,
      from: from.key,
      to: to.key,
      kind: "depends_on",
      fromDone: isDoneUnit(from.unit),
      path: curve(from.x + NODE_WIDTH, from.y + NODE_HEIGHT / 2, to.x, to.y + NODE_HEIGHT / 2),
    });
  }
  for (const gate of gatesPlaced) {
    for (const id of gate.view.gate.after) {
      const from = unitsByKey.get(unitKey(id));
      if (from === undefined) continue;
      edges.push({
        key: `${gate.key}->${from.key}`,
        from: gate.key,
        to: from.key,
        kind: "gate",
        fromDone: false,
        path: curve(
          from.x + NODE_WIDTH,
          from.y + NODE_HEIGHT / 2,
          gate.x,
          gate.y + GATE_HEIGHT / 2,
        ),
      });
    }
  }

  const laneCount = Math.max(1, lanes.size);
  const gateBottom = gatesPlaced.reduce(
    (bottom, gate) => Math.max(bottom, gate.y + GATE_HEIGHT),
    0,
  );
  return {
    items,
    edges,
    width: (maxLayer + 1) * COLUMN_WIDTH,
    height: Math.max(laneCount * LANE_HEIGHT - LANE_GAP, gateBottom),
  };
}
