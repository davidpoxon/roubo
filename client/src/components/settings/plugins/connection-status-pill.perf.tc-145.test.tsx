// @vitest-environment jsdom
/// <reference types="node" />
// #279 pattern: references node types for the `process.env` perf-harness gate;
// the client tsconfig pins `types: ["vite/client"]`, so @types/node is not
// otherwise in scope for this file.
/**
 * TC-145: Cached status chip render budget.
 *
 * Spec (.specifications/integration-plugins/test-cases.json):
 *   - Plugin manager has cached ConnectionStatus values
 *   - Mount the status chip repeatedly in a perf harness
 *   - p95 < 50ms from mount to first paint of the status chip (NFR-017)
 *
 * Pattern mirrors TC-151 (cut-list-filter-recompute.perf.tc-151.test.tsx) and
 * TC-098 (plugins/github-com/.../list-issues.perf.tc-098.test.ts):
 * RUN_PERF_HARNESS=1 gates the latency assertion, an inline p95 helper, a warmup
 * mount plus measured iterations, a structured perf-evidence JSON log, and a
 * sentinel test so the file always contributes one passing assertion under the
 * default coverage run.
 *
 * ConnectionStatusPill renders synchronously from an already-resolved
 * ConnectionStatus (the "cached" case: no query, no async). The harness measures
 * the mount -> rendered cost of that pure render, guarding against a regression
 * that makes the cached chip render path expensive (NFR-017's 50ms budget).
 */

import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ConnectionStatus } from "@roubo/shared";
import ConnectionStatusPill from "./ConnectionStatusPill";

const RUN = process.env.RUN_PERF_HARNESS === "1";
const MOUNTS = 100;
const P95_BUDGET_MS = 50;

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

// A representative cached status per the five-variant taxonomy, cycled across
// mounts so the measurement covers every rendered variant (not just the cheap
// disabled one).
const CACHED_STATUSES: ConnectionStatus[] = [
  { state: "connected", checkedAt: "2026-05-27T10:00:00.000Z", account: { login: "octocat" } },
  { state: "disconnected", checkedAt: "2026-05-27T10:00:00.000Z" },
  {
    state: "auth-problem",
    detail: "Token missing security_events scope",
    checkedAt: "2026-05-27T10:00:00.000Z",
  },
  { state: "errored", detail: "Plugin crashed", checkedAt: "2026-05-27T10:00:00.000Z" },
  { state: "disabled" },
];

afterEach(() => {
  cleanup();
});

test.runIf(RUN)(
  "TC-145: cached status chip render p95 < 50ms across 100 mounts",
  () => {
    // Warmup mount (not measured) to amortize first-render/module cost.
    const warm = render(<ConnectionStatusPill status={CACHED_STATUSES[0]} />);
    warm.unmount();

    const samples: number[] = [];
    for (let i = 0; i < MOUNTS; i++) {
      const status = CACHED_STATUSES[i % CACHED_STATUSES.length];
      const t0 = performance.now();
      const { unmount } = render(<ConnectionStatusPill status={status} />);
      samples.push(performance.now() - t0);
      unmount();
    }

    const p95Ms = p95(samples);
    const maxMs = Math.max(...samples);

    console.log(
      JSON.stringify(
        { kind: "perf-evidence", tc: "TC-145", mounts: MOUNTS, p95Ms, maxMs },
        null,
        2,
      ),
    );

    expect(p95Ms).toBeLessThan(P95_BUDGET_MS);
  },
  120_000,
);

describe("TC-145 harness (smoke)", () => {
  // Sentinel so the file always contributes one passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  test.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});
