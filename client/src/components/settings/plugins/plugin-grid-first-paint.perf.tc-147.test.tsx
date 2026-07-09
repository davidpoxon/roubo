// @vitest-environment jsdom
/// <reference types="node" />
// #279 pattern: references node types for the `process.env` perf-harness gate;
// the client tsconfig pins `types: ["vite/client"]`, so @types/node is not
// otherwise in scope for this file.
/**
 * TC-147: Plugin grid first-paint budget.
 *
 * Spec (.specifications/integration-plugins/test-cases.json):
 *   - Five plugins installed
 *   - Navigate to Settings > Plugins
 *   - First contentful paint of the grid < 100ms (NFR-017)
 *
 * Pattern mirrors TC-151 / TC-145 / TC-098: RUN_PERF_HARNESS=1 gates the latency
 * assertion, an inline p95 helper, a warmup render plus measured iterations, a
 * structured perf-evidence JSON log, and a sentinel test so the file always
 * contributes one passing assertion under the default coverage run.
 *
 * The grid is the real PluginCard component rendered five-up (the shape
 * PluginsTab's PluginList lays out). Cards are rendered `disabled` so the
 * per-card connection/integration React Query fetches are gated off: first
 * paint is the synchronous card-layout render (name, icon, enable switch,
 * primary action), which is what the 100ms budget covers. The async chip fill
 * that follows is a separate concern measured by TC-145.
 */

import { afterEach, describe, expect, test } from "vitest";
import { cleanup } from "@testing-library/react";
import type { PluginRecord, PluginStatus } from "@roubo/shared";
import PluginCard from "./PluginCard";
import ToastProvider from "../../ToastProvider";
import { renderWithProviders } from "../../../test/renderWithProviders";

const RUN = process.env.RUN_PERF_HARNESS === "1";
const RENDERS = 50;
const GRID_SIZE = 5;
const P95_BUDGET_MS = 100;

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function record(i: number, status: PluginStatus = "disabled"): PluginRecord {
  const id = `plugin-${i}`;
  return {
    id,
    manifest: {
      id,
      name: `Plugin ${i}`,
      version: "1.0.0",
      roubo: "^1.0.0",
      entry: "./index.js",
    } as PluginRecord["manifest"],
    manifestPath: `/plugins/${id}/roubo-plugin.yaml`,
    pluginDir: `/plugins/${id}`,
    source: "bundled" as PluginRecord["source"],
    status,
    lastError: null,
    restartHistory: [],
    pid: null,
  };
}

const GRID: PluginRecord[] = Array.from({ length: GRID_SIZE }, (_, i) => record(i));

function Grid() {
  return (
    <ToastProvider>
      <div>
        {GRID.map((p) => (
          <PluginCard key={p.id} plugin={p} hostApiVersion="1.0.0" />
        ))}
      </div>
    </ToastProvider>
  );
}

afterEach(() => {
  cleanup();
});

test.runIf(RUN)(
  "TC-147: plugin grid (5 cards) first-paint p95 < 100ms",
  () => {
    // Warmup render (not measured) to amortize first-render/module cost.
    renderWithProviders(<Grid />).unmount();

    const samples: number[] = [];
    for (let i = 0; i < RENDERS; i++) {
      const t0 = performance.now();
      const { unmount } = renderWithProviders(<Grid />);
      samples.push(performance.now() - t0);
      unmount();
    }

    const p95Ms = p95(samples);
    const maxMs = Math.max(...samples);

    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "TC-147",
          renders: RENDERS,
          gridSize: GRID_SIZE,
          p95Ms,
          maxMs,
        },
        null,
        2,
      ),
    );

    expect(p95Ms).toBeLessThan(P95_BUDGET_MS);
  },
  120_000,
);

describe("TC-147 harness (smoke)", () => {
  // Sentinel so the file always contributes one passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  test.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});
