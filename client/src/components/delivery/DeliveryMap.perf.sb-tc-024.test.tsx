// @vitest-environment jsdom
/**
 * SB-TC-024 / SB-NFR-002: the delivery map renders a 50-unit record in under
 * 500 ms at the median and at p95, and each re-render after one of 100 events
 * stays under 500 ms.
 *
 * The map is rendered straight from a folded snapshot, so the measured cost is
 * the dependency order, the layout and the graph's render. The clock stops when
 * render() returns (it is act()-wrapped, so the commit is complete); the check
 * that every node painted runs after the sample, with a plain selector. Unlike
 * the repo's other perf files, this one runs in the default suite: the budget is
 * wide against a jsdom render of 50 nodes, and the run is the gate's evidence.
 * The numbers are jsdom render times, not real-browser paint times.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createDeliveryReducer, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import {
  FIFTY_UNIT_LAYERS,
  FIFTY_UNIT_STACKS,
  fiftyUnitRecord,
  unitChanged,
} from "../../test/delivery-fixtures";
import DeliveryMap from "./DeliveryMap";

const UNIT_COUNT = FIFTY_UNIT_STACKS * FIFTY_UNIT_LAYERS;
const ITERATIONS = 20;
const WARMUP_ITERATIONS = 5;
const EVENT_COUNT = 100;
const BUDGET_MS = 500;
const STATUSES = ["running", "done", "jammed", "pending"];

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function paintedNodes(root: HTMLElement): number {
  return root.querySelectorAll('[data-testid^="unit-node-"]').length;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it("SB-TC-024 renders the 50-unit map under 500 ms at the median and p95, including after 100 events", () => {
  const record = fiftyUnitRecord();
  const reducer = createDeliveryReducer();
  const first = reducer.fold({ record, events: [] });
  const map = (snapshot: DeliverySnapshot) => (
    <DeliveryMap projectId="demo" benchId={3} snapshot={snapshot} />
  );

  // Step 1: the render benchmark.
  for (let i = 0; i < WARMUP_ITERATIONS; i++) render(map(first)).unmount();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const view = render(map(first));
    samples.push(performance.now() - t0);
    expect(paintedNodes(view.container)).toBe(UNIT_COUNT);
    view.unmount();
  }

  // Step 2: 100 events, each folded into the next snapshot and rendered.
  const ids = record.units.map((unit) => unit.id);
  const events: DeliveryEvent[] = [];
  const view = render(map(first));
  const rerenders: number[] = [];
  for (let i = 0; i < EVENT_COUNT; i++) {
    events.push(
      unitChanged(
        record.last_event_seq + i + 1,
        ids[(i * 7) % ids.length],
        STATUSES[i % STATUSES.length],
      ),
    );
    const next = reducer.fold({ record, events: [...events] });
    const t0 = performance.now();
    view.rerender(map(next));
    rerenders.push(performance.now() - t0);
  }
  expect(paintedNodes(view.container)).toBe(UNIT_COUNT);
  const lastId = ids[((EVENT_COUNT - 1) * 7) % ids.length];
  expect(
    view.container
      .querySelector(`[data-testid="unit-node-${lastId}"]`)
      ?.getAttribute("data-status"),
  ).toBe(STATUSES[(EVENT_COUNT - 1) % STATUSES.length]);

  const medianMs = percentile(samples, 0.5);
  const p95Ms = percentile(samples, 0.95);
  const maxRerenderMs = Math.max(...rerenders);
  console.log(
    JSON.stringify({
      kind: "perf-evidence",
      tc: "SB-TC-024",
      unitCount: UNIT_COUNT,
      iterations: ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      medianMs,
      p95Ms,
      events: EVENT_COUNT,
      maxRerenderMs,
      budgetMs: BUDGET_MS,
    }),
  );

  expect(medianMs).toBeLessThan(BUDGET_MS);
  expect(p95Ms).toBeLessThan(BUDGET_MS);
  expect(maxRerenderMs).toBeLessThan(BUDGET_MS);
}, 120_000);
