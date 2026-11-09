// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { selectDependencyOrder } from "@roubo/shared/delivery-selectors";
import type { DeliveryRecord } from "@roubo/shared/delivery-observation-contract";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import DeliveryGraph from "./DeliveryGraph";
import { NODE_HEIGHT, NODE_WIDTH, layoutDeliveryMap } from "./delivery-map-model";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function layoutOf(record: DeliveryRecord) {
  const snapshot = foldDelivery({ record, events: [] });
  const order = selectDependencyOrder(snapshot);
  if (order.kind !== "ordered") throw new Error("the fixture has a cycle");
  return layoutDeliveryMap(snapshot, order.units);
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

describe("DeliveryGraph layout", () => {
  it("puts units that share a stack and a layer one above the other and grows their lane", () => {
    const layout = layoutOf(sharedCellRecord());
    const place = (id: string) => {
      const item = layout.items.find((entry) => entry.key === `unit:${id}`);
      if (item === undefined) throw new Error(`no ${id}`);
      return item;
    };
    expect(place("E").x).toBe(place("A").x);
    expect(place("E").y).toBeGreaterThanOrEqual(place("A").y + NODE_HEIGHT);
    const [laneA, laneD] = layout.lanes;
    expect(laneA).toMatchObject({ stack: "A", unitCount: 4 });
    expect(laneA?.height).toBeGreaterThanOrEqual(2 * NODE_HEIGHT);
    expect(laneD?.top).toBeGreaterThanOrEqual(place("E").y + NODE_HEIGHT);
  });

  it("puts each gate in the gate lane, in the column after the last unit it follows", () => {
    const layout = layoutOf(fourUnitRecord());
    const gate = layout.items.find((entry) => entry.key === "gate:gate-after-b");
    const unitB = layout.items.find((entry) => entry.key === "unit:B");
    const lowest = Math.max(...layout.lanes.map((lane) => lane.top + lane.height));
    expect(gate?.x).toBe(layout.columns.find((column) => column.layer === 2)?.left);
    expect(gate?.x).toBeGreaterThan(unitB?.x ?? Infinity);
    expect(gate?.y).toBeGreaterThan(lowest);
    expect(layout.gateLane).toMatchObject({ gateCount: 2 });
    expect(layout.gateLane?.ruleTop).toBeGreaterThan(lowest);
    expect(layout.gateLane?.ruleTop).toBeLessThan(gate?.y ?? 0);
  });
});

describe("DeliveryGraph", () => {
  it("shows each unit of a shared cell and opens each one", async () => {
    const onOpen = vi.fn();
    render(
      <DeliveryGraph
        layout={layoutOf(sharedCellRecord())}
        selectedKey={null}
        onSelect={() => undefined}
        onOpen={onOpen}
      />,
    );
    const a = screen.getByTestId("unit-node-A");
    const e = screen.getByTestId("unit-node-E");
    expect(a.style.left).toBe(e.style.left);
    expect(parseFloat(e.style.top)).toBeGreaterThanOrEqual(parseFloat(a.style.top) + NODE_HEIGHT);
    await userEvent.click(a);
    await userEvent.click(e);
    expect(onOpen.mock.calls).toEqual([[{ kind: "unit", id: "A" }], [{ kind: "unit", id: "E" }]]);
    expect(screen.getByTestId("delivery-lane-A")).toHaveTextContent("4 units");
  });

  it("names the node under focus on the detail line, with its dependencies", () => {
    render(
      <DeliveryGraph
        layout={layoutOf(fourUnitRecord())}
        selectedKey={null}
        onSelect={() => undefined}
        onOpen={() => undefined}
      />,
    );
    const detail = screen.getByTestId("delivery-graph-detail");
    expect(detail).toHaveTextContent("Hover or focus a unit or a gate. Enter opens it.");
    act(() => screen.getByTestId("unit-node-B").focus());
    expect(detail).toHaveTextContent("B Second · after A");
    expect(
      within(screen.getByTestId("unit-node-B")).getByText("after A", { selector: ".sr-only" }),
    ).toBeTruthy();
  });

  it("scrolls the live unit into view when it opens past the visible width", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    const record = fourUnitRecord();
    // C, at layer 2, is the live unit, beyond a 400px view.
    const live = {
      ...record,
      units: record.units.map((unit) =>
        unit.id === "C"
          ? { ...unit, status: "running" }
          : unit.id === "A"
            ? { ...unit, status: "done" }
            : unit,
      ),
    };
    const layout = layoutOf(live);
    render(
      <DeliveryGraph
        layout={layout}
        selectedKey={null}
        onSelect={() => undefined}
        onOpen={() => undefined}
      />,
    );
    const nodeC = layout.items.find((entry) => entry.key === "unit:C");
    const scroller = screen.getByTestId("delivery-graph-scroll");
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    expect(scroller.scrollLeft).toBeLessThanOrEqual(nodeC?.x ?? 0);
    // The lane labels cover the first 104px of the view, so the node must end
    // inside the rest of it.
    expect(scroller.scrollLeft + 400).toBeGreaterThanOrEqual(104 + (nodeC?.x ?? 0) + NODE_WIDTH);
  });

  it("leaves the scroll at the start while the live unit is already in view", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    render(
      <DeliveryGraph
        layout={layoutOf(fourUnitRecord())}
        selectedKey={null}
        onSelect={() => undefined}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByTestId("delivery-graph-scroll").scrollLeft).toBe(0);
  });
});
