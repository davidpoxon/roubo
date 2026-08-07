// @vitest-environment jsdom
//
// #770 (SATCA-FR-018, SATCA-TC-038/TC-042): a bench whose focused spec is
// archived still works, and says so. The plan response carries the spec's
// lifecycle state read from THIS bench's own workspace, so the panel labels the
// focused spec archived (or superseded, naming its replacement) while every other
// surface behaves exactly as it does for a live spec: the cases load, and marking
// an observation still dispatches its mutation.
//
// The lifecycle field is optional on the response, so a server that predates
// #770 (or a bench with no manifest at all) reads live and shows no label.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
// The spec picker this panel opens uses a react-query mutation (#773), so the
// panel must render inside a QueryClientProvider.
import { renderWithProviders as render } from "../../test/renderWithProviders";
import userEvent from "@testing-library/user-event";
import type { Case, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import type { SpecLifecycleState, TestbenchPlanResponse } from "../../lib/api";

const mockUseTestbenchPlan = vi.hoisted(() => vi.fn());
const mockMarkObservation = vi.hoisted(() => vi.fn());
// #775: the AC4 join needs a lifecycle mutation that can actually succeed, so
// the stub is controllable rather than inert. Defaulted to a no-op mutate in
// beforeEach, which is what every pre-#775 case in this suite assumes.
const mockSetCaseLifecycle = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useTestbenchPlan", () => ({
  useTestbenchPlan: () => mockUseTestbenchPlan(),
  useSetTestbenchFocus: () => ({ mutate: vi.fn(), isPending: false }),
  // #772: the panel's archived entries and the case detail pane both reach for
  // the lifecycle mutation.
  useSetCaseLifecycle: () => mockSetCaseLifecycle(),
  caseLifecycleErrorMessage: () => null,
}));
// Keep the real pure helpers the spec-picker imports; only the two fetching
// hooks are stubbed (mirrors TestBenchPanel.reconcile.test.tsx).
vi.mock("../../hooks/useTestbenchSpecs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useTestbenchSpecs")>();
  return {
    ...actual,
    useTestbenchSpecs: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
    useManualPathValidation: () => ({ status: "idle" }),
  };
});
vi.mock("../../hooks/useReconcile", () => ({
  useReconcilePreview: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useReconcileApply: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useReconcilePurge: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../../hooks/useTestbenchMarks", () => ({
  useMarkObservation: () => ({ mutate: mockMarkObservation, isPending: false, error: null }),
  useSetStatusOverride: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

import TestBenchPanel from "./TestBenchPanel";

const FOCUSED = "/repo/.specifications/retired-flow/test-cases.json";

function makeCase(id: string): Case {
  return {
    id,
    title: `case ${id}`,
    area: "test-area",
    level: 1,
    type: "functional",
    priority: "P0",
    steps: [
      {
        id: "S1",
        instruction: "Do the only thing",
        observations: [{ id: "O1", expected: "The only observation holds" }],
      },
    ],
    tags: [],
    linked_requirement_ids: ["FR-001"],
    linked_user_story_ids: [],
  };
}

function plan(cases: Case[]): TestCasesPlan {
  return { $schema: "x", schemaVersion: "1.0.0", specSlug: "retired-flow", cases };
}

function lifecycle(over: Partial<SpecLifecycleState> = {}): SpecLifecycleState {
  return { archived: false, reason: null, supersededBy: null, recordError: null, ...over };
}

function setPlan(data: Partial<TestbenchPlanResponse> = {}): void {
  mockUseTestbenchPlan.mockReturnValue({
    data: {
      plan: plan([makeCase("TC-A")]),
      results: null,
      stale: false,
      planHash: "h",
      recovered: false,
      ...data,
    },
    isLoading: false,
    isError: false,
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetCaseLifecycle.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  // This suite exercises the Cases view; the panel defaults to Batches (#359).
  localStorage.clear();
  localStorage.setItem(
    "roubo-bench-view-state",
    JSON.stringify({ "p1:1": { testbenchViewMode: "cases" } }),
  );
});

describe("TestBenchPanel archived focused spec (#770)", () => {
  it("shows no archived label for a live spec", () => {
    setPlan({ lifecycle: lifecycle() });
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.queryByTestId("focused-spec-archived")).not.toBeInTheDocument();
  });

  it("shows no archived label when the server omits the lifecycle field entirely", () => {
    setPlan();
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.queryByTestId("focused-spec-archived")).not.toBeInTheDocument();
  });

  // SATCA-TC-038 S001-O01/O02: the spec loads AND the panel says it is archived.
  it("labels the focused spec archived while still listing its cases", () => {
    setPlan({ lifecycle: lifecycle({ archived: true, reason: "Shipped in #212" }) });
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.getByTestId("focused-spec-archived")).toHaveTextContent("Archived");
    expect(screen.getAllByTestId("case-row").length).toBeGreaterThan(0);
  });

  it("labels a superseded focused spec distinctly and names its replacement", () => {
    setPlan({ lifecycle: lifecycle({ archived: true, supersededBy: "billing-v2" }) });
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.getByTestId("focused-spec-archived")).toHaveTextContent("Superseded");
    expect(screen.getByText("billing-v2")).toBeInTheDocument();
  });

  // SATCA-TC-042 S001-O01/O02/O03: an already-open bench keeps working when its
  // spec is archived, marking observations included.
  it("still marks observations with the spec archived", async () => {
    const user = userEvent.setup();
    setPlan({ lifecycle: lifecycle({ archived: true }) });
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.getByTestId("focused-spec-archived")).toBeInTheDocument();

    await user.click(screen.getAllByTestId("case-row")[0]);
    const detail = screen.getByRole("region", { name: /Case detail/ });
    await user.click(within(detail).getByRole("radio", { name: "Pass" }));

    expect(mockMarkObservation).toHaveBeenCalledWith(
      {
        projectId: "p1",
        benchId: 1,
        caseId: "TC-A",
        observationId: "O1",
        result: "pass",
      },
      expect.anything(),
    );
  });
});

// #775 AC4 (SATCA-TC-057 S002): retiring a case from the detail pane removes it
// from the live list, which unmounts the control that applied the action. The
// panel is the only place the two halves meet: CaseDetail reports the archived
// id upward, and the panel both announces the outcome and hands the id to the
// Archived section so the entry takes focus. Each half is covered against its own
// component; this exercises the join, which is what a reviewer actually relies on.
describe("TestBenchPanel focus and announcement after a case is archived (#775)", () => {
  function retiredCase(id: string): Case {
    return { ...makeCase(id), lifecycle: { state: "retired", reason: "covered by TC-B" } };
  }

  async function retireTheFirstCase(): Promise<void> {
    const user = userEvent.setup();
    // A mutation that actually succeeds, so CaseDetail runs its onSuccess and
    // reports the archived id up to the panel.
    mockSetCaseLifecycle.mockReturnValue({
      mutate: vi.fn((_vars, options?: { onSuccess?: () => void }) => options?.onSuccess?.()),
      isPending: false,
      error: null,
    });
    await user.click(screen.getAllByTestId("case-row")[0]);
    await user.click(screen.getByTestId("case-retire-open"));
    await user.type(screen.getByTestId("case-retire-reason"), "covered by TC-B");
    await user.click(screen.getByTestId("case-retire-submit"));
  }

  it("announces the outcome and focuses the archived entry once the refetched plan lists it", async () => {
    setPlan({ plan: plan([makeCase("TC-A"), makeCase("TC-B")]) });
    const { rerender } = render(
      <TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />,
    );

    // Nothing has been archived yet, so the region is mounted but silent. It has
    // to exist BEFORE the text changes or the update is not reliably announced.
    const live = screen.getByTestId("testbench-lifecycle-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");

    await retireTheFirstCase();

    // The refetched plan now carries the lifecycle record, which is what moves
    // the case out of the live list and into the Archived section.
    setPlan({ plan: plan([retiredCase("TC-A"), makeCase("TC-B")]) });
    rerender(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);

    expect(live).toHaveTextContent(
      "TC-A is now retired. It has moved to the Archived section, where it can be restored.",
    );
    expect(screen.getByTestId("archived-case-TC-A")).toHaveFocus();
  });

  it("stays silent until the refetched plan actually reports the case archived", async () => {
    setPlan({ plan: plan([makeCase("TC-A"), makeCase("TC-B")]) });
    render(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);

    await retireTheFirstCase();

    // The write succeeded but the plan has not come back yet, so the rollup lists
    // no archived entry. The notice states what the server recorded, never what
    // was merely submitted, so it stays empty rather than claiming a moved case.
    expect(screen.getByTestId("testbench-lifecycle-live")).toHaveTextContent("");
    expect(screen.queryByTestId("archived-case-TC-A")).not.toBeInTheDocument();
  });

  it("clears the notice and the focus target when another case is selected", async () => {
    const user = userEvent.setup();
    setPlan({ plan: plan([makeCase("TC-A"), makeCase("TC-B")]) });
    const { rerender } = render(
      <TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />,
    );

    await retireTheFirstCase();
    setPlan({ plan: plan([retiredCase("TC-A"), makeCase("TC-B")]) });
    rerender(<TestBenchPanel projectId="p1" benchId={1} focusedSpecPath={FOCUSED} />);
    expect(screen.getByTestId("testbench-lifecycle-live")).not.toHaveTextContent("");

    // Moving on to another case is the reviewer leaving the outcome behind; a
    // live region that kept the stale sentence would re-announce it later.
    await user.click(screen.getAllByTestId("case-row")[0]);
    expect(screen.getByTestId("testbench-lifecycle-live")).toHaveTextContent("");
  });
});
