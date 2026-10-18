// @vitest-environment jsdom
/// <reference types="node" />
// References node types for the `process.env` perf-harness gate below; the client
// tsconfig pins `types: ["vite/client"]`, so @types/node is not otherwise in scope
// for this file.
/**
 * SB-TC-024 / SB-NFR-002: the delivery map renders a 50-unit record in under
 * 500 ms at the median and at p95, and each re-render after one of 100 events
 * stays under 500 ms.
 *
 * The map is rendered straight from a folded snapshot, so the measured cost is
 * the dependency order, the layout and the graph's render. The clock stops when
 * render() returns (it is act()-wrapped, so the commit is complete); the check
 * that every node painted runs after the sample, with a plain selector. The
 * budget assertion is gated behind RUN_PERF_HARNESS=1, the repo's perf
 * convention (`npm run test:perf`), like the other perf files: WARMUP_ITERATIONS
 * unmeasured renders, then measured iterations, inline median and p95, a
 * structured perf-evidence log. A sentinel keeps the file contributing a passing
 * assertion under the default run, where the measured test is skipped, and a
 * non-gated structural test pins that the 50-unit record paints every node and
 * that a folded event reaches its node. The structural test asserts no budget,
 * so its name carries no case id. The numbers are jsdom render times, not
 * real-browser paint times.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const RUN = process.env.RUN_PERF_HARNESS === "1";
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

function benchmarkMap() {
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
}

it.runIf(RUN)(
  "SB-TC-024 renders the 50-unit map under 500 ms at the median and p95, including after 100 events",
  benchmarkMap,
  120_000,
);

describe("delivery map perf harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});

describe("delivery map on the 50-unit record", () => {
  it("paints every unit node and shows a folded event on its node", () => {
    const record = fiftyUnitRecord();
    const reducer = createDeliveryReducer();
    const id = record.units[0].id;
    const view = render(
      <DeliveryMap projectId="demo" benchId={3} snapshot={reducer.fold({ record, events: [] })} />,
    );
    expect(paintedNodes(view.container)).toBe(UNIT_COUNT);

    const done = unitChanged(record.last_event_seq + 1, id, "done");
    const next = reducer.fold({ record, events: [done] });
    view.rerender(<DeliveryMap projectId="demo" benchId={3} snapshot={next} />);
    expect(paintedNodes(view.container)).toBe(UNIT_COUNT);
    expect(
      view.container.querySelector(`[data-testid="unit-node-${id}"]`)?.getAttribute("data-status"),
    ).toBe("done");
  });
});
