import type { DeliveryGate, DeliveryUnit } from "@roubo/shared/delivery-observation-contract";
import {
  gateProvisional,
  isProvisionalGate,
  ownValue,
  type DeliveryGateView,
  type DeliverySnapshot,
} from "@roubo/shared/delivery-reducer";
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

// A unit whose status word reads as jammed carries the jam mark on the map
// (SB-FR-019): the same reading as the snapshot's `jams`, so the mark, the
// health chip and the notification agree.
export function isJammedMapUnit(unit: DeliveryUnit): boolean {
  return classifyUnitStatus(unit.status) === "jammed";
}

export const JAM_MARK_LABEL = "jammed";

// ── Gate state ──
//
// A gate's marker reads its record status word as one of these kinds. Each kind
// has one entry in GATE_MARKERS, which holds everything the marker draws for it:
// the label, the status dot's tone, and the marker's ground and border.
export type GateMarkerKind = "pending" | "passed" | "failed" | "provisional";

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

// DESIGN.md Unit node: a provisional gate (SB-FR-038) keeps the base ground and
// the default border, and takes the `status-preparing` dot.
const PROVISIONAL_GATE_NODE = { ground: "bg-bg-base", border: "border-border-strong" };

export const GATE_MARKERS: Record<GateMarkerKind, GateMarkerStyle> = {
  pending: { label: "pending", tone: "idle", ...GATE_NODE },
  passed: { label: "passed", tone: "active", ...GATE_NODE },
  failed: { label: "failed", tone: "error", ...GATE_NODE },
  provisional: { label: "provisional", tone: "preparing", ...PROVISIONAL_GATE_NODE },
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
// A gate whose status word is `provisional` reads as provisional, the one key of
// that state the contract defines.
export function classifyGateMarker(gate: DeliveryGate): GateMarkerKind {
  if (isProvisionalGate(gate)) return "provisional";
  return GATE_STATUS_KINDS.get(gate.status.toLowerCase()) ?? "pending";
}

// The count of a gate's provisional marks the operator has not confirmed yet.
export function gateUnconfirmedCount(gate: DeliveryGate): number {
  return gateProvisional(gate).unconfirmed.length;
}

// The count still to confirm, as the provisional gate's badge reads it.
export function toConfirmText(count: number): string {
  return `${count} to confirm`;
}

// The words a gate's marker reads as: its state's label, and for a provisional
// gate the count still to confirm beside it (DESIGN.md Unit node).
export function gateMarkerLabel(gate: DeliveryGate): string {
  const kind = classifyGateMarker(gate);
  const label = GATE_MARKERS[kind].label;
  return kind === "provisional" ? `${label} · ${toConfirmText(gateUnconfirmedCount(gate))}` : label;
}

// What a list row's gate badge reads after the gate id: the count still to
// confirm for a provisional gate (DESIGN.md Unit row), else the state's label.
export function gateBadgeText(gate: DeliveryGate): string {
  return classifyGateMarker(gate) === "provisional"
    ? toConfirmText(gateUnconfirmedCount(gate))
    : GATE_MARKERS[classifyGateMarker(gate)].label;
}

// ── Held pull requests ──
//
// A provisional gate holds the pull requests of the units above it as drafts
// (SB-FR-038): each unit after the gate's `after` units on their stack reads
// `draft · held` on its pull request until the gate leaves the provisional
// state.
export const HELD_DRAFT_LABEL = "draft · held";

export function selectHeldUnitIds(snapshot: DeliverySnapshot): Set<string> {
  const held = new Set<string>();
  for (const view of Object.values(snapshot.gatesById)) {
    if (!isProvisionalGate(view.gate)) continue;
    for (const id of view.gate.after) {
      const unit = ownValue(snapshot.unitsById, id);
      if (unit === undefined) continue;
      const stack = ownValue(snapshot.stacks, unit.stack) ?? [];
      const index = stack.indexOf(id);
      if (index < 0) continue;
      for (const above of stack.slice(index + 1)) held.add(above);
    }
  }
  return held;
}

// ── Accessible names ──

// A jammed unit whose status word is not `jammed` itself (`blocked`, `stuck`,
// ...) also names the jam, so the mark reaches the screen reader.
export function unitAccessibleName(unit: DeliveryUnit, held = false): string {
  const jam =
    isJammedMapUnit(unit) && unit.status.toLowerCase() !== JAM_MARK_LABEL
      ? `, ${JAM_MARK_LABEL}`
      : "";
  const pr = held ? `, pull request ${HELD_DRAFT_LABEL}` : "";
  return `${unit.id} ${unit.title}, ${unit.status}${jam}${pr}, stack ${unit.stack}, layer ${unit.layer}`;
}

// A list row has no gate marker of its own, so its name also names its gates.
export function rowAccessibleName(
  unit: DeliveryUnit,
  gates: readonly DeliveryGateView[],
  held = false,
): string {
  const named = gates.map((view) => `gate ${view.gate.id} ${gateMarkerLabel(view.gate)}`);
  return [unitAccessibleName(unit, held), ...named].join(", ");
}

export function gateAccessibleName(gate: DeliveryGate): string {
  return `Gate ${gate.id}, ${gateMarkerLabel(gate)}, after ${gate.after.join(", ")}`;
}

// What a gate marker shows under the pointer or keyboard focus (SB-FR-010,
// SB-TC-026): its state and the count of the cases it gates, read from the
// gate's narrowed gating set, the same set the progress counts.
export function gateHoverLine(view: DeliveryGateView): string {
  const count = view.state.gatingCaseIds.length;
  const label = gateMarkerLabel(view.gate);
  return `${label} · ${count} ${count === 1 ? "case" : "cases"} gated`;
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
// Lanes are stacks, columns are layers (DESIGN.md Unit node). Units that share
// a stack and a layer go one above the other in that lane's cell, and the lane
// grows to fit them. The gates sit in a gate lane below the stacks, each in the
// column after the last layer of the units it follows. Positions are on the
// canvas of nodes; the view draws the lane labels and layer headers beside it.

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 80;
export const GATE_WIDTH = NODE_WIDTH;
export const GATE_HEIGHT = 52;
const COLUMN_GAP = 40;
const LANE_GAP = 20;
const CELL_GAP = 8;
// The space between the last stack lane and the gate lane; the dashed hairline
// that opens the gate lane sits halfway across it.
const GATE_LANE_GAP = 32;
const COLUMN_WIDTH = NODE_WIDTH + COLUMN_GAP;
const EDGE_BEND = 20;

export interface PlacedUnit {
  kind: "unit";
  key: string;
  unit: DeliveryUnit;
  dependencies: string[];
  // True while a provisional gate below the unit holds its pull request.
  held: boolean;
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

// One stack lane: its stack id, how many units it holds, and where it runs.
export interface PlacedLane {
  stack: string;
  unitCount: number;
  top: number;
  height: number;
}

// One layer column: its layer number and where it starts.
export interface PlacedColumn {
  layer: number;
  left: number;
}

export interface DeliveryMapLayout {
  // Every unit and gate in dependency order: the focus order of the graph.
  items: PlacedItem[];
  edges: PlacedEdge[];
  lanes: PlacedLane[];
  columns: PlacedColumn[];
  // The gate lane, below the stacks, or null when the delivery has no gate.
  // `ruleTop` is where the dashed hairline that opens it runs.
  gateLane: { top: number; height: number; ruleTop: number; gateCount: number } | null;
  columnWidth: number;
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

// ── A cross-check disagreement on the map (SB-FR-029) ──

// The map keys a cross-check disagreement points at, the one to focus first:
// a gate (gate-state-differs and case-status-differs name it as `unitId`), then
// the units it follows, for the list view, which has no gate row; a unit; or
// the units of a stack, base first (layer-order-differs). Empty for one about
// the whole delivery (plan-hash-mismatch) or about nothing the record holds.
export function crossCheckMapKeys(
  disagreement: { unitId?: string | undefined; stack?: string | undefined },
  snapshot: DeliverySnapshot,
): string[] {
  const { unitId, stack } = disagreement;
  if (unitId !== undefined) {
    const gate = ownValue(snapshot.gatesById, unitId);
    if (gate !== undefined) {
      return [gateKey(unitId), ...gate.gate.after.map((id) => unitKey(id))];
    }
    if (ownValue(snapshot.unitsById, unitId) !== undefined) return [unitKey(unitId)];
  }
  if (stack !== undefined) {
    return (ownValue(snapshot.stacks, stack) ?? []).map((id) => unitKey(id));
  }
  return [];
}

// A request to focus one map target: the keys to try in order, and a count
// that makes each request new, so the same target can be asked for twice.
// `open` also opens that target's drill-in, which then takes the focus.
export interface MapFocusRequest {
  keys: string[];
  nonce: number;
  open?: MapTarget;
}

export function layoutDeliveryMap(
  snapshot: DeliverySnapshot,
  ordered: readonly DeliveryUnit[],
): DeliveryMapLayout {
  const stackOrder: string[] = [];
  for (const unit of selectUnitsInStackOrder(snapshot)) {
    if (!stackOrder.includes(unit.stack)) stackOrder.push(unit.stack);
  }
  for (const unit of ordered) {
    if (!stackOrder.includes(unit.stack)) stackOrder.push(unit.stack);
  }

  const dependencyEdges = selectDependencyEdges(snapshot);
  const dependenciesOf = new Map<string, string[]>();
  for (const edge of dependencyEdges) {
    const list = dependenciesOf.get(edge.to) ?? [];
    if (!list.includes(edge.from)) list.push(edge.from);
    dependenciesOf.set(edge.to, list);
  }

  const held = selectHeldUnitIds(snapshot);
  const anchors = selectGateAnchors(
    snapshot,
    ordered.map((unit) => unit.id),
  );

  // Each unit's place in its cell, in dependency order, and each lane's rows:
  // the most units any one of its cells holds.
  const minLayer = ordered.reduce((low, unit) => Math.min(low, unit.layer), Infinity);
  const firstLayer = Number.isFinite(minLayer) ? minLayer : 0;
  const cellIndex = new Map<string, number>();
  const cellCounts = new Map<string, number>();
  const laneRows = new Map<string, number>();
  const laneUnits = new Map<string, number>();
  for (const unit of ordered) {
    const cell = `${unit.stack}\u0000${String(unit.layer)}`;
    const index = cellCounts.get(cell) ?? 0;
    cellIndex.set(unit.id, index);
    cellCounts.set(cell, index + 1);
    laneRows.set(unit.stack, Math.max(laneRows.get(unit.stack) ?? 0, index + 1));
    laneUnits.set(unit.stack, (laneUnits.get(unit.stack) ?? 0) + 1);
  }
  const lanes: PlacedLane[] = [];
  let laneTop = 0;
  for (const stack of stackOrder) {
    const rows = Math.max(1, laneRows.get(stack) ?? 0);
    const height = rows * NODE_HEIGHT + (rows - 1) * CELL_GAP;
    lanes.push({ stack, unitCount: laneUnits.get(stack) ?? 0, top: laneTop, height });
    laneTop += height + LANE_GAP;
  }
  const lanesBottom = Math.max(0, laneTop - LANE_GAP);
  const laneByStack = new Map(lanes.map((lane) => [lane.stack, lane]));

  const columnLeft = (layer: number) => (layer - firstLayer) * COLUMN_WIDTH;
  const items: PlacedItem[] = [];
  const unitsByKey = new Map<string, PlacedUnit>();
  const unitById = new Map(ordered.map((unit) => [unit.id, unit]));
  const gatesPlaced: PlacedGate[] = [];
  const gateColumnCounts = new Map<number, number>();
  const gateLaneTop = lanesBottom + GATE_LANE_GAP;
  let maxLayer = firstLayer;
  let gateRows = 0;
  for (const unit of ordered) {
    const lane = laneByStack.get(unit.stack);
    const x = columnLeft(unit.layer);
    const y = (lane?.top ?? 0) + (cellIndex.get(unit.id) ?? 0) * (NODE_HEIGHT + CELL_GAP);
    maxLayer = Math.max(maxLayer, unit.layer);
    const placed: PlacedUnit = {
      kind: "unit",
      key: unitKey(unit.id),
      unit,
      dependencies: dependenciesOf.get(unit.id) ?? [],
      held: held.has(unit.id),
      x,
      y,
    };
    items.push(placed);
    unitsByKey.set(placed.key, placed);
    for (const view of anchors.get(unit.id) ?? []) {
      // The column after the last layer of the units the gate follows.
      const afterLayer = view.gate.after.reduce(
        (high, id) => Math.max(high, unitById.get(id)?.layer ?? unit.layer),
        unit.layer,
      );
      const layer = afterLayer + 1;
      const row = gateColumnCounts.get(layer) ?? 0;
      gateColumnCounts.set(layer, row + 1);
      gateRows = Math.max(gateRows, row + 1);
      maxLayer = Math.max(maxLayer, layer);
      const gate: PlacedGate = {
        kind: "gate",
        key: gateKey(view.gate.id),
        view,
        x: columnLeft(layer),
        y: gateLaneTop + row * (GATE_HEIGHT + CELL_GAP),
      };
      items.push(gate);
      gatesPlaced.push(gate);
    }
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

  const columns: PlacedColumn[] = [];
  for (let layer = firstLayer; layer <= maxLayer; layer += 1) {
    columns.push({ layer, left: columnLeft(layer) });
  }
  const gateLane =
    gatesPlaced.length === 0
      ? null
      : {
          top: gateLaneTop,
          height: gateRows * GATE_HEIGHT + (gateRows - 1) * CELL_GAP,
          ruleTop: lanesBottom + GATE_LANE_GAP / 2,
          gateCount: gatesPlaced.length,
        };
  return {
    items,
    edges,
    lanes,
    columns,
    gateLane,
    columnWidth: COLUMN_WIDTH,
    width: columns.length * COLUMN_WIDTH - COLUMN_GAP,
    height: gateLane === null ? lanesBottom : gateLane.top + gateLane.height,
  };
}
