// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { selectDependencyOrder } from "@roubo/shared/delivery-selectors";
import type { DeliveryRecord } from "@roubo/shared/delivery-observation-contract";
import { fiftyUnitRecord, fourUnitRecord } from "../../test/delivery-fixtures";
import DeliveryGraph from "./DeliveryGraph";
import {
  GATE_HEIGHT,
  GATE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  placeDeliveryGraph,
  selectGraphTopology,
  simulateDeliveryGraph,
  type DeliveryMapLayout,
  type GraphPoint,
  type KeptGraphLayout,
  type PlacedItem,
} from "./delivery-map-model";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function orderedOf(record: DeliveryRecord) {
  const snapshot = foldDelivery({ record, events: [] });
  const order = selectDependencyOrder(snapshot);
  if (order.kind !== "ordered") throw new Error("the fixture has a cycle");
  return { snapshot, units: order.units };
}

function positionsOf(
  record: DeliveryRecord,
  options: { aspect?: number; kept?: KeptGraphLayout } = {},
) {
  const { snapshot, units } = orderedOf(record);
  return simulateDeliveryGraph(selectGraphTopology(snapshot, units), {
    aspect: options.aspect ?? 1.6,
    kept: options.kept,
  });
}

function layoutOf(
  record: DeliveryRecord,
  options: { aspect?: number; kept?: KeptGraphLayout } = {},
): DeliveryMapLayout {
  const { snapshot, units } = orderedOf(record);
  return placeDeliveryGraph(snapshot, units, positionsOf(record, options));
}

// A and E share stack A and layer 0; B follows both.
function sharedCellRecord(): DeliveryRecord {
  const record = fourUnitRecord();
  return {
    ...record,
    stack: { ...record.stack, stacks: { A: ["A", "E", "B", "C"], D: ["D"] } },
    units: [
      ...record.units.map((unit) => (unit.id === "B" ? { ...unit, depends_on: ["A", "E"] } : unit)),
      {
        id: "E",
        title: "Beside the base",
        status: "pending",
        stack: "A",
        layer: 0,
        depends_on: [],
      },
    ],
  };
}

// One stack of `count` units, each after the one before: the shape that made
// the old grid one long row.
function chainRecord(count: number): DeliveryRecord {
  const record = fourUnitRecord();
  const ids = Array.from({ length: count }, (_, index) => `U${String(index)}`);
  return {
    ...record,
    stack: {
      ...record.stack,
      stacks: { A: ids },
      gates: [{ id: "gate-end", after: [ids[count - 1] ?? ""], status: "pending", cases: [] }],
    },
    units: ids.map((id, index) => ({
      id,
      title: `Unit ${String(index)}`,
      status: "pending",
      stack: "A",
      layer: index,
      depends_on: index === 0 ? [] : [ids[index - 1] ?? ""],
    })),
  };
}

function box(item: PlacedItem) {
  const width = item.kind === "unit" ? NODE_WIDTH : GATE_WIDTH;
  const height = item.kind === "unit" ? NODE_HEIGHT : GATE_HEIGHT;
  return { left: item.x, top: item.y, right: item.x + width, bottom: item.y + height };
}

function overlaps(layout: DeliveryMapLayout): string[] {
  const found: string[] = [];
  layout.items.forEach((first, index) => {
    for (const second of layout.items.slice(index + 1)) {
      const a = box(first);
      const b = box(second);
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        found.push(`${first.key}/${second.key}`);
      }
    }
  });
  return found;
}

function hullPoints(path: string): GraphPoint[] {
  return [...path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));
}

// True when the point is inside the convex polygon or on its border.
function insideConvex(polygon: GraphPoint[], point: GraphPoint): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) < 1e-6) continue;
    const side = Math.sign(cross);
    if (sign === 0) sign = side;
    else if (side !== sign) return false;
  }
  return true;
}

function centres(layout: DeliveryMapLayout): Record<string, GraphPoint> {
  return Object.fromEntries(
    layout.items.map((item) => [
      item.key,
      { x: item.x + layout.origin.x, y: item.y + layout.origin.y },
    ]),
  );
}

describe("DeliveryGraph layout", () => {
  it("lays out the same delivery in the same places every time", () => {
    expect(centres(layoutOf(fiftyUnitRecord()))).toEqual(centres(layoutOf(fiftyUnitRecord())));
  });

  it("leaves no two nodes on top of each other", () => {
    for (const record of [sharedCellRecord(), fiftyUnitRecord(), chainRecord(24)]) {
      expect(overlaps(layoutOf(record))).toEqual([]);
    }
  });

  it("draws one outline per stack around all of its units, with its label", () => {
    const layout = layoutOf(sharedCellRecord());
    expect(layout.hulls.map((hull) => [hull.stack, hull.unitCount])).toEqual([
      ["A", 4],
      ["D", 1],
    ]);
    for (const hull of layout.hulls) {
      const polygon = hullPoints(hull.path);
      for (const item of layout.items) {
        if (item.kind !== "unit" || item.unit.stack !== hull.stack) continue;
        const { left, top, right, bottom } = box(item);
        for (const corner of [
          { x: left, y: top },
          { x: right, y: top },
          { x: right, y: bottom },
          { x: left, y: bottom },
        ]) {
          expect(insideConvex(polygon, corner)).toBe(true);
        }
      }
      expect(insideConvex(polygon, { x: hull.labelX, y: hull.labelY })).toBe(true);
    }
  });

  it("keeps every node on the canvas", () => {
    const layout = layoutOf(fiftyUnitRecord());
    for (const item of layout.items) {
      const { left, top, right, bottom } = box(item);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(layout.width);
      expect(bottom).toBeLessThanOrEqual(layout.height);
    }
  });

  it("takes the shape of a wide or a tall viewport", () => {
    const wide = layoutOf(chainRecord(24), { aspect: 4 });
    const tall = layoutOf(chainRecord(24), { aspect: 0.5 });
    expect(wide.width / wide.height).toBeGreaterThan(tall.width / tall.height);
    expect(tall.height).toBeGreaterThan(tall.width);
  });

  it("keeps a node the operator placed where it was dropped, and starts the rest where they were", () => {
    const record = fourUnitRecord();
    const first = positionsOf(record);
    const positions = Object.fromEntries(first);
    const dropped = {
      x: (positions["unit:D"]?.x ?? 0) + 600,
      y: (positions["unit:D"]?.y ?? 0) - 300,
    };
    const kept: KeptGraphLayout = {
      positions: { ...positions, "unit:D": dropped },
      pinned: ["unit:D"],
    };
    const next = positionsOf(record, { kept });
    expect(next.get("unit:D")).toEqual(dropped);
    // A settle from the kept places moves the other nodes a little, not across
    // the graph.
    for (const [key, at] of first) {
      if (key === "unit:D") continue;
      const now = next.get(key);
      expect(Math.hypot((now?.x ?? 0) - at.x, (now?.y ?? 0) - at.y)).toBeLessThan(NODE_WIDTH);
    }
  });

  it("places a unit that the kept layout does not know", () => {
    const kept: KeptGraphLayout = {
      positions: Object.fromEntries(positionsOf(fourUnitRecord())),
      pinned: ["unit:A"],
    };
    const layout = layoutOf(sharedCellRecord(), { kept });
    expect(layout.items.map((item) => item.key)).toContain("unit:E");
    expect(overlaps(layout)).toEqual([]);
  });

  it("keeps every place when only a status changes", () => {
    const record = fourUnitRecord();
    const done = {
      ...record,
      units: record.units.map((unit) => (unit.id === "A" ? { ...unit, status: "done" } : unit)),
    };
    const before = orderedOf(record);
    const after = orderedOf(done);
    expect(selectGraphTopology(after.snapshot, after.units)).toEqual(
      selectGraphTopology(before.snapshot, before.units),
    );
    expect(centres(layoutOf(done))).toEqual(centres(layoutOf(record)));
  });

  it("joins a gate to every unit it follows, across stacks, with an arrowhead", () => {
    const record = fourUnitRecord();
    const layout = layoutOf({
      ...record,
      stack: {
        ...record.stack,
        gates: [
          { id: "gate-after-b-d", after: ["B", "D"], status: "pending", cases: ["FX-TC-001"] },
        ],
      },
    });
    const gateEdges = layout.edges.filter((edge) => edge.from === "gate:gate-after-b-d");
    expect(gateEdges.map((edge) => edge.to).sort()).toEqual(["unit:B", "unit:D"]);
    for (const edge of [...gateEdges, ...layout.edges]) {
      expect(edge.path).toMatch(/^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/);
      expect(edge.arrow).toMatch(/Z$/);
    }
  });
});

function renderGraph(
  layout: DeliveryMapLayout,
  props: Partial<Parameters<typeof DeliveryGraph>[0]> = {},
) {
  return render(
    <DeliveryGraph
      layout={layout}
      selectedKey={null}
      onSelect={() => undefined}
      onOpen={() => undefined}
      {...props}
    />,
  );
}

function viewportSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
}

// The canvas transform as numbers: translate x, translate y, scale.
function canvasTransform(): { x: number; y: number; k: number } {
  const transform = screen.getByTestId("delivery-graph-canvas").style.transform;
  const match = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(transform);
  if (match === null) throw new Error(`no transform in ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), k: Number(match[3]) };
}

// Where a node shows in the viewport, in pixels.
function onScreen(layout: DeliveryMapLayout, key: string) {
  const item = layout.items.find((entry) => entry.key === key);
  if (item === undefined) throw new Error(`no ${key}`);
  const { x, y, k } = canvasTransform();
  const { left, top, right, bottom } = box(item);
  return { left: x + left * k, top: y + top * k, right: x + right * k, bottom: y + bottom * k };
}

describe("DeliveryGraph", () => {
  it("shows each unit of a shared cell and opens each one", async () => {
    const onOpen = vi.fn();
    renderGraph(layoutOf(sharedCellRecord()), { onOpen });
    await userEvent.click(screen.getByTestId("unit-node-A"));
    await userEvent.click(screen.getByTestId("unit-node-E"));
    expect(onOpen.mock.calls).toEqual([[{ kind: "unit", id: "A" }], [{ kind: "unit", id: "E" }]]);
    expect(screen.getByTestId("delivery-lane-A")).toHaveTextContent("stack A · 4 units");
    expect(screen.getByTestId("delivery-stack-outline-A")).toBeTruthy();
    expect(screen.getByTestId("unit-layer-E")).toHaveTextContent("L0");
    expect(screen.getByTestId("unit-layer-B")).toHaveTextContent("L1");
  });

  it("names the node under focus on the detail line, with its dependencies", () => {
    renderGraph(layoutOf(fourUnitRecord()));
    const detail = screen.getByTestId("delivery-graph-detail");
    expect(detail).toHaveTextContent("Hover or focus a unit or a gate. Enter opens it.");
    act(() => screen.getByTestId("unit-node-B").focus());
    expect(detail).toHaveTextContent("B Second · after A");
    expect(
      within(screen.getByTestId("unit-node-B")).getByText("after A", { selector: ".sr-only" }),
    ).toBeTruthy();
  });

  it("names a unit's pull request number in its head", () => {
    const record = fourUnitRecord();
    renderGraph(
      layoutOf({
        ...record,
        units: record.units.map((unit) =>
          unit.id === "A" ? { ...unit, pr_url: "https://github.com/demo/demo/pull/42" } : unit,
        ),
      }),
    );
    expect(screen.getByTestId("unit-pr-number-A")).toHaveTextContent("#42");
    expect(screen.queryByTestId("unit-pr-number-B")).toBeNull();
    expect(screen.queryByTestId("unit-pr-A")).toBeNull();
  });

  it("shows a held unit's draft and not its pull request number", () => {
    const record = fourUnitRecord();
    const layout = layoutOf({
      ...record,
      units: record.units.map((unit) =>
        unit.id === "A" ? { ...unit, pr_url: "https://github.com/demo/demo/pull/42" } : unit,
      ),
    });
    // The provisional-gate state that holds a unit is covered by the
    // ProvisionalGate tests; this one only checks what a held node shows.
    renderGraph({
      ...layout,
      items: layout.items.map((item) =>
        item.kind === "unit" && item.unit.id === "A" ? { ...item, held: true } : item,
      ),
    });
    expect(screen.getByTestId("unit-pr-A")).toHaveTextContent("draft · held");
    expect(screen.queryByTestId("unit-pr-number-A")).toBeNull();
  });
});

describe("DeliveryGraph view", () => {
  it("opens on the whole graph, centred, at no more than 100%", () => {
    viewportSize(1600, 1000);
    const layout = layoutOf(fourUnitRecord());
    renderGraph(layout);
    expect(screen.getByTestId("delivery-graph-zoom")).toHaveTextContent("100%");
    for (const item of layout.items) {
      const at = onScreen(layout, item.key);
      expect(at.left).toBeGreaterThanOrEqual(0);
      expect(at.top).toBeGreaterThanOrEqual(0);
      expect(at.right).toBeLessThanOrEqual(1600);
      expect(at.bottom).toBeLessThanOrEqual(1000);
    }
  });

  it("opens on the live unit at a readable zoom when the whole graph would be too small to read", () => {
    viewportSize(400, 300);
    const record = fiftyUnitRecord();
    const live = record.units[30]?.id ?? "";
    const layout = layoutOf({
      ...record,
      units: record.units.map((unit) => (unit.id === live ? { ...unit, status: "running" } : unit)),
    });
    renderGraph(layout);
    expect(screen.getByTestId("delivery-graph-zoom")).toHaveTextContent("60%");
    const at = onScreen(layout, `unit:${live}`);
    expect(at.left).toBeGreaterThanOrEqual(0);
    expect(at.right).toBeLessThanOrEqual(400);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.bottom).toBeLessThanOrEqual(300);
  });

  it("zooms with the controls and the keys, and fits the graph again", async () => {
    viewportSize(1600, 1000);
    renderGraph(layoutOf(fourUnitRecord()));
    const zoom = screen.getByTestId("delivery-graph-zoom");
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(zoom).toHaveTextContent("80%");
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoom).toHaveTextContent("125%");
    act(() => screen.getByTestId("delivery-graph-scroll").focus());
    await userEvent.keyboard("-");
    expect(zoom).toHaveTextContent("100%");
    await userEvent.keyboard("--");
    expect(zoom).toHaveTextContent("64%");
    await userEvent.keyboard("0");
    expect(zoom).toHaveTextContent("100%");
  });

  it("zooms about the pointer with Ctrl and the wheel, and pans with a plain wheel", () => {
    viewportSize(400, 300);
    renderGraph(layoutOf(fiftyUnitRecord()));
    const viewport = screen.getByTestId("delivery-graph-scroll");
    const before = canvasTransform();
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    const zoomed = canvasTransform();
    expect(zoomed.k).toBeGreaterThan(before.k);

    const panned = fireEvent.wheel(viewport, { deltaX: 0, deltaY: 40 });
    expect(panned).toBe(false);
    expect(canvasTransform().y).toBeCloseTo(zoomed.y - 40);
    expect(canvasTransform().k).toBe(zoomed.k);
  });

  it("leaves a wheel the graph cannot follow to the page", () => {
    viewportSize(1600, 1000);
    renderGraph(layoutOf(fourUnitRecord()));
    const before = canvasTransform();
    // The whole graph is in view, so a pan has nowhere to go.
    const handled = fireEvent.wheel(screen.getByTestId("delivery-graph-scroll"), { deltaY: 4000 });
    expect(handled).toBe(true);
    expect(canvasTransform()).toEqual(before);
  });

  it("pans with a drag on the empty canvas and with the arrow keys", async () => {
    viewportSize(400, 300);
    renderGraph(layoutOf(fiftyUnitRecord()));
    const viewport = screen.getByTestId("delivery-graph-scroll");
    const before = canvasTransform();
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 70, clientY: 80 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 70, clientY: 80 });
    const dragged = canvasTransform();
    expect(dragged.x).toBeCloseTo(before.x - 30);
    expect(dragged.y).toBeCloseTo(before.y - 20);
    act(() => viewport.focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(canvasTransform().x).toBeCloseTo(dragged.x - 48);
  });

  it("pans a node that takes the focus into view", () => {
    viewportSize(400, 300);
    const layout = layoutOf(fiftyUnitRecord());
    renderGraph(layout);
    // The node furthest from the first view's middle.
    const far = [...layout.items].sort((a, b) => {
      const reach = (item: PlacedItem) => {
        const at = onScreen(layout, item.key);
        return Math.hypot(at.left - 200, at.top - 150);
      };
      return reach(b) - reach(a);
    })[0];
    if (far === undefined) throw new Error("no items");
    const element = screen.getByTestId(
      far.kind === "unit" ? `unit-node-${far.unit.id}` : `gate-marker-${far.view.gate.id}`,
    );
    act(() => element.focus());
    const at = onScreen(layout, far.key);
    expect(at.left).toBeGreaterThanOrEqual(0);
    expect(at.right).toBeLessThanOrEqual(400);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.bottom).toBeLessThanOrEqual(300);
  });
});

describe("DeliveryGraph node drag", () => {
  function dragNode(node: HTMLElement, dx: number, dy: number) {
    fireEvent.pointerDown(node, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(node, { pointerId: 2, clientX: 10 + dx, clientY: 10 + dy });
    fireEvent.pointerUp(node, { pointerId: 2, clientX: 10 + dx, clientY: 10 + dy });
    fireEvent.click(node);
  }

  it("moves a dragged node by the drag, at the zoom, and does not open it", () => {
    viewportSize(1600, 1000);
    const layout = layoutOf(fourUnitRecord());
    const onMoveNode = vi.fn();
    const onOpen = vi.fn();
    renderGraph(layout, { onMoveNode, onOpen });
    const before = centres(layout)["unit:B"] ?? { x: 0, y: 0 };
    dragNode(screen.getByTestId("unit-node-B"), 60, -40);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onMoveNode).toHaveBeenCalledTimes(1);
    const [key, centre] = onMoveNode.mock.calls[0] as [string, GraphPoint];
    expect(key).toBe("unit:B");
    expect(centre.x).toBeCloseTo(before.x + NODE_WIDTH / 2 + 60);
    expect(centre.y).toBeCloseTo(before.y + NODE_HEIGHT / 2 - 40);
  });

  it("opens a node pressed with less movement than a drag", () => {
    viewportSize(1600, 1000);
    const onMoveNode = vi.fn();
    const onOpen = vi.fn();
    renderGraph(layoutOf(fourUnitRecord()), { onMoveNode, onOpen });
    dragNode(screen.getByTestId("unit-node-B"), 2, 1);
    expect(onMoveNode).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith({ kind: "unit", id: "B" });
  });

  it("offers Reset layout only once a node has been moved", async () => {
    const { rerender } = renderGraph(layoutOf(fourUnitRecord()));
    expect(screen.getByRole("button", { name: "Reset layout" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const onResetLayout = vi.fn();
    rerender(
      <DeliveryGraph
        layout={layoutOf(fourUnitRecord())}
        selectedKey={null}
        onSelect={() => undefined}
        onOpen={() => undefined}
        onResetLayout={onResetLayout}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });
});
