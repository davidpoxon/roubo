import { useEffect, useId, useRef, useState } from "react";
import StatusIndicator from "../ui/StatusIndicator";
import { focusRingOffset } from "../ui/focus-ring";
import {
  GATE_HEIGHT,
  GATE_MARKERS,
  GATE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  classifyGateMarker,
  dependencyLine,
  gateAccessibleName,
  gateHoverLine,
  gateMarkerLabel,
  HELD_DRAFT_LABEL,
  isJammedMapUnit,
  isLiveUnit,
  JAM_MARK_LABEL,
  unitAccessibleName,
  unitStatusTone,
  type DeliveryMapLayout,
  type MapTarget,
  type PlacedEdge,
  type PlacedGate,
  type PlacedItem,
  type PlacedUnit,
} from "./delivery-map-model";

// The delivery map's graph view (DESIGN.md Unit node, #1619): a label for each
// stack lane, a header for each layer column, one node per unit in its lane at
// its layer (units that share a cell one above the other), the gates in a gate
// lane below the stacks, and the `depends_on` edges between them, with a legend
// of the edge kinds and a detail line under the graph. A lane longer than the
// map scrolls sideways while the lane labels stay in place, and the live unit
// is brought into view when the map opens. The nodes and gates sit in the DOM
// in dependency order, so Tab walks them in that order whatever their place on
// the canvas. The edges are decorative: each node names its dependencies for
// the screen reader.

export interface DeliveryGraphProps {
  layout: DeliveryMapLayout;
  selectedKey: string | null;
  onSelect: (target: MapTarget) => void;
  onOpen: (target: MapTarget) => void;
}

// The width of the lane label column and the height of the layer header row.
const LABEL_WIDTH = 104;
const HEADER_HEIGHT = 28;

const EYEBROW = "font-mono text-11 font-medium uppercase tracking-label text-text-secondary";

function edgeStroke(edge: PlacedEdge, activeKey: string | null): string {
  if (activeKey !== null && (edge.from === activeKey || edge.to === activeKey)) {
    return "stroke-accent stroke-2";
  }
  if (edge.kind === "gate") return "stroke-status-error stroke-1";
  return edge.fromDone ? "stroke-success-text stroke-1" : "stroke-border-strong stroke-1";
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

// What the detail line under the graph says about the node under the pointer
// or focus.
function detailText(item: PlacedItem | undefined): string {
  if (item === undefined) return "Hover or focus a unit or a gate. Enter opens it.";
  if (item.kind === "gate") return `gate ${item.view.gate.id} · ${gateHoverLine(item.view)}`;
  const { unit } = item;
  const cost = unit.cost_usd === undefined ? "" : ` · USD ${unit.cost_usd.toFixed(2)}`;
  const held = item.held ? ` · ${HELD_DRAFT_LABEL}` : "";
  return `${unit.id} ${unit.title} · ${dependencyLine(item.dependencies)}${cost}${held}`;
}

export default function DeliveryGraph({
  layout,
  selectedKey,
  onSelect,
  onOpen,
}: DeliveryGraphProps) {
  // The node under the pointer or keyboard focus, whose edges take the accent.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const idPrefix = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const openedLayout = useRef(layout);

  // When the map opens, bring the live unit into view: a long lane starts
  // scrolled so that the unit is in the middle of the visible part.
  useEffect(() => {
    const element = scroller.current;
    const live = openedLayout.current.items.find(
      (item): item is PlacedUnit => item.kind === "unit" && isLiveUnit(item.unit),
    );
    if (element === null || live === undefined) return;
    const visible = element.clientWidth - LABEL_WIDTH;
    if (live.x + NODE_WIDTH <= visible) return;
    element.scrollLeft = Math.max(0, live.x - (visible - NODE_WIDTH) / 2);
  }, []);

  const active = layout.items.find((item) => item.key === activeKey);

  return (
    <div data-testid="delivery-graph" className="space-y-2">
      <div ref={scroller} data-testid="delivery-graph-scroll" className="overflow-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `${String(LABEL_WIDTH)}px ${String(layout.width)}px`,
            gridTemplateRows: `${String(HEADER_HEIGHT)}px ${String(layout.height)}px`,
            width: LABEL_WIDTH + layout.width,
          }}
        >
          <div aria-hidden="true" className="sticky left-0 top-0 z-30 bg-bg-surface" />
          <div className="sticky top-0 z-10 bg-bg-surface">
            <ol aria-label="Layers" className="relative h-full">
              {layout.columns.map((column) => (
                <li
                  key={column.layer}
                  data-testid={`delivery-layer-${String(column.layer)}`}
                  style={{ left: column.left, width: NODE_WIDTH }}
                  className={`absolute top-0 ${EYEBROW}`}
                >
                  Layer {column.layer}
                </li>
              ))}
            </ol>
          </div>
          <div className="sticky left-0 z-20 bg-bg-surface">
            <ol aria-label="Stacks" className="relative h-full">
              {layout.lanes.map((lane) => (
                <li
                  key={lane.stack}
                  data-testid={`delivery-lane-${lane.stack}`}
                  style={{ top: lane.top, height: lane.height }}
                  className="absolute inset-x-0 flex flex-col justify-center gap-0.5 pr-3"
                >
                  <span className={EYEBROW}>
                    stack {/* An atomic box, so a long stack id moves to its own line whole. */}
                    <span className="inline-block max-w-full wrap-anywhere">{lane.stack}</span>
                  </span>
                  <span className="font-mono text-11 text-text-secondary">
                    {plural(lane.unitCount, "unit")}
                  </span>
                </li>
              ))}
              {layout.gateLane !== null && (
                <li
                  data-testid="delivery-gate-lane"
                  style={{ top: layout.gateLane.top, height: layout.gateLane.height }}
                  className="absolute inset-x-0 flex flex-col justify-center gap-0.5 pr-3"
                >
                  <span className={EYEBROW}>verify gates</span>
                  <span className="font-mono text-11 text-text-secondary">
                    {plural(layout.gateLane.gateCount, "gate")}
                  </span>
                </li>
              )}
            </ol>
            {layout.gateLane !== null && (
              <div
                aria-hidden="true"
                style={{ top: layout.gateLane.ruleTop }}
                className="absolute inset-x-0 border-t border-dashed border-border-strong"
              />
            )}
          </div>
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            {layout.gateLane !== null && (
              <div
                aria-hidden="true"
                data-testid="delivery-gate-lane-rule"
                style={{ top: layout.gateLane.ruleTop }}
                className="absolute inset-x-0 border-t border-dashed border-border-strong"
              />
            )}
            <svg
              aria-hidden="true"
              className="absolute inset-0 pointer-events-none"
              width={layout.width}
              height={layout.height}
            >
              {layout.edges.map((edge) => (
                <path
                  key={edge.key}
                  data-edge-from={edge.from}
                  data-edge-to={edge.to}
                  data-edge-kind={edge.kind}
                  d={edge.path}
                  fill="none"
                  strokeDasharray={edge.kind === "gate" ? "4 3" : undefined}
                  className={edgeStroke(edge, activeKey)}
                />
              ))}
            </svg>
            <ol aria-label="Units and gates in dependency order">
              {layout.items.map((item, index) =>
                item.kind === "unit" ? (
                  <UnitNode
                    key={item.key}
                    item={item}
                    detailId={`${idPrefix}-detail-${String(index)}`}
                    selected={selectedKey === item.key}
                    onActive={setActiveKey}
                    onSelect={onSelect}
                    onOpen={onOpen}
                  />
                ) : (
                  <GateMarker
                    key={item.key}
                    item={item}
                    detailId={`${idPrefix}-gate-${String(index)}`}
                    shown={activeKey === item.key}
                    selected={selectedKey === item.key}
                    onActive={setActiveKey}
                    onSelect={onSelect}
                    onOpen={onOpen}
                  />
                ),
              )}
            </ol>
          </div>
        </div>
      </div>
      <ul
        aria-label="Edge legend"
        data-testid="delivery-graph-legend"
        className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-2 font-mono text-11 text-text-secondary"
      >
        <LegendItem swatch="border-t border-border-strong">depends on</LegendItem>
        <LegendItem swatch="border-t border-success-text">merged</LegendItem>
        <LegendItem swatch="border-t-2 border-accent">live path</LegendItem>
        <LegendItem swatch="border-t border-dashed border-status-error">
          gates the next batch
        </LegendItem>
      </ul>
      <p
        aria-hidden="true"
        data-testid="delivery-graph-detail"
        className="min-h-5 break-words text-12 text-text-secondary"
      >
        {detailText(active)}
      </p>
    </div>
  );
}

function LegendItem({ swatch, children }: { swatch: string; children: string }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`inline-block w-5 ${swatch}`} />
      {children}
    </li>
  );
}

interface ItemProps<T> {
  item: T;
  selected: boolean;
  onActive: (key: string | null) => void;
  onSelect: (target: MapTarget) => void;
  onOpen: (target: MapTarget) => void;
}

const FRAME_CLASSES = `absolute flex flex-col justify-center text-left transition-colors ${focusRingOffset}`;

function UnitNode({
  item,
  detailId,
  selected,
  onActive,
  onSelect,
  onOpen,
}: ItemProps<PlacedUnit> & { detailId: string }) {
  const { unit } = item;
  const target: MapTarget = { kind: "unit", id: unit.id };
  const live = isLiveUnit(unit);
  const jammed = isJammedMapUnit(unit);
  return (
    <li>
      <button
        type="button"
        data-testid={`unit-node-${unit.id}`}
        data-key={item.key}
        data-stack={unit.stack}
        data-layer={unit.layer}
        data-status={unit.status}
        data-jammed={jammed ? "true" : undefined}
        aria-label={unitAccessibleName(unit, item.held)}
        data-held={item.held ? "true" : undefined}
        aria-describedby={detailId}
        aria-current={selected ? "true" : undefined}
        onClick={() => {
          onSelect(target);
          onOpen(target);
        }}
        onFocus={() => {
          onActive(item.key);
          onSelect(target);
        }}
        onBlur={() => onActive(null)}
        onMouseEnter={() => onActive(item.key)}
        onMouseLeave={() => onActive(null)}
        style={{ left: item.x, top: item.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
        className={`${FRAME_CLASSES} gap-1 rounded-control border bg-bg-base px-2.5 py-2 text-text-body hover:bg-bg-hover active:bg-bg-pressed ${
          selected ? "border-accent-border" : "border-border-strong"
        } ${live ? "border-l-2 border-l-accent" : ""}`}
      >
        <span className="flex w-full min-w-0 items-center gap-2 font-mono text-11 font-medium text-text-body">
          <span className="min-w-0 truncate">{unit.id}</span>
          {jammed && (
            <span
              data-testid={`unit-jam-mark-${unit.id}`}
              className="shrink-0 rounded-chip bg-danger-surface px-1 text-11 text-danger-text"
            >
              {JAM_MARK_LABEL}
            </span>
          )}
          {item.held && (
            <span
              data-testid={`unit-pr-${unit.id}`}
              className="ml-auto shrink-0 font-normal text-text-secondary"
            >
              {HELD_DRAFT_LABEL}
            </span>
          )}
        </span>
        <span className="w-full truncate text-12 font-medium text-text-primary">{unit.title}</span>
        <span className="flex items-center gap-3">
          <StatusIndicator tone={unitStatusTone(unit)} label={unit.status} />
          {unit.cost_usd !== undefined && (
            <span className="font-mono text-11 text-text-secondary tabular-nums">
              {unit.cost_usd.toFixed(2)}
            </span>
          )}
        </span>
        <span id={detailId} className="sr-only">
          {dependencyLine(item.dependencies)}
        </span>
      </button>
    </li>
  );
}

// A gate marker in the gate lane. Under the pointer or keyboard focus it shows
// its state and the count of the cases it gates; the same line describes it
// for the screen reader at all times.
function GateMarker({
  item,
  detailId,
  shown,
  selected,
  onActive,
  onSelect,
  onOpen,
}: ItemProps<PlacedGate> & { detailId: string; shown: boolean }) {
  const { gate } = item.view;
  const target: MapTarget = { kind: "gate", id: gate.id };
  const kind = classifyGateMarker(gate);
  const marker = GATE_MARKERS[kind];
  return (
    <li>
      <span
        id={detailId}
        role="tooltip"
        data-testid={`gate-hover-${gate.id}`}
        hidden={!shown}
        style={{ left: item.x, top: item.y + GATE_HEIGHT + 4 }}
        className="absolute z-10 whitespace-nowrap rounded-control border border-border-strong bg-bg-surface px-2 py-1 font-mono text-11 text-text-body"
      >
        {gateHoverLine(item.view)}
      </span>
      <button
        type="button"
        data-testid={`gate-marker-${gate.id}`}
        data-key={item.key}
        data-gate-kind={kind}
        aria-label={gateAccessibleName(gate)}
        aria-describedby={detailId}
        aria-current={selected ? "true" : undefined}
        onClick={() => {
          onSelect(target);
          onOpen(target);
        }}
        onFocus={() => {
          onActive(item.key);
          onSelect(target);
        }}
        onBlur={() => onActive(null)}
        onMouseEnter={() => onActive(item.key)}
        onMouseLeave={() => onActive(null)}
        style={{ left: item.x, top: item.y, width: GATE_WIDTH, height: GATE_HEIGHT }}
        className={`${FRAME_CLASSES} gap-1 rounded-control border ${marker.ground} px-2.5 py-1.5 text-text-body hover:bg-bg-hover active:bg-bg-pressed ${
          selected ? "border-accent-border" : marker.border
        }`}
      >
        <span className="w-full truncate font-mono text-11 font-medium text-text-body">
          gate {gate.id}
        </span>
        <StatusIndicator tone={marker.tone} label={gateMarkerLabel(gate)} />
      </button>
    </li>
  );
}
