// @vitest-environment jsdom
/// <reference types="node" />
// References node types for the `process.env` perf-harness gate below; the
// client tsconfig pins `types: ["vite/client"]`, so @types/node is not otherwise
// in scope for this file.
/**
 * CLI-TC-011 / CLI-NFR-002: warm-load time-to-first-paint is under 200ms p95 on
 * revisit and after relaunch.
 *
 * The warm-cache path serves the persisted first-page snapshot synchronously
 * (the server returns it with `cacheStatus: 'revalidating'`, and React Query's
 * placeholderData paints it without a network round-trip), so the client paint
 * cost is the render of the populated cut list. This harness mocks useIssues to
 * return a warm snapshot immediately (modelling that synchronous warm serve) and
 * measures mount -> first visible populated row.
 *
 * The budget assertion is gated behind RUN_PERF_HARNESS=1 (mirrors TC-098 /
 * TC-151): warmup + measured iterations, inline p95, structured perf-evidence
 * log. A sentinel test keeps the file contributing a passing assertion under the
 * default coverage run. The non-gated structural test pins that a warm snapshot
 * paints populated rows without a loading skeleton (no "Loading..." flash).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { NormalizedIssue, RouboConfig } from "@roubo/shared";

vi.mock("../hooks/useIssues", () => ({
  useIssues: vi.fn(),
}));
vi.mock("../hooks/useProjectIntegration", () => ({
  useProjectIntegration: vi.fn(() => ({ data: undefined })),
}));
vi.mock("../hooks/usePlugins", () => ({
  usePlugins: vi.fn(() => ({ data: undefined })),
  useOpportunisticRecheckOnMount: vi.fn(),
}));
vi.mock("../hooks/useCutListFacets", () => ({
  useFilterFacets: vi.fn(() => ({ data: [] })),
  useSortFields: vi.fn(() => ({ data: [] })),
  useFacetOptions: vi.fn(() => ({ data: [], isLoading: false, isError: false })),
  usePrefetchFacetOptions: vi.fn(),
}));
vi.mock("./DraggableIssueCard", () => ({
  default: ({ issue }: { issue: NormalizedIssue }) => (
    <div data-testid="issue-card">{issue.externalId}</div>
  ),
}));
vi.mock("./CutListFilterBar", () => ({ default: () => <div data-testid="filter-bar" /> }));
vi.mock("./CutListGroupByControl", () => ({
  default: () => <div data-testid="group-by-control" />,
}));
vi.mock("./PluginConfigureDialog", () => ({ default: () => <div /> }));

import IssueQueuePanel from "./IssueQueuePanel";
import { useIssues } from "../hooks/useIssues";

const mockedUseIssues = vi.mocked(useIssues);

const RUN = process.env.RUN_PERF_HARNESS === "1";
const ITERATIONS = 20;
const ITEM_COUNT = 50;
const P95_BUDGET_MS = 200;

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function makeIssue(externalId: string): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId,
    externalUrl: `https://github.com/org/repo/issues/${externalId}`,
    title: `Issue ${externalId}`,
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2024-01-01T00:00:00Z",
    raw: null,
  };
}

function warmResult(items: NormalizedIssue[]): ReturnType<typeof useIssues> {
  return {
    issues: items,
    isLoading: false,
    nextCursor: null,
    error: null,
    stalled: false,
    stale: false,
    snapshotCapturedAt: "2026-06-01T12:00:00Z",
    excludedCount: 0,
    isRefetching: false,
    dataUpdatedAt: Date.now(),
    cacheStatus: "revalidating",
    refresh: vi.fn(),
  } as ReturnType<typeof useIssues>;
}

const config = {} as RouboConfig;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

it.runIf(RUN)(
  "CLI-TC-011: warm-load mount-to-first-row p95 < 200ms across relaunches",
  () => {
    const items = Array.from({ length: ITEM_COUNT }, (_, i) => makeIssue(String(i)));
    mockedUseIssues.mockReturnValue(warmResult(items));

    // Warmup render (not measured) to amortize first-render module/JIT cost.
    render(<IssueQueuePanel projectId="proj-1" benches={[]} projectConfig={config} />).unmount();

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const view = render(
        <IssueQueuePanel projectId="proj-1" benches={[]} projectConfig={config} />,
      );
      // First visible populated row present: this is the warm first meaningful paint.
      view.getAllByTestId("issue-card");
      samples.push(performance.now() - t0);
      view.unmount();
    }

    const p95Ms = p95(samples);
    const maxMs = Math.max(...samples);

    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "CLI-TC-011",
          iterations: ITERATIONS,
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

describe("CLI-TC-011 harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});

describe("CLI-TC-011: warm snapshot paints rows with no loading skeleton", () => {
  it("renders populated cards immediately and shows no Loading... skeleton on a warm serve", () => {
    const items = [makeIssue("a"), makeIssue("b")];
    mockedUseIssues.mockReturnValue(warmResult(items));
    render(<IssueQueuePanel projectId="proj-1" benches={[]} projectConfig={config} />);
    expect(screen.getAllByTestId("issue-card")).toHaveLength(2);
    expect(screen.queryByText("Loading...")).toBeNull();
  });
});
