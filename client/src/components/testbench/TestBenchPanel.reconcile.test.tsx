// @vitest-environment jsdom
//
// #440: the TestBench panel mounts the staleness banner + reconcile dialog +
// archived-cases surface (the #422 components, previously built standalone). This
// covers the wiring: the amber banner renders only when the server reports the
// plan stale, clicking Reconcile runs a preview and opens the dialog with the
// server-computed classification, Apply dispatches the apply mutation, and an
// orphaned result surfaces in the archived section.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TestCasesPlan, BenchResults, Case } from "@roubo/shared/testbench-contracts";
import type { ReconcileClassification } from "@roubo/shared/testbench-domain";
import type { TestbenchPlanResponse } from "../../lib/api";

const mockUseTestbenchPlan = vi.hoisted(() => vi.fn());
const mockPreviewMutate = vi.hoisted(() => vi.fn());
const mockApplyMutate = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useTestbenchPlan", () => ({
  useTestbenchPlan: () => mockUseTestbenchPlan(),
  useSetTestbenchFocus: () => ({ mutate: vi.fn(), isPending: false }),
}));
// Mock only the two data-fetching hooks; keep the real pure helpers
// (partitionSpecs / deriveSpecSummary) the spec-picker imports from this module.
vi.mock("../../hooks/useTestbenchSpecs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useTestbenchSpecs")>();
  return {
    ...actual,
    useTestbenchSpecs: () => ({ data: [], isLoading: false, isError: false, error: null }),
    useManualPathValidation: () => ({ status: "idle" }),
  };
});
vi.mock("../../hooks/useReconcile", () => ({
  useReconcilePreview: () => ({ mutate: mockPreviewMutate, isPending: false, error: null }),
  useReconcileApply: () => ({ mutate: mockApplyMutate, isPending: false, error: null }),
  useReconcilePurge: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

import TestBenchPanel from "./TestBenchPanel";

const FOCUSED = "/repo/.specifications/demo/test-cases.json";

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

const CLASSIFICATION: ReconcileClassification = {
  added: ["TC-D"],
  unchanged: [],
  changed: [],
  removed: ["TC-B"],
};

beforeEach(() => {
  vi.clearAllMocks();
  // The panel now defaults to the Batches view on first visit (#359); this suite
  // exercises the Cases view, so seed the persisted per-bench view to "cases".
  localStorage.clear();
  localStorage.setItem(
    "roubo-bench-view-state",
    JSON.stringify({ "p1:1": { testbenchViewMode: "cases" } }),
  );
});

describe("TestBenchPanel reconcile wiring (#440)", () => {
  it("does not render the staleness banner when the plan is not stale", () => {
    setPlan({ plan: plan([makeCase("TC-A")]), stale: false });
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.queryByTestId("staleness-banner")).not.toBeInTheDocument();
  });

  it("renders the banner when stale, and opens the reconcile dialog on Reconcile", async () => {
    const user = userEvent.setup();
    setPlan({ plan: plan([makeCase("TC-A")]), stale: true });
    mockPreviewMutate.mockImplementation((_vars, opts) => {
      opts.onSuccess({ classification: CLASSIFICATION, applied: false });
    });

    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.getByTestId("staleness-banner")).toBeInTheDocument();

    await user.click(screen.getByTestId("staleness-banner-reconcile"));
    expect(mockPreviewMutate).toHaveBeenCalled();

    const added = screen.getByTestId("reconcile-section-added");
    expect(within(added).getByText("TC-D")).toBeInTheDocument();
    const orphan = screen.getByTestId("reconcile-section-orphan");
    expect(within(orphan).getByText("TC-B")).toBeInTheDocument();

    await user.click(screen.getByTestId("reconcile-apply"));
    expect(mockApplyMutate).toHaveBeenCalledWith(
      { projectId: "p1", benchId: 1 },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("renders an orphaned result in the archived section", () => {
    const benchResults: BenchResults = {
      caseResults: {
        "TC-B": {
          observationMarks: {},
          derivedStatus: "failed",
          notes: [],
          orphaned: true,
        },
      },
      updatedAt: "2026-06-08T09:00:00.000Z",
    };
    setPlan({ plan: plan([makeCase("TC-A")]), results: benchResults, stale: false });
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.getByTestId("archived-case-TC-B")).toBeInTheDocument();
  });
});
