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
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
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

// The pull request a unit node names in its head: the number of the pull
// request its \`pr_url\` links, or null when it has none or the url names no
// pull request number.
export function pullRequestNumber(unit: DeliveryUnit): string | null {
  const match = unit.pr_url === undefined ? null : /\/pull\/(\d+)(?:[/?#]|$)/.exec(unit.pr_url);
  return match?.[1] === undefined ? null : `#${match[1]}`;
}

// A unit's spend as the map and the drill-in name it.
export function unitCostLabel(costUsd: number): string {
  return `USD ${costUsd.toFixed(2)}`;
}

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
// The graph is laid out by a force simulation (#1656, DESIGN.md Unit node):
// each `depends_on` edge and each gate's link to the units it follows pulls
// its two ends together, every node pushes the others away, the units of a
// stack are drawn to one another, and no two nodes overlap. A pull toward the
// middle, weighted by the shape of the map's viewport, gives the graph the
// shape of the space it is drawn in. The simulation runs to rest in one go,
// with no animation, from start positions worked out from the stacks and the
// layers, so the same delivery and viewport shape always give the same layout.
//
// Two steps: `simulateDeliveryGraph` places the nodes from the shape of the
// delivery alone (its units, their stacks, layers and dependencies, and its
// gates), so a change of status moves nothing; `placeDeliveryGraph` then lays
// the snapshot's units and gates on those places and works out the edges and
// the outline of each stack.
//
// Positions out of the simulation are node centres in graph space. The layout
// moves them onto a canvas whose top left is the origin, and keeps the offset
// (`origin`) so the view can turn a canvas point back into graph space, as a
// node drag does.

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 80;
export const GATE_WIDTH = NODE_WIDTH;
export const GATE_HEIGHT = 52;
// The least space between two nodes.
const NODE_GAP = 24;
// The length the edges pull toward.
const LINK_DISTANCE = NODE_WIDTH + 64;
// The start grid: the units run along its rows, back and forth, with room
// under each unit for a gate.
const START_COLUMN = NODE_WIDTH + 72;
const START_ROW = NODE_HEIGHT + GATE_HEIGHT + 3 * NODE_GAP;
const TICKS = 300;
// A layout that starts from kept positions only settles: it starts cooler.
const SETTLE_ALPHA = 0.3;
// The room a stack's outline leaves around its units, more at the top for its
// label.
const HULL_PAD = 12;
const HULL_PAD_TOP = 28;
// Room around the canvas so a focus ring at its edge shows.
const CANVAS_PAD = 8;
// Room below a gate for its hover line.
const GATE_HOVER_ROOM = 32;
// The arrowhead at the end of an edge.
const ARROW_LENGTH = 8;
const ARROW_HALF_WIDTH = 4;
// The viewport shapes the layout tells apart, as width over height.
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 4;
export const DEFAULT_GRAPH_ASPECT = 1.6;

export interface GraphPoint {
  x: number;
  y: number;
}

export interface PlacedUnit {
  kind: "unit";
  key: string;
  unit: DeliveryUnit;
  dependencies: string[];
  // True while a provisional gate below the unit holds its pull request.
  held: boolean;
  // The top left of the node on the canvas.
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
  // The keys of the two items the edge joins, `from` first. A `depends_on`
  // edge runs from the dependency to the unit that depends on it; a gate edge
  // from the gate to a unit it follows, and is drawn from that unit to the
  // gate.
  from: string;
  to: string;
  kind: "depends_on" | "gate";
  // True when the edge leaves a unit that is done.
  fromDone: boolean;
  // A straight line between the borders of the two nodes, and the arrowhead
  // at the end it points to.
  path: string;
  arrow: string;
}

// The outline of one stack: a rounded hull around its units, and where its
// label starts.
export interface PlacedHull {
  stack: string;
  unitCount: number;
  path: string;
  labelX: number;
  labelY: number;
}

export interface DeliveryMapLayout {
  // Every unit and gate in dependency order: the focus order of the graph.
  items: PlacedItem[];
  edges: PlacedEdge[];
  hulls: PlacedHull[];
  // Graph space minus canvas space.
  origin: GraphPoint;
  width: number;
  height: number;
}

// The shape of a delivery that the layout reads: nothing that changes when a
// unit or a gate changes status.
export interface GraphTopology {
  units: { key: string; stack: string; layer: number; dependsOn: string[] }[];
  gates: { key: string; after: string[] }[];
}

// What a node drag keeps for a bench: where every node was when the operator
// dropped one, and which nodes the operator placed. Keys are map keys.
export interface KeptGraphLayout {
  positions: Record<string, GraphPoint>;
  pinned: string[];
}

export function unitKey(id: string): string {
  return targetKey({ kind: "unit", id });
}

export function gateKey(id: string): string {
  return targetKey({ kind: "gate", id });
}

// The shape of the delivery, units in dependency order and each gate after
// the unit it is anchored to.
export function selectGraphTopology(
  snapshot: DeliverySnapshot,
  ordered: readonly DeliveryUnit[],
): GraphTopology {
  const known = new Set(ordered.map((unit) => unit.id));
  const dependsOn = new Map<string, string[]>();
  for (const edge of selectDependencyEdges(snapshot)) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    const list = dependsOn.get(edge.to) ?? [];
    const key = unitKey(edge.from);
    if (!list.includes(key)) list.push(key);
    dependsOn.set(edge.to, list);
  }
  const anchors = selectGateAnchors(
    snapshot,
    ordered.map((unit) => unit.id),
  );
  const units: GraphTopology["units"] = [];
  const gates: GraphTopology["gates"] = [];
  for (const unit of ordered) {
    units.push({
      key: unitKey(unit.id),
      stack: unit.stack,
      layer: unit.layer,
      dependsOn: dependsOn.get(unit.id) ?? [],
    });
    for (const view of anchors.get(unit.id) ?? []) {
      gates.push({
        key: gateKey(view.gate.id),
        after: view.gate.after.filter((id) => known.has(id)).map((id) => unitKey(id)),
      });
    }
  }
  return { units, gates };
}

// A string that is the same for two topologies exactly when they lay out the
// same, to key a memo on.
export function graphTopologyKey(topology: GraphTopology): string {
  return JSON.stringify(topology);
}

// The viewport's shape, clamped and rounded to a quarter step of its log, so
// a small resize does not lay the graph out again.
export function graphAspectBucket(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return DEFAULT_GRAPH_ASPECT;
  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, width / height));
  return 2 ** (Math.round(Math.log2(aspect) * 4) / 4);
}

interface SimNode extends SimulationNodeDatum {
  key: string;
  width: number;
  height: number;
  stack: string | null;
}

// A seeded random source, so the simulation's jiggle is the same every run.
function seededRandom(): () => number {
  let state = 0x2545f491;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Pushes apart any two nodes whose boxes, grown by the gap, overlap, along
// the axis that overlaps less. `strength` is the share of the overlap that one
// call removes. A fixed node does not move; the other one takes the push.
function separate(nodes: readonly SimNode[], strength: number, onVelocity: boolean): void {
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      if (b === undefined) continue;
      const ax = a.x ?? 0;
      const ay = a.y ?? 0;
      const bx = b.x ?? 0;
      const by = b.y ?? 0;
      const dx = bx - ax;
      const dy = by - ay;
      const overlapX = (a.width + b.width) / 2 + NODE_GAP - Math.abs(dx);
      const overlapY = (a.height + b.height) / 2 + NODE_GAP - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      const aFixed = a.fx !== undefined && a.fx !== null;
      const bFixed = b.fx !== undefined && b.fx !== null;
      if (aFixed && bFixed) continue;
      const shareA = aFixed ? 0 : bFixed ? 1 : 0.5;
      const shareB = 1 - shareA;
      // Along x when the boxes overlap less that way, else along y; a tie of
      // centres is broken by the order of the nodes.
      const alongX = overlapX < overlapY;
      const sign = (alongX ? dx : dy) > 0 ? 1 : (alongX ? dx : dy) < 0 ? -1 : i % 2 === 0 ? 1 : -1;
      const push = (alongX ? overlapX : overlapY) * strength * sign;
      const axis = alongX ? "x" : "y";
      if (onVelocity) {
        const velocity = alongX ? "vx" : "vy";
        a[velocity] = (a[velocity] ?? 0) - push * shareA;
        b[velocity] = (b[velocity] ?? 0) + push * shareB;
      } else {
        a[axis] = (a[axis] ?? 0) - push * shareA;
        b[axis] = (b[axis] ?? 0) + push * shareB;
      }
    }
  }
}

function rectangleCollision(): Force<SimNode, undefined> {
  let nodes: SimNode[] = [];
  const force = () => {
    separate(nodes, 0.5, true);
  };
  force.initialize = (next: SimNode[]) => {
    nodes = next;
  };
  return force;
}

// Draws each unit toward the middle of its stack.
function stackCohesion(strength: number): Force<SimNode, undefined> {
  let nodes: SimNode[] = [];
  const force = (alpha: number) => {
    const sums = new Map<string, { x: number; y: number; count: number }>();
    for (const node of nodes) {
      if (node.stack === null) continue;
      const sum = sums.get(node.stack) ?? { x: 0, y: 0, count: 0 };
      sum.x += node.x ?? 0;
      sum.y += node.y ?? 0;
      sum.count += 1;
      sums.set(node.stack, sum);
    }
    for (const node of nodes) {
      if (node.stack === null) continue;
      const sum = sums.get(node.stack);
      if (sum === undefined || sum.count < 2) continue;
      node.vx = (node.vx ?? 0) + (sum.x / sum.count - (node.x ?? 0)) * strength * alpha;
      node.vy = (node.vy ?? 0) + (sum.y / sum.count - (node.y ?? 0)) * strength * alpha;
    }
  };
  force.initialize = (next: SimNode[]) => {
    nodes = next;
  };
  return force;
}

// The stacks in the order the start lays them out: each stack as soon as the
// stacks it depends on are laid, so a stack that follows another starts where
// that one ends, else in the order the stacks first appear.
function stackOrder(topology: GraphTopology): string[] {
  const stackOf = new Map(topology.units.map((unit) => [unit.key, unit.stack]));
  const first: string[] = [];
  const needs = new Map<string, Set<string>>();
  for (const unit of topology.units) {
    if (!needs.has(unit.stack)) {
      first.push(unit.stack);
      needs.set(unit.stack, new Set());
    }
    for (const key of unit.dependsOn) {
      const other = stackOf.get(key);
      if (other !== undefined && other !== unit.stack) needs.get(unit.stack)?.add(other);
    }
  }
  const order: string[] = [];
  const placed = new Set<string>();
  const place = (stack: string) => {
    if (placed.has(stack)) return;
    placed.add(stack);
    order.push(stack);
    // Then every stack that now has all it depends on and depends on this one.
    for (const next of first) {
      const wanted = needs.get(next);
      if (placed.has(next) || wanted === undefined || !wanted.has(stack)) continue;
      if ([...wanted].every((other) => placed.has(other))) place(next);
    }
  };
  for (const stack of first) {
    const wanted = needs.get(stack);
    if (wanted === undefined || [...wanted].every((other) => placed.has(other))) place(stack);
  }
  // A stack whose stacks depend on each other in a loop goes last.
  for (const stack of first) place(stack);
  return order;
}

// Where the simulation starts each node, centred on the origin: the units of
// each stack in layer order along the rows of a grid shaped like the
// viewport, left to right and then back, so a chain of units starts as a
// line that folds instead of a tangle. A stack that does not fit in what is
// left of a row starts a new one, so the outlines of two stacks do not cross.
// Each gate starts under the last unit it follows.
function seedPositions(topology: GraphTopology, aspect: number): Map<string, GraphPoint> {
  const byStack = new Map<string, GraphTopology["units"]>();
  for (const unit of topology.units) {
    const list = byStack.get(unit.stack) ?? [];
    list.push(unit);
    byStack.set(unit.stack, list);
  }
  const count = Math.max(1, topology.units.length);
  const columns = Math.max(
    1,
    Math.min(count, Math.round(Math.sqrt((count * aspect * START_ROW) / START_COLUMN))),
  );
  const seeds = new Map<string, GraphPoint>();
  let row = 0;
  let column = 0;
  for (const stack of stackOrder(topology)) {
    const units = [...(byStack.get(stack) ?? [])].sort((a, b) => a.layer - b.layer);
    if (column > 0 && column + units.length > columns) {
      row += 1;
      column = 0;
    }
    for (const unit of units) {
      if (column === columns) {
        row += 1;
        column = 0;
      }
      const across = row % 2 === 0 ? column : columns - 1 - column;
      seeds.set(unit.key, { x: across * START_COLUMN, y: row * START_ROW });
      column += 1;
    }
  }
  for (const gate of topology.gates) {
    const anchor = gate.after
      .map((key) => seeds.get(key))
      .filter((at): at is GraphPoint => at !== undefined)
      .reduce<GraphPoint | undefined>(
        (last, at) =>
          last === undefined || at.y > last.y || (at.y === last.y && at.x > last.x) ? at : last,
        undefined,
      );
    const at = anchor ?? { x: 0, y: (row + 1) * START_ROW };
    seeds.set(gate.key, { x: at.x, y: at.y + (NODE_HEIGHT + GATE_HEIGHT) / 2 + NODE_GAP });
  }
  // Two gates under one unit start one beside the other.
  const taken = new Map<string, number>();
  for (const gate of topology.gates) {
    const at = seeds.get(gate.key);
    if (at === undefined) continue;
    const spot = `${String(at.x)},${String(at.y)}`;
    const before = taken.get(spot) ?? 0;
    taken.set(spot, before + 1);
    if (before > 0)
      seeds.set(gate.key, { x: at.x + before * (GATE_WIDTH / 2), y: at.y + before * NODE_GAP });
  }
  const points = [...seeds.values()];
  const middle = {
    x: points.reduce((sum, at) => sum + at.x, 0) / Math.max(1, points.length),
    y: points.reduce((sum, at) => sum + at.y, 0) / Math.max(1, points.length),
  };
  for (const [key, at] of seeds) seeds.set(key, { x: at.x - middle.x, y: at.y - middle.y });
  return seeds;
}

// Places every unit and gate of a delivery: node centres in graph space, by
// map key. `kept` holds the positions a node drag kept: the simulation then
// starts from them and only settles, the pinned nodes stay where they are,
// and a node the kept layout does not know starts beside the nodes it links.
export function simulateDeliveryGraph(
  topology: GraphTopology,
  options: { aspect?: number; kept?: KeptGraphLayout | undefined } = {},
): Map<string, GraphPoint> {
  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, options.aspect ?? DEFAULT_GRAPH_ASPECT));
  const kept = options.kept;
  const pinned = new Set(kept?.pinned ?? []);
  const nodes: SimNode[] = [];
  const byKey = new Map<string, SimNode>();
  const keptAt = (key: string): GraphPoint | undefined =>
    kept !== undefined && Object.hasOwn(kept.positions, key) ? kept.positions[key] : undefined;
  const seeds = seedPositions(topology, aspect);
  for (const unit of topology.units) {
    const at = seeds.get(unit.key) ?? { x: 0, y: 0 };
    const node: SimNode = {
      key: unit.key,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      stack: unit.stack,
      ...at,
    };
    nodes.push(node);
    byKey.set(unit.key, node);
  }
  for (const gate of topology.gates) {
    const at = seeds.get(gate.key) ?? { x: 0, y: 0 };
    const node: SimNode = {
      key: gate.key,
      width: GATE_WIDTH,
      height: GATE_HEIGHT,
      stack: null,
      ...at,
    };
    nodes.push(node);
    byKey.set(gate.key, node);
  }

  const links: SimulationLinkDatum<SimNode>[] = [];
  for (const unit of topology.units) {
    for (const from of unit.dependsOn) {
      if (byKey.has(from)) links.push({ source: from, target: unit.key });
    }
  }
  for (const gate of topology.gates) {
    for (const key of gate.after) {
      if (byKey.has(key)) links.push({ source: key, target: gate.key });
    }
  }

  // Put back what the kept layout holds, and start any node it does not hold
  // beside its linked nodes.
  let keptCount = 0;
  if (kept !== undefined) {
    for (const node of nodes) {
      const at = keptAt(node.key);
      if (at === undefined) continue;
      node.x = at.x;
      node.y = at.y;
      keptCount += 1;
      if (pinned.has(node.key)) {
        node.fx = at.x;
        node.fy = at.y;
      }
    }
    for (const node of nodes) {
      if (keptAt(node.key) !== undefined) continue;
      const neighbours = links.flatMap((link) => {
        const other =
          link.source === node.key ? link.target : link.target === node.key ? link.source : null;
        const at = typeof other === "string" ? keptAt(other) : undefined;
        return at === undefined ? [] : [at];
      });
      if (neighbours.length === 0) continue;
      node.x =
        neighbours.reduce((sum, at) => sum + at.x, 0) / neighbours.length + LINK_DISTANCE / 2;
      node.y = neighbours.reduce((sum, at) => sum + at.y, 0) / neighbours.length;
    }
  }

  // A wide viewport pulls harder toward the middle line across it than along
  // it, so the graph keeps the shape the start gave it.
  const pull = 0.02;
  const simulation = forceSimulation<SimNode>(nodes)
    .randomSource(seededRandom())
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((node) => node.key)
        .distance(LINK_DISTANCE),
    )
    .force(
      "charge",
      forceManyBody<SimNode>()
        .strength(-500)
        .distanceMax(LINK_DISTANCE * 4),
    )
    .force("x", forceX<SimNode>(0).strength(pull / aspect))
    .force("y", forceY<SimNode>(0).strength(pull * aspect))
    .force("stack", stackCohesion(0.02))
    .force("collide", rectangleCollision())
    .stop();
  if (keptCount > 0 && keptCount === nodes.length) simulation.alpha(SETTLE_ALPHA);
  simulation.tick(TICKS);
  // Whatever overlap the forces left, take out.
  for (let pass = 0; pass < 50; pass += 1) separate(nodes, 1, false);

  return new Map(nodes.map((node) => [node.key, { x: node.x ?? 0, y: node.y ?? 0 }]));
}

// Where the segment from a box's centre toward a point leaves the box.
function borderPoint(
  centre: GraphPoint,
  halfWidth: number,
  halfHeight: number,
  toward: GraphPoint,
): GraphPoint {
  const dx = toward.x - centre.x;
  const dy = toward.y - centre.y;
  if (dx === 0 && dy === 0) return centre;
  const scale = Math.min(
    dx === 0 ? Infinity : halfWidth / Math.abs(dx),
    dy === 0 ? Infinity : halfHeight / Math.abs(dy),
  );
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// A straight edge between the borders of two boxes, and the arrowhead whose
// tip sits on the border of the second.
function edgeGeometry(
  from: { centre: GraphPoint; width: number; height: number },
  to: { centre: GraphPoint; width: number; height: number },
): { path: string; arrow: string } {
  const start = borderPoint(from.centre, from.width / 2, from.height / 2, to.centre);
  const tip = borderPoint(to.centre, to.width / 2, to.height / 2, from.centre);
  const dx = tip.x - start.x;
  const dy = tip.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const base = { x: tip.x - ux * ARROW_LENGTH, y: tip.y - uy * ARROW_LENGTH };
  const left = { x: base.x - uy * ARROW_HALF_WIDTH, y: base.y + ux * ARROW_HALF_WIDTH };
  const right = { x: base.x + uy * ARROW_HALF_WIDTH, y: base.y - ux * ARROW_HALF_WIDTH };
  return {
    path: `M ${round(start.x)} ${round(start.y)} L ${round(base.x)} ${round(base.y)}`,
    arrow: `M ${round(tip.x)} ${round(tip.y)} L ${round(left.x)} ${round(left.y)} L ${round(right.x)} ${round(right.y)} Z`,
  };
}

// The convex hull of a set of points (Andrew's monotone chain), clockwise on
// screen.
function convexHull(points: readonly GraphPoint[]): GraphPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  // True while the last two points of the chain and the next one do not turn
  // the hull's way, so the last point is not a corner.
  const notACorner = (chain: GraphPoint[], point: GraphPoint) => {
    const a = chain.at(-2);
    const b = chain.at(-1);
    if (a === undefined || b === undefined) return false;
    return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) <= 0;
  };
  const lower: GraphPoint[] = [];
  for (const point of sorted) {
    while (notACorner(lower, point)) lower.pop();
    lower.push(point);
  }
  const upper: GraphPoint[] = [];
  for (const point of [...sorted].reverse()) {
    while (notACorner(upper, point)) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// Lays the snapshot's units and gates on the places the simulation gave them.
// A unit or a gate with no place (the topology changed since) goes to the
// right of the rest.
export function placeDeliveryGraph(
  snapshot: DeliverySnapshot,
  ordered: readonly DeliveryUnit[],
  positions: ReadonlyMap<string, GraphPoint>,
): DeliveryMapLayout {
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

  const known = [...positions.values()];
  let spareX = known.reduce((high, at) => Math.max(high, at.x), 0) + LINK_DISTANCE;
  const centreOf = (key: string): GraphPoint => {
    const at = positions.get(key);
    if (at !== undefined) return at;
    const spare = { x: spareX, y: 0 };
    spareX += LINK_DISTANCE;
    return spare;
  };

  // Places in graph space first; moved onto the canvas once the bounds are known.
  const units: { item: PlacedUnit; centre: GraphPoint }[] = [];
  const gates: { item: PlacedGate; centre: GraphPoint }[] = [];
  const items: PlacedItem[] = [];
  for (const unit of ordered) {
    const key = unitKey(unit.id);
    const centre = centreOf(key);
    const item: PlacedUnit = {
      kind: "unit",
      key,
      unit,
      dependencies: dependenciesOf.get(unit.id) ?? [],
      held: held.has(unit.id),
      x: centre.x - NODE_WIDTH / 2,
      y: centre.y - NODE_HEIGHT / 2,
    };
    units.push({ item, centre });
    items.push(item);
    for (const view of anchors.get(unit.id) ?? []) {
      const gateKeyValue = gateKey(view.gate.id);
      const gateCentre = centreOf(gateKeyValue);
      const gate: PlacedGate = {
        kind: "gate",
        key: gateKeyValue,
        view,
        x: gateCentre.x - GATE_WIDTH / 2,
        y: gateCentre.y - GATE_HEIGHT / 2,
      };
      gates.push({ item: gate, centre: gateCentre });
      items.push(gate);
    }
  }

  const unitByKey = new Map(units.map((entry) => [entry.item.key, entry]));
  const unitBox = (entry: { centre: GraphPoint }) => ({
    centre: entry.centre,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  });
  const edges: PlacedEdge[] = [];
  for (const edge of dependencyEdges) {
    const from = unitByKey.get(unitKey(edge.from));
    const to = unitByKey.get(unitKey(edge.to));
    if (from === undefined || to === undefined) continue;
    const key = `${from.item.key}->${to.item.key}`;
    if (edges.some((existing) => existing.key === key)) continue;
    edges.push({
      key,
      from: from.item.key,
      to: to.item.key,
      kind: "depends_on",
      fromDone: isDoneUnit(from.item.unit),
      ...edgeGeometry(unitBox(from), unitBox(to)),
    });
  }
  for (const gate of gates) {
    for (const id of gate.item.view.gate.after) {
      const from = unitByKey.get(unitKey(id));
      if (from === undefined) continue;
      edges.push({
        key: `${gate.item.key}->${from.item.key}`,
        from: gate.item.key,
        to: from.item.key,
        kind: "gate",
        fromDone: false,
        ...edgeGeometry(unitBox(from), {
          centre: gate.centre,
          width: GATE_WIDTH,
          height: GATE_HEIGHT,
        }),
      });
    }
  }

  // One outline per stack, in the order the stacks first appear.
  const stackUnits = new Map<string, { item: PlacedUnit; centre: GraphPoint }[]>();
  for (const unit of selectUnitsInStackOrder(snapshot)) {
    if (!stackUnits.has(unit.stack)) stackUnits.set(unit.stack, []);
  }
  for (const entry of units) {
    const list = stackUnits.get(entry.item.unit.stack) ?? [];
    list.push(entry);
    stackUnits.set(entry.item.unit.stack, list);
  }
  const hullCorners: {
    stack: string;
    unitCount: number;
    corners: GraphPoint[];
    label: GraphPoint;
  }[] = [];
  for (const [stack, members] of stackUnits) {
    if (members.length === 0) continue;
    const corners = members.flatMap(({ item }) => [
      { x: item.x - HULL_PAD, y: item.y - HULL_PAD_TOP },
      { x: item.x + NODE_WIDTH + HULL_PAD, y: item.y - HULL_PAD_TOP },
      { x: item.x + NODE_WIDTH + HULL_PAD, y: item.y + NODE_HEIGHT + HULL_PAD },
      { x: item.x - HULL_PAD, y: item.y + NODE_HEIGHT + HULL_PAD },
    ]);
    // The label sits over the topmost unit, inside the outline's top room.
    const top = members.reduce((best, entry) => (entry.item.y < best.item.y ? entry : best));
    hullCorners.push({
      stack,
      unitCount: members.length,
      corners: convexHull(corners),
      label: { x: top.item.x, y: top.item.y - HULL_PAD_TOP + 6 },
    });
  }

  // The bounds of everything drawn, then the move onto the canvas.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const { item } of units) {
    extend(item.x, item.y);
    extend(item.x + NODE_WIDTH, item.y + NODE_HEIGHT);
  }
  for (const { item } of gates) {
    extend(item.x, item.y);
    extend(item.x + GATE_WIDTH, item.y + GATE_HEIGHT + GATE_HOVER_ROOM);
  }
  for (const hull of hullCorners) for (const corner of hull.corners) extend(corner.x, corner.y);
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const origin = { x: minX - CANVAS_PAD, y: minY - CANVAS_PAD };
  const shift = (point: GraphPoint): GraphPoint => ({
    x: round(point.x - origin.x),
    y: round(point.y - origin.y),
  });
  for (const item of items) {
    const at = shift(item);
    item.x = at.x;
    item.y = at.y;
  }
  const shiftPath = (path: string) =>
    path.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => {
      const at = shift({ x: Number(x), y: Number(y) });
      return `${String(at.x)} ${String(at.y)}`;
    });
  for (const edge of edges) {
    edge.path = shiftPath(edge.path);
    edge.arrow = shiftPath(edge.arrow);
  }
  const hulls: PlacedHull[] = hullCorners.map((hull) => {
    const label = shift(hull.label);
    return {
      stack: hull.stack,
      unitCount: hull.unitCount,
      path:
        hull.corners
          .map((corner, index) => {
            const at = shift(corner);
            return `${index === 0 ? "M" : "L"} ${String(at.x)} ${String(at.y)}`;
          })
          .join(" ") + " Z",
      labelX: label.x,
      labelY: label.y,
    };
  });

  return {
    items,
    edges,
    hulls,
    origin,
    width: Math.ceil(maxX - minX + 2 * CANVAS_PAD),
    height: Math.ceil(maxY - minY + 2 * CANVAS_PAD),
  };
}

// The last few simulations, by topology, shape and kept layout: a snapshot
// that changes only a status, or a return to a shape the viewport had, lays
// out again without running the simulation.
const SIMULATION_CACHE_SIZE = 8;
const simulations = new Map<string, Map<string, GraphPoint>>();

export function simulateDeliveryGraphCached(
  topology: GraphTopology,
  options: { aspect: number; kept?: KeptGraphLayout | undefined },
): Map<string, GraphPoint> {
  const key = `${graphTopologyKey(topology)}|${String(options.aspect)}|${JSON.stringify(options.kept ?? null)}`;
  const hit = simulations.get(key);
  if (hit !== undefined) {
    simulations.delete(key);
    simulations.set(key, hit);
    return hit;
  }
  const positions = simulateDeliveryGraph(topology, options);
  simulations.set(key, positions);
  if (simulations.size > SIMULATION_CACHE_SIZE) {
    const oldest = simulations.keys().next().value;
    if (oldest !== undefined) simulations.delete(oldest);
  }
  return positions;
}

function isGraphPoint(value: unknown): value is GraphPoint {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
}

// A kept layout read back from storage, or undefined when it does not have
// the shape one is written in.
export function keptGraphLayoutOf(value: unknown): KeptGraphLayout | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { positions, pinned } = value as Record<string, unknown>;
  if (typeof positions !== "object" || positions === null || !Array.isArray(pinned)) {
    return undefined;
  }
  const kept: KeptGraphLayout = { positions: {}, pinned: [] };
  for (const [key, point] of Object.entries(positions)) {
    if (isGraphPoint(point)) kept.positions[key] = { x: point.x, y: point.y };
  }
  kept.pinned = pinned.filter(
    (key): key is string => typeof key === "string" && Object.hasOwn(kept.positions, key),
  );
  return kept;
}

// The whole layout in one call, as the map draws it with no viewport yet.
export function layoutDeliveryMap(
  snapshot: DeliverySnapshot,
  ordered: readonly DeliveryUnit[],
  options: { aspect?: number; kept?: KeptGraphLayout | undefined } = {},
): DeliveryMapLayout {
  return placeDeliveryGraph(
    snapshot,
    ordered,
    simulateDeliveryGraph(selectGraphTopology(snapshot, ordered), options),
  );
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
