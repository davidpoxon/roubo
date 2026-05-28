// @vitest-environment jsdom
/// <reference types="node" />
// #279: references node types for the `process.env` perf-harness gate below;
// the client tsconfig pins `types: ["vite/client"]`, so @types/node is not
// otherwise in scope for this file.
/**
 * TC-151: Cut-list filter recompute + re-render budget.
 *
 * Spec (.specifications/integration-plugins/test-cases.json):
 *   - Load 500 issues into the cut list
 *   - Toggle a filter facet 50 times
 *   - p95 recompute + re-render latency < 50ms (NFR-021)
 *   - No additional server fetches triggered by toggle (FR-065)
 *
 * Pattern mirrors TC-098 in plugins/github-com/src/__tests__/list-issues.perf.tc-098.test.ts:
 * RUN_PERF_HARNESS=1 gating for the latency assertion, inline p95 helper,
 * warmup + measured iterations, structured perf-evidence JSON log, and a
 * sentinel test so the file always contributes one passing assertion under
 * the default coverage run.
 *
 * The fetch-invariant test is NOT gated; it is a fast structural check that
 * runs in every CI build. It pins the architectural property that toggling
 * cut-list filter state does not invalidate useIssues' React Query key, so a
 * future refactor that couples filter state into the issues fetch (e.g.
 * moving filters server-side) cannot silently regress NFR-021/FR-065.
 */

import { useEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import type { NormalizedIssue, PaginatedIssues } from "@roubo/shared";
import {
  applyFilters,
  createEmptyFilters,
  setFacetSelection,
  type FilterState,
} from "../lib/cut-list-filters";
import { useIssues } from "../hooks/useIssues";
import { renderWithProviders } from "../test/renderWithProviders";
import * as api from "../lib/api";

vi.mock("../lib/api", () => ({
  fetchIssuesPage: vi.fn(),
}));

const mockedFetch = vi.mocked(api.fetchIssuesPage);

const RUN = process.env.RUN_PERF_HARNESS === "1";
const TOGGLE_ITERATIONS = 50;
const ITEM_COUNT = 500;
const P95_BUDGET_MS = 50;

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function buildIssues(count: number): NormalizedIssue[] {
  const issues: NormalizedIssue[] = [];
  for (let i = 0; i < count; i++) {
    issues.push({
      integrationId: "github-com",
      externalId: String(i),
      externalUrl: `https://example/issues/${i}`,
      title: `Issue number ${i}`,
      body: null,
      currentState: i % 5 === 0 ? "Closed" : "Open",
      allowedTransitions: [],
      assignees: [],
      labels: [`label-${i % 7}`],
      issueType: i % 2 === 0 ? "Bug" : "Feature",
      blocks: [],
      blockedBy: [],
      updatedAt: "2026-01-01T00:00:00Z",
      raw: null,
      facetValues: { milestone: `v${(i % 10) + 1}.0` },
    });
  }
  return issues;
}

type SetFilters = (filters: FilterState) => void;
type OnReady = (setFilters: SetFilters) => void;

function PerfHarness({ issues, onReady }: { issues: NormalizedIssue[]; onReady: OnReady }) {
  const [filters, setFilters] = useState<FilterState>(() => createEmptyFilters());
  useEffect(() => {
    onReady(setFilters);
  }, [onReady]);
  // Mirrors the useMemo recompute pattern in client/src/components/IssueQueuePanel.tsx
  // (the source-of-truth recompute edge under test).
  const filtered = useMemo(
    () => applyFilters(issues, filters, { excludedStatuses: ["Closed"] }),
    [issues, filters],
  );
  return (
    <ul>
      {filtered.map((issue) => (
        <li key={issue.externalId}>
          {issue.title} {issue.issueType}
        </li>
      ))}
    </ul>
  );
}

function FetchInvariantHarness({ projectId, onReady }: { projectId: string; onReady: OnReady }) {
  // useIssues is called the same way IssueQueuePanel calls it (projectId only,
  // no filter args). If a future change pipes cut-list FilterState into
  // useIssues, the React Query key changes and the fetch count would climb.
  const { issues } = useIssues(projectId);
  const [filters, setFilters] = useState<FilterState>(() => createEmptyFilters());
  useEffect(() => {
    onReady(setFilters);
  }, [onReady]);
  const filtered = useMemo(
    () => applyFilters(issues, filters, { excludedStatuses: ["Closed"] }),
    [issues, filters],
  );
  return (
    <ul>
      {filtered.map((issue) => (
        <li key={issue.externalId}>{issue.title}</li>
      ))}
    </ul>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

test.runIf(RUN)(
  "TC-151: filter recompute + re-render p95 < 50ms across 50 toggles on 500 issues",
  async () => {
    const issues = buildIssues(ITEM_COUNT);
    let setter: SetFilters | null = null;
    render(
      <PerfHarness
        issues={issues}
        onReady={(s) => {
          setter = s;
        }}
      />,
    );

    await waitFor(() => expect(setter).not.toBeNull());
    const setFilters = setter as SetFilters | null;
    if (!setFilters) throw new Error("filter setter not ready");

    // Open with a Bug-only selection so each subsequent toggle swaps half the
    // result set rather than going from "all" to "half". This reflects the
    // realistic worst case for reconciliation cost on a populated cut list.
    let active: FilterState = setFacetSelection(createEmptyFilters(), "type", new Set(["Bug"]));
    await act(async () => {
      setFilters(active);
    });

    // One warmup toggle (not measured) to amortize first-reconciliation cost.
    active = setFacetSelection(active, "type", new Set(["Feature"]));
    await act(async () => {
      setFilters(active);
    });

    const samples: number[] = [];
    for (let i = 0; i < TOGGLE_ITERATIONS; i++) {
      const next = setFacetSelection(active, "type", new Set([i % 2 === 0 ? "Bug" : "Feature"]));
      const t0 = performance.now();
      await act(async () => {
        setFilters(next);
      });
      samples.push(performance.now() - t0);
      active = next;
    }

    const p95Ms = p95(samples);
    const maxMs = Math.max(...samples);

    // Surface the measurement so engineers running with RUN_PERF_HARNESS=1
    // can paste it into evidence comments (same shape as TC-098).
    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "TC-151",
          iterations: TOGGLE_ITERATIONS,
          itemCount: ITEM_COUNT,
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

describe("TC-151 harness (smoke)", () => {
  // Sentinel so the file always contributes one passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  test.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});

describe("TC-151: filter toggles do not trigger additional server fetches", () => {
  test("fetchIssuesPage call count is stable across 50 facet toggles", async () => {
    mockedFetch.mockResolvedValue({
      items: buildIssues(ITEM_COUNT),
      nextCursor: null,
    } as PaginatedIssues);

    let setter: SetFilters | null = null;
    renderWithProviders(
      <FetchInvariantHarness
        projectId="p1"
        onReady={(s) => {
          setter = s;
        }}
      />,
    );

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(setter).not.toBeNull());
    const callsAfterLoad = mockedFetch.mock.calls.length;
    const setFilters = setter as SetFilters | null;
    if (!setFilters) throw new Error("filter setter not ready");

    let active: FilterState = createEmptyFilters();
    for (let i = 0; i < TOGGLE_ITERATIONS; i++) {
      const next = setFacetSelection(active, "type", new Set([i % 2 === 0 ? "Bug" : "Feature"]));
      await act(async () => {
        setFilters(next);
      });
      active = next;
    }

    expect(mockedFetch.mock.calls.length).toBe(callsAfterLoad);
  });
});
