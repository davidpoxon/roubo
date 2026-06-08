// @vitest-environment jsdom
//
// #423 TC-007/TC-011/TC-014 (FR-024, US-013): the TestBench header carries the
// focused-spec identity and an explicit "Change focused spec" action that opens
// the spec-picker in re-point mode. Confirming re-points via the mutation;
// dismissing the picker changes nothing (explicit only). Staleness re-evaluation
// is a consequence of the plan refetch the mutation triggers (covered by the
// useSetTestbenchFocus invalidation test); here we cover the header surface.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TestCasesPlan, Case } from "@roubo/shared/testbench-contracts";
import type { TestbenchPlanResponse } from "../../lib/api";
import type { DiscoveredSpec } from "../../lib/api";
import type { ManualPathState } from "../../hooks/useTestbenchSpecs";

const mockUseTestbenchPlan = vi.hoisted(() => vi.fn());
const mockMutate = vi.hoisted(() => vi.fn());
const mockUseSetTestbenchFocus = vi.hoisted(() =>
  vi.fn(() => ({ mutate: mockMutate, isPending: false })),
);
const mockUseTestbenchSpecs = vi.hoisted(() => vi.fn());
const mockUseManualPathValidation = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useTestbenchPlan", () => ({
  useTestbenchPlan: (projectId: string, benchId: number) =>
    mockUseTestbenchPlan(projectId, benchId),
  useSetTestbenchFocus: () => mockUseSetTestbenchFocus(),
}));
vi.mock("../../hooks/useTestbenchSpecs", () => ({
  useTestbenchSpecs: (projectId: string, enabled?: boolean) =>
    mockUseTestbenchSpecs(projectId, enabled),
  useManualPathValidation: (projectId: string, path: string, enabled?: boolean) =>
    mockUseManualPathValidation(projectId, path, enabled),
}));

import TestBenchPanel from "./TestBenchPanel";

const FOCUSED = "/repo/.specifications/checkout/test-cases.json";

const SPECS: DiscoveredSpec[] = [
  { slug: "checkout", path: FOCUSED, caseCount: 2 },
  { slug: "billing", path: "/repo/.specifications/billing/test-cases.json", caseCount: 1 },
];

function makeCase(id: string): Case {
  return { id, title: `case ${id}`, level: "unit", priority: "P0", steps: [] };
}

function plan(cases: Case[]): TestCasesPlan {
  return {
    $schema: "x",
    schemaVersion: "1.0.0",
    specSlug: "checkout",
    cases,
  };
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
  mockUseSetTestbenchFocus.mockReturnValue({ mutate: mockMutate, isPending: false });
  mockUseTestbenchSpecs.mockReturnValue({
    data: SPECS,
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUseManualPathValidation.mockReturnValue({ status: "idle" } satisfies ManualPathState);
  setPlan({ plan: plan([makeCase("c1")]) });
});

describe("TestBenchPanel re-point header", () => {
  it("renders the focused-spec identity (slug + path) in the header", () => {
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.getAllByText("checkout").length).toBeGreaterThan(0);
    expect(screen.getByText(FOCUSED)).toBeInTheDocument();
  });

  it("omits the header when no focused spec is supplied", () => {
    render(<TestBenchPanel projectId="p1" benchId={1} />);
    expect(screen.queryByRole("button", { name: /Change focused spec/ })).not.toBeInTheDocument();
  });

  it("opens the spec-picker in re-point mode from the header action", async () => {
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    await userEvent.click(screen.getByRole("button", { name: /Change focused spec/ }));
    expect(screen.getByText("Change focused spec", { selector: "h2,span" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Re-point TestBench/ })).toBeInTheDocument();
  });

  it("flags the currently focused spec as Active in the re-point picker (#444, TC-007 step 2)", async () => {
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    await userEvent.click(screen.getByRole("button", { name: /Change focused spec/ }));
    const badge = screen.getByText("Active");
    // The focused path renders in both the header and the picker row; the picker
    // row is the one wrapped in a ToggleButton, so resolve it via the badge.
    const activeRow = badge.closest("button") as HTMLElement;
    expect(activeRow).toBeInTheDocument();
    expect(activeRow).toHaveTextContent("checkout");
  });

  it("confirming a different spec calls the re-point mutation with the new path", async () => {
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    await userEvent.click(screen.getByRole("button", { name: /Change focused spec/ }));
    await userEvent.click(screen.getByText("billing"));
    await userEvent.click(screen.getByRole("button", { name: /Re-point TestBench/ }));
    expect(mockMutate).toHaveBeenCalledWith(
      {
        projectId: "p1",
        benchId: 1,
        focusedSpecPath: "/repo/.specifications/billing/test-cases.json",
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("dismissing the picker does not call the re-point mutation (explicit only)", async () => {
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    await userEvent.click(screen.getByRole("button", { name: /Change focused spec/ }));
    await userEvent.click(screen.getByText("billing"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("renders the header even while the plan is loading", () => {
    mockUseTestbenchPlan.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.getByRole("button", { name: /Change focused spec/ })).toBeInTheDocument();
    expect(screen.getByText(/loading test cases/i)).toBeInTheDocument();
  });
});
