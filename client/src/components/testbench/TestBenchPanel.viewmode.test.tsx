// @vitest-environment jsdom
//
// #359: Batches is the first toggle option and the default view on first visit
// (no remembered view), and the active Cases/Batches view is remembered per
// bench so it restores after navigating away (another tab or another bench) and
// back. Persistence rides the per-bench useBenchViewState localStorage store.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TestCasesPlan, Case } from "@roubo/shared/testbench-contracts";
import type { TestbenchPlanResponse } from "../../lib/api";

const mockUseTestbenchPlan = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useTestbenchPlan", () => ({
  useTestbenchPlan: (projectId: string, benchId: number) =>
    mockUseTestbenchPlan(projectId, benchId),
  useSetTestbenchFocus: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../hooks/useReconcile", () => ({
  useReconcilePreview: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
  useReconcileApply: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
  useReconcilePurge: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
}));
// Stub the verify-gate surface: the Batches view renders GatesOverview, which
// otherwise pulls React Query hooks needing a QueryClientProvider. The stub lets
// this suite focus on which view is shown without that machinery.
vi.mock("./GatesOverview", () => ({
  default: () => <div data-testid="gates-overview-stub" />,
}));

import TestBenchPanel from "./TestBenchPanel";

const STORAGE_KEY = "roubo-bench-view-state";

function makeCase(id: string): Case {
  return {
    id,
    title: `case ${id}`,
    area: "test-area",
    level: 1,
    type: "functional",
    priority: "P0",
    steps: [],
    tags: [],
    linked_requirement_ids: ["FR-001"],
    linked_user_story_ids: [],
  };
}

function plan(cases: Case[]): TestCasesPlan {
  return { $schema: "x", schemaVersion: "1.0.0", specSlug: "demo", cases };
}

function setPlan(data: Partial<TestbenchPlanResponse> & { plan: TestCasesPlan }): void {
  mockUseTestbenchPlan.mockReturnValue({
    data: { results: null, stale: false, planHash: "h", recovered: false, ...data },
    isLoading: false,
    isError: false,
    error: null,
  });
}

// The Batches view shows the stub; the Cases view shows the "Overall" rollup and
// never the stub. These markers tell the two views apart without touching the
// virtualised case list.
const batchesShown = () => screen.queryByTestId("gates-overview-stub") !== null;
const casesShown = () => screen.queryByText("Overall") !== null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPlan({ plan: plan([makeCase("c1"), makeCase("c2")]) });
});

describe("TestBenchPanel Cases/Batches view (#359)", () => {
  it("renders Batches as the first toggle option (left of Cases)", () => {
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    const toggles = screen
      .getAllByRole("button")
      .filter((b) => b.textContent === "Batches" || b.textContent === "Cases");
    expect(toggles.map((b) => b.textContent)).toEqual(["Batches", "Cases"]);
  });

  it("defaults to the Batches view on first visit (no remembered view)", () => {
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(batchesShown()).toBe(true);
    expect(casesShown()).toBe(false);
    expect(screen.getByRole("button", { name: "Batches", pressed: true })).toBeInTheDocument();
  });

  it("restores a remembered Cases view instead of the Batches default", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "p1:1": { testbenchViewMode: "cases" } }));
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(casesShown()).toBe(true);
    expect(batchesShown()).toBe(false);
    expect(screen.getByRole("button", { name: "Cases", pressed: true })).toBeInTheDocument();
  });

  it("remembers the selected view per bench across remounts (tab/bench navigation)", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TestBenchPanel projectId="p1" benchId={1} />);
    // Defaults to Batches, then the user switches to Cases.
    expect(batchesShown()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cases" }));
    expect(casesShown()).toBe(true);
    // The choice is persisted under the per-bench key.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")["p1:1"].testbenchViewMode).toBe(
      "cases",
    );

    // Navigate away and back: the panel unmounts and remounts, and the remembered
    // Cases view is restored rather than reverting to the Batches default.
    unmount();
    setPlan({ plan: plan([makeCase("c1"), makeCase("c2")]) });
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(casesShown()).toBe(true);
    expect(batchesShown()).toBe(false);
  });

  it("scopes the remembered view per bench instance", () => {
    // Bench 1 remembers Cases; bench 2 has no remembered view.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "p1:1": { testbenchViewMode: "cases" } }));

    const one = render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(casesShown()).toBe(true);
    one.unmount();

    // A different bench independently falls back to the Batches default.
    setPlan({ plan: plan([makeCase("c1"), makeCase("c2")]) });
    render(<TestBenchPanel projectId="p1" benchId={2} />);
    expect(batchesShown()).toBe(true);
    expect(casesShown()).toBe(false);
  });
});
