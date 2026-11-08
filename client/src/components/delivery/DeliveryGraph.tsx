import { useId, useState } from "react";
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
  isJammedMapUnit,
  isLiveUnit,
  JAM_MARK_LABEL,
  unitAccessibleName,
  unitStatusTone,
  type DeliveryMapLayout,
  type MapTarget,
  type PlacedEdge,
  type PlacedGate,
  type PlacedUnit,
} from "./delivery-map-model";

// The delivery map's graph view (DESIGN.md Unit node): one node per unit in its
// stack lane at its layer, a gate marker after each gated unit, and the
// `depends_on` edges between them. The nodes and markers sit in the DOM in
// dependency order, so Tab walks them in that order whatever their place on the
// canvas. The edges are decorative: each node's detail line names its
// dependencies for the screen reader.

export interface DeliveryGraphProps {
  layout: DeliveryMapLayout;
  selectedKey: string | null;
  onSelect: (target: MapTarget) => void;
  onOpen: (target: MapTarget) => void;
}

function edgeStroke(edge: PlacedEdge, activeKey: string | null): string {
  if (activeKey !== null && (edge.from === activeKey || edge.to === activeKey)) {
    return "stroke-accent stroke-2";
  }
  if (edge.kind === "gate") return "stroke-status-error stroke-1";
  return edge.fromDone ? "stroke-success-text stroke-1" : "stroke-border-strong stroke-1";
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

  return (
    <div data-testid="delivery-graph" className="overflow-auto">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
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
                detailId={`${idPrefix}-detail-${index}`}
                selected={selectedKey === item.key}
                onActive={setActiveKey}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            ) : (
              <GateMarker
                key={item.key}
                item={item}
                detailId={`${idPrefix}-gate-${index}`}
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
  );
}

interface ItemProps<T> {
  item: T;
  selected: boolean;
  onActive: (key: string | null) => void;
  onSelect: (target: MapTarget) => void;
  onOpen: (target: MapTarget) => void;
}

const FRAME_CLASSES = `absolute flex flex-col text-left transition-colors ${focusRingOffset}`;

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
        data-status={unit.status}
        data-jammed={jammed ? "true" : undefined}
        aria-label={unitAccessibleName(unit)}
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
        className={`${FRAME_CLASSES} gap-0.5 rounded-control border bg-bg-base p-2 text-text-body hover:bg-bg-hover active:bg-bg-pressed ${
          selected ? "border-accent-border" : "border-border-strong"
        } ${live ? "border-l-2 border-l-accent" : ""}`}
      >
        <span className="flex items-center gap-2 font-mono text-11 font-medium text-text-body">
          {unit.id}
          {jammed && (
            <span
              data-testid={`unit-jam-mark-${unit.id}`}
              className="rounded-chip bg-danger-surface px-1 text-11 text-danger-text"
            >
              {JAM_MARK_LABEL}
            </span>
          )}
        </span>
        <span className="truncate w-full text-12 font-medium text-text-primary">{unit.title}</span>
        <span className="flex items-center gap-2">
          <StatusIndicator tone={unitStatusTone(unit)} label={unit.status} />
          {unit.cost_usd !== undefined && (
            <span className="font-mono text-11 text-text-secondary tabular-nums">
              {unit.cost_usd.toFixed(2)}
            </span>
          )}
        </span>
        <span className="font-mono text-11 text-text-secondary truncate w-full">
          stack {unit.stack} · layer {unit.layer}
        </span>
        <span id={detailId} className="font-mono text-11 text-text-secondary truncate w-full">
          {dependencyLine(item.dependencies)}
        </span>
      </button>
    </li>
  );
}

// A gate marker. Under the pointer or keyboard focus it shows its state and
// the count of the cases it gates; the same line describes it for the screen
// reader at all times.
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
        className={`${FRAME_CLASSES} justify-center gap-0.5 rounded-control border ${marker.ground} px-2 py-1 text-text-body hover:bg-bg-hover active:bg-bg-pressed ${
          selected ? "border-accent-border" : marker.border
        }`}
      >
        <span className="font-mono text-11 text-text-body truncate w-full">gate {gate.id}</span>
        <StatusIndicator tone={marker.tone} label={marker.label} />
      </button>
    </li>
  );
}
