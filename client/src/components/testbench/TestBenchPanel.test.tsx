// @vitest-environment jsdom
//
// #549: in Batches mode the panel must scope the gates overview to the bench's
// focused spec, the way the Cases tab already scopes to `focusedSpecPath`, instead
// of aggregating every spec's gates project-wide. This asserts the focused-spec
// slug (derived from the focusedSpecPath) is threaded into GatesOverview, and that
// no slug is passed when no spec is focused (the overview then shows its own
// focus-a-spec empty state).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";

// Force Batches mode so the panel renders GatesOverview (the surface under test),
// independent of the persisted per-bench view.
vi.mock("../../hooks/useBenchViewState", () => ({
  useBenchViewState: () => ({
    testbenchCaseListCollapsed: false,
    setTestbenchCaseListCollapsed: vi.fn(),
    testbenchViewMode: "batches",
    setTestbenchViewMode: vi.fn(),
  }),
}));

vi.mock("../../hooks/useTestbenchPlan", () => ({
  useTestbenchPlan: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  useSetTestbenchFocus: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../../hooks/useReconcile", () => ({
  useReconcilePreview: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReconcileApply: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReconcilePurge: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Stub the child surfaces so the test observes only the props TestBenchPanel
// threads. GatesOverview records the specSlug it receives into the DOM.
vi.mock("./GatesOverview", () => ({
  default: ({ specSlug }: { specSlug?: string }) => (
    <div data-testid="gates-overview-stub" data-spec-slug={specSlug ?? ""} />
  ),
}));
vi.mock("./BatchView", () => ({ default: () => <div data-testid="batch-view-stub" /> }));
vi.mock("./SpecPickerModal", () => ({ default: () => null }));

import TestBenchPanel from "./TestBenchPanel";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TestBenchPanel batches scoping (#549)", () => {
  it("threads the focused-spec slug into GatesOverview", () => {
    renderWithProviders(
      <TestBenchPanel
        projectId="p1"
        benchId={3}
        focusedSpecPath="/repo/.specifications/brigade-activity/test-cases.json"
      />,
    );
    const stub = screen.getByTestId("gates-overview-stub");
    expect(stub.getAttribute("data-spec-slug")).toBe("brigade-activity");
  });

  it("passes no slug into GatesOverview when no spec is focused", () => {
    renderWithProviders(<TestBenchPanel projectId="p1" benchId={3} />);
    const stub = screen.getByTestId("gates-overview-stub");
    expect(stub.getAttribute("data-spec-slug")).toBe("");
  });
});
