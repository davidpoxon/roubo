import { useId, useRef, useState, type PointerEvent } from "react";
import { Maximize, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useGraphViewport } from "../../hooks/useGraphViewport";
import IconButton from "../ui/IconButton";
import StatusIndicator from "../ui/StatusIndicator";
import { focusRing, focusRingOffset } from "../ui/focus-ring";
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
  pullRequestNumber,
  unitAccessibleName,
  unitCostLabel,
  unitStatusTone,
  type DeliveryMapLayout,
  type GraphPoint,
  type MapTarget,
  type PlacedEdge,
  type PlacedGate,
  type PlacedItem,
  type PlacedUnit,
} from "./delivery-map-model";
import { MAX_ZOOM, MIN_ZOOM, type ViewportSize } from "./graph-viewport";

// The delivery map's graph view (DESIGN.md Unit node, #1619, #1656): one node
// per unit and one per gate, where the force layout placed them, the
// `depends_on` edges between them with an arrowhead at the unit that depends,
// the gate edges dashed, and a labelled outline around the units of each
// stack. A legend of the edge kinds and a detail line sit under the graph.
//
// The graph takes the height of the map panel (#1655) and shows in a viewport
// that pans and zooms (useGraphViewport), with zoom out, zoom in, Fit and
// Reset layout over its bottom right corner. A drag of a node moves it: the
// map keeps where it was dropped (onMoveNode), and the other nodes settle
// around it. A node that takes the focus is panned into view, so Tab walks
// the whole graph. The nodes and gates sit in the DOM in dependency order, so
// Tab walks them in that order whatever their place on the canvas. The edges
// are decorative: each node names its dependencies for the screen reader.

export interface DeliveryGraphProps {
  layout: DeliveryMapLayout;
  selectedKey: string | null;
  onSelect: (target: MapTarget) => void;
  onOpen: (target: MapTarget) => void;
  // The viewport's size, for the layout's shape.
  onResize?: (size: ViewportSize) => void;
  // A node dropped at a new place: its key and its centre in graph space.
  onMoveNode?: (key: string, centre: GraphPoint) => void;
  // Forgets the places nodes were dragged to; absent while there are none.
  onResetLayout?: (() => void) | undefined;
}

// A pointer has to move this far on a node before the press is a drag.
const DRAG_THRESHOLD = 4;

const EYEBROW = "font-mono text-11 font-medium uppercase tracking-label text-text-secondary";

type EdgeTone = "active" | "gate" | "merged" | "default";

const EDGE_STROKES: Record<EdgeTone, string> = {
  active: "stroke-accent stroke-2",
  gate: "stroke-status-error stroke-1",
  merged: "stroke-success-text stroke-1",
  default: "stroke-border-strong stroke-1",
};

const EDGE_FILLS: Record<EdgeTone, string> = {
  active: "fill-accent",
  gate: "fill-status-error",
  merged: "fill-success-text",
  default: "fill-border-strong",
};

function edgeTone(edge: PlacedEdge, activeKey: string | null): EdgeTone {
  if (activeKey !== null && (edge.from === activeKey || edge.to === activeKey)) return "active";
  if (edge.kind === "gate") return "gate";
  return edge.fromDone ? "merged" : "default";
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

// What the detail line under the graph says about the node under the pointer
// or focus.
function detailText(item: PlacedItem | undefined): string {
  if (item === undefined) {
    return "Hover or focus a unit or a gate. Enter opens it. Drag to pan or to move a node; Ctrl or Cmd and scroll to zoom.";
  }
  if (item.kind === "gate") return `gate ${item.view.gate.id} · ${gateHoverLine(item.view)}`;
  const { unit } = item;
  const cost = unit.cost_usd === undefined ? "" : ` · ${unitCostLabel(unit.cost_usd)}`;
  const held = item.held ? ` · ${HELD_DRAFT_LABEL}` : "";
  return `${unit.id} ${unit.title} · ${dependencyLine(item.dependencies)}${cost}${held}`;
}

function itemSize(item: PlacedItem): { width: number; height: number } {
  return item.kind === "unit"
    ? { width: NODE_WIDTH, height: NODE_HEIGHT }
    : { width: GATE_WIDTH, height: GATE_HEIGHT };
}

// A press on a node that may turn into a drag.
interface NodePress {
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  itemX: number;
  itemY: number;
  dragging: boolean;
}

export interface NodeDragHandlers {
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, item: PlacedItem) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  // True once for the click that ends a drag, which must not open the node.
  takeClick: () => boolean;
}

export default function DeliveryGraph({
  layout,
  selectedKey,
  onSelect,
  onOpen,
  onResize,
  onMoveNode,
  onResetLayout,
}: DeliveryGraphProps) {
  // The node under the pointer or keyboard focus, whose edges take the accent.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const idPrefix = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const { origin } = layout;
  const bounds = { x: origin.x, y: origin.y, width: layout.width, height: layout.height };
  const live = layout.items.find(
    (item): item is PlacedUnit => item.kind === "unit" && isLiveUnit(item.unit),
  );
  const focus =
    live === undefined
      ? null
      : { x: live.x + origin.x + NODE_WIDTH / 2, y: live.y + origin.y + NODE_HEIGHT / 2 };
  const viewport = useGraphViewport(viewportRef, bounds, focus, onResize);
  const { view } = viewport;

  // The node being dragged and where it is on the canvas now.
  const [dragged, setDragged] = useState<{ key: string; x: number; y: number } | null>(null);
  const press = useRef<NodePress | null>(null);
  const endedDrag = useRef(false);
  const drag: NodeDragHandlers = {
    onPointerDown: (event, item) => {
      if (event.button !== 0 || onMoveNode === undefined) return;
      press.current = {
        key: item.key,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        itemX: item.x,
        itemY: item.y,
        dragging: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event) => {
      const current = press.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (!current.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      current.dragging = true;
      setDragged({
        key: current.key,
        x: current.itemX + dx / view.k,
        y: current.itemY + dy / view.k,
      });
    },
    onPointerUp: (event) => {
      const current = press.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      press.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (!current.dragging) return;
      endedDrag.current = true;
      const item = layout.items.find((candidate) => candidate.key === current.key);
      const size = item === undefined ? { width: 0, height: 0 } : itemSize(item);
      const x = current.itemX + (event.clientX - current.startX) / view.k;
      const y = current.itemY + (event.clientY - current.startY) / view.k;
      setDragged(null);
      onMoveNode?.(current.key, {
        x: x + origin.x + size.width / 2,
        y: y + origin.y + size.height / 2,
      });
    },
    takeClick: () => {
      if (!endedDrag.current) return false;
      endedDrag.current = false;
      return true;
    },
  };

  // A node that takes the focus is panned into view.
  const revealItem = (item: PlacedItem) => {
    const size = itemSize(item);
    viewport.reveal({ x: item.x + origin.x, y: item.y + origin.y, ...size });
  };
  const onItemFocus = (item: PlacedItem) => {
    setActiveKey(item.key);
    revealItem(item);
  };

  const active = layout.items.find((item) => item.key === activeKey);
  const placed = (item: PlacedItem): PlacedItem =>
    dragged !== null && dragged.key === item.key ? { ...item, x: dragged.x, y: dragged.y } : item;
  const helpId = `${idPrefix}-help`;
  const canvasX = view.x + origin.x * view.k;
  const canvasY = view.y + origin.y * view.k;

  return (
    <div data-testid="delivery-graph" className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        ref={viewportRef}
        data-testid="delivery-graph-scroll"
        role="group"
        aria-label="Delivery graph"
        aria-describedby={helpId}
        tabIndex={0}
        onPointerDown={viewport.onPointerDown}
        onPointerMove={viewport.onPointerMove}
        onPointerUp={viewport.onPointerUp}
        onPointerCancel={viewport.onPointerUp}
        onKeyDown={viewport.onKeyDown}
        // The browser scrolls a focused node into view even in a viewport
        // that does not scroll; the pan does that work instead.
        onScroll={(event) => {
          event.currentTarget.scrollTop = 0;
          event.currentTarget.scrollLeft = 0;
        }}
        className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-control bg-bg-base ${focusRing} ${
          viewport.panning ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <span id={helpId} className="sr-only">
          Drag or scroll to pan. Ctrl or Cmd and scroll, or the plus and minus keys, zoom; 0 fits
          the graph. The arrow keys pan.
        </span>
        <div
          data-testid="delivery-graph-canvas"
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${String(canvasX)}px, ${String(canvasY)}px) scale(${String(view.k)})`,
          }}
        >
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={layout.width}
            height={layout.height}
          >
            {layout.hulls.map((hull) => (
              <path
                key={hull.stack}
                data-testid={`delivery-stack-outline-${hull.stack}`}
                d={hull.path}
                fill="none"
                strokeDasharray="6 4"
                strokeLinejoin="round"
                className="stroke-border-strong stroke-1"
              />
            ))}
            {layout.edges.map((edge) => {
              const tone = edgeTone(edge, activeKey);
              return (
                <g key={edge.key}>
                  <path
                    data-edge-from={edge.from}
                    data-edge-to={edge.to}
                    data-edge-kind={edge.kind}
                    d={edge.path}
                    fill="none"
                    strokeDasharray={edge.kind === "gate" ? "4 3" : undefined}
                    className={EDGE_STROKES[tone]}
                  />
                  <path d={edge.arrow} className={EDGE_FILLS[tone]} />
                </g>
              );
            })}
          </svg>
          <ol aria-label="Stacks">
            {layout.hulls.map((hull) => (
              <li
                key={hull.stack}
                data-testid={`delivery-lane-${hull.stack}`}
                style={{ left: hull.labelX, top: hull.labelY, maxWidth: NODE_WIDTH * 2 }}
                className={`pointer-events-none absolute truncate whitespace-nowrap ${EYEBROW}`}
              >
                stack {hull.stack} · {plural(hull.unitCount, "unit")}
              </li>
            ))}
          </ol>
          <ol aria-label="Units and gates in dependency order">
            {layout.items.map((item, index) =>
              item.kind === "unit" ? (
                <UnitNode
                  key={item.key}
                  item={placed(item) as PlacedUnit}
                  detailId={`${idPrefix}-detail-${String(index)}`}
                  selected={selectedKey === item.key}
                  dragging={dragged?.key === item.key}
                  drag={drag}
                  onActive={setActiveKey}
                  onFocusItem={() => onItemFocus(item)}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ) : (
                <GateMarker
                  key={item.key}
                  item={placed(item) as PlacedGate}
                  detailId={`${idPrefix}-gate-${String(index)}`}
                  shown={activeKey === item.key}
                  selected={selectedKey === item.key}
                  dragging={dragged?.key === item.key}
                  drag={drag}
                  onActive={setActiveKey}
                  onFocusItem={() => onItemFocus(item)}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ),
            )}
          </ol>
        </div>
        <GraphControls
          zoom={view.k}
          onZoomIn={viewport.zoomIn}
          onZoomOut={viewport.zoomOut}
          onFit={viewport.fit}
          onResetLayout={onResetLayout}
        />
      </div>
      <ul
        aria-label="Edge legend"
        data-testid="delivery-graph-legend"
        className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-t border-border pt-2 font-mono text-11 text-text-secondary"
      >
        <LegendItem swatch="border-t border-border-strong">depends on</LegendItem>
        <LegendItem swatch="border-t border-success-text">merged</LegendItem>
        <LegendItem swatch="border-t-2 border-accent">live path</LegendItem>
        <LegendItem swatch="border-t border-dashed border-status-error">
          gates the next batch
        </LegendItem>
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-flex w-5 items-center">
            <span className="inline-block w-3.5 border-t border-border-strong" />
            <span className="inline-block h-0 w-0 border-y-4 border-l-[6px] border-y-transparent border-l-border-strong" />
          </span>
          points at the unit that depends
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-5 rounded-chip border border-dashed border-border-strong"
          />
          stack
        </li>
      </ul>
      <p
        aria-hidden="true"
        data-testid="delivery-graph-detail"
        className="min-h-5 shrink-0 break-words text-12 text-text-secondary"
      >
        {detailText(active)}
      </p>
    </div>
  );
}

// The view controls over the graph's bottom right corner.
function GraphControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onResetLayout,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onResetLayout: (() => void) | undefined;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Graph view"
      data-testid="delivery-graph-controls"
      className="absolute bottom-2 right-2 z-30 flex items-center gap-0.5 rounded-control border border-border-strong bg-bg-surface p-0.5"
    >
      <IconButton label="Zoom out" onPress={onZoomOut} isDisabled={zoom <= MIN_ZOOM + 1e-6}>
        <ZoomOut aria-hidden="true" className="h-4 w-4" />
      </IconButton>
      <span
        data-testid="delivery-graph-zoom"
        className="min-w-10 text-center font-mono text-11 tabular-nums text-text-secondary"
      >
        {Math.round(zoom * 100)}%
      </span>
      <IconButton label="Zoom in" onPress={onZoomIn} isDisabled={zoom >= MAX_ZOOM - 1e-6}>
        <ZoomIn aria-hidden="true" className="h-4 w-4" />
      </IconButton>
      <IconButton label="Fit the graph" onPress={onFit}>
        <Maximize aria-hidden="true" className="h-4 w-4" />
      </IconButton>
      <IconButton
        label="Reset layout"
        tooltip={onResetLayout === undefined ? "No node has been moved" : "Forget the moved nodes"}
        onPress={() => onResetLayout?.()}
        isDisabled={onResetLayout === undefined}
      >
        <RotateCcw aria-hidden="true" className="h-4 w-4" />
      </IconButton>
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
  dragging: boolean;
  drag: NodeDragHandlers;
  onActive: (key: string | null) => void;
  onFocusItem: () => void;
  onSelect: (target: MapTarget) => void;
  onOpen: (target: MapTarget) => void;
}

const FRAME_CLASSES = `absolute flex cursor-pointer flex-col justify-center text-left transition-colors ${focusRingOffset}`;

function UnitNode({
  item,
  detailId,
  selected,
  dragging,
  drag,
  onActive,
  onFocusItem,
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
        data-dragging={dragging ? "true" : undefined}
        onClick={() => {
          if (drag.takeClick()) return;
          onSelect(target);
          onOpen(target);
        }}
        onFocus={() => {
          onFocusItem();
          onSelect(target);
        }}
        onBlur={() => onActive(null)}
        onMouseEnter={() => onActive(item.key)}
        onMouseLeave={() => onActive(null)}
        onPointerDown={(event) => drag.onPointerDown(event, item)}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerUp}
        style={{ left: item.x, top: item.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
        className={`${FRAME_CLASSES} gap-1 rounded-control border bg-bg-base px-2.5 py-2 text-text-body hover:bg-bg-hover active:bg-bg-pressed ${
          selected ? "border-accent-border" : "border-border-strong"
        } ${live ? "border-l-2 border-l-accent" : ""} ${dragging ? "z-20 cursor-grabbing" : ""}`}
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
          {item.held ? (
            <span
              data-testid={`unit-pr-${unit.id}`}
              className="ml-auto shrink-0 font-normal text-text-secondary"
            >
              {HELD_DRAFT_LABEL}
            </span>
          ) : (
            pullRequestNumber(unit) !== null && (
              <span
                data-testid={`unit-pr-number-${unit.id}`}
                className="ml-auto shrink-0 font-normal text-text-secondary"
              >
                {pullRequestNumber(unit)}
              </span>
            )
          )}
        </span>
        <span className="w-full truncate text-12 font-medium text-text-primary">{unit.title}</span>
        <span className="flex w-full items-center gap-3">
          <StatusIndicator tone={unitStatusTone(unit)} label={unit.status} />
          <span
            data-testid={`unit-layer-${unit.id}`}
            className="ml-auto order-last font-mono text-11 text-text-secondary"
          >
            L{unit.layer}
          </span>
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

// A gate marker, after the units it follows. Under the pointer or keyboard focus it shows
// its state and the count of the cases it gates; the same line describes it
// for the screen reader at all times.
function GateMarker({
  item,
  detailId,
  shown,
  selected,
  dragging,
  drag,
  onActive,
  onFocusItem,
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
        data-dragging={dragging ? "true" : undefined}
        onClick={() => {
          if (drag.takeClick()) return;
          onSelect(target);
          onOpen(target);
        }}
        onFocus={() => {
          onFocusItem();
          onSelect(target);
        }}
        onBlur={() => onActive(null)}
        onMouseEnter={() => onActive(item.key)}
        onMouseLeave={() => onActive(null)}
        onPointerDown={(event) => drag.onPointerDown(event, item)}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerUp}
        style={{ left: item.x, top: item.y, width: GATE_WIDTH, height: GATE_HEIGHT }}
        className={`${FRAME_CLASSES} gap-1 rounded-control border ${marker.ground} px-2.5 py-1.5 text-text-body hover:bg-bg-hover active:bg-bg-pressed ${
          selected ? "border-accent-border" : marker.border
        } ${dragging ? "z-20 cursor-grabbing" : ""}`}
      >
        <span className="w-full truncate font-mono text-11 font-medium text-text-body">
          gate {gate.id}
        </span>
        <StatusIndicator tone={marker.tone} label={gateMarkerLabel(gate)} />
      </button>
    </li>
  );
}
