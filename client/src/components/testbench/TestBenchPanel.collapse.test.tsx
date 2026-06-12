// @vitest-environment jsdom
//
// #524: the test-case list can be collapsed once a case is selected, handing its
// width to the case-detail pane while the selected case stays shown. The collapse
// is persisted per bench via useBenchViewState (localStorage).

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
// CaseDetail mounts mark/note hooks; mock them so the pane renders without a
// QueryClientProvider.
vi.mock("../../hooks/useTestbenchMarks", () => ({
  useMarkObservation: () => ({ mutate: vi.fn(), isPending: false }),
  useSetStatusOverride: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../hooks/useTestbenchNotes", () => ({
  useAppendNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

import TestBenchPanel from "./TestBenchPanel";

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
  return { $schema: "x", schemaVersion: "1.0.0", specSlug: "checkout", cases };
}

function setPlan(data: Partial<TestbenchPlanResponse> & { plan: TestCasesPlan }): void {
  mockUseTestbenchPlan.mockReturnValue({
    data: { results: null, stale: false, planHash: "h", recovered: false, ...data },
    isLoading: false,
    isError: false,
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPlan({ plan: plan([makeCase("c1"), makeCase("c2")]) });
});

describe("TestBenchPanel case-list collapse (#524)", () => {
  it("offers no collapse control until a case is selected", () => {
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(
      screen.queryByRole("button", { name: /collapse test case list/i }),
    ).not.toBeInTheDocument();
  });

  it("collapses the list, keeps the selected case shown, and restores via expand", async () => {
    const user = userEvent.setup();
    render(<TestBenchPanel projectId="p1" benchId={1} />);

    // Select a case: the detail pane and a collapse control appear.
    await user.click(screen.getByText("case c1"));
    expect(screen.getByRole("heading", { name: "case c1" })).toBeInTheDocument();
    const collapse = screen.getByRole("button", { name: /collapse test case list/i });

    // Collapse: the list rows are hidden but the selected case detail stays.
    await user.click(collapse);
    expect(screen.queryAllByTestId("case-row")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "case c1" })).toBeInTheDocument();

    // Expand restores the list.
    await user.click(screen.getByRole("button", { name: /expand test case list/i }));
    expect(screen.getAllByTestId("case-row").length).toBeGreaterThan(0);
  });

  it("persists the collapsed state per bench across remounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TestBenchPanel projectId="p1" benchId={1} />);
    await user.click(screen.getByText("case c1"));
    await user.click(screen.getByRole("button", { name: /collapse test case list/i }));
    unmount();

    setPlan({ plan: plan([makeCase("c1"), makeCase("c2")]) });
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    await user.click(screen.getByText("case c1"));
    // The persisted collapse applies immediately on the next selection.
    expect(screen.queryAllByTestId("case-row")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /expand test case list/i })).toBeInTheDocument();
  });
});
