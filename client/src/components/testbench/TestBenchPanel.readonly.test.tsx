// @vitest-environment jsdom
//
// #1653: a read-only TestBench. A Spec Bench shows its spec's full TestBench
// outside a gate sitting, where the server refuses every write, so the panel
// shows the same surfaces with no write control: no Change focused spec, no
// Reconcile, no marks, notes or lifecycle actions, no Restore, and on the
// Batches view no Combine, Split, Sign off or fix issue. Without the prop the
// panel offers every one of them, as before.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders as render } from "../../test/renderWithProviders";
import type { Case, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import type { TestbenchPlanResponse } from "../../lib/api";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchTestbenchPlan: vi.fn(),
    fetchGates: vi.fn(),
    fetchGate: vi.fn(),
  };
});

import * as api from "../../lib/api";
import TestBenchPanel from "./TestBenchPanel";

const FOCUSED = "/repo/.specifications/fixture-spec/test-cases.json";
const STORAGE_KEY = "roubo-bench-view-state";

function makeCase(id: string, over: Partial<Case> = {}): Case {
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
    ...over,
  };
}

const plan: TestCasesPlan = {
  $schema: "x",
  schemaVersion: "1.2.0",
  specSlug: "fixture-spec",
  cases: [
    makeCase("TC-A"),
    makeCase("TC-B"),
    makeCase("TC-OLD", { lifecycle: { state: "retired", reason: "covered by TC-A" } }),
  ],
};

// A failed gate with two covering units, so the card offers Split, and a second
// gate, so the overview offers Combine.
const gates = [
  {
    gateId: "WU-010",
    status: "failed",
    unresolvedCaseIds: ["TC-A"],
    gatingCaseIds: ["TC-A"],
    coveringUnitIds: ["WU-001", "WU-002"],
    blockedBy: [],
    signedOff: false,
  },
  {
    gateId: "WU-020",
    status: "passed",
    unresolvedCaseIds: [],
    gatingCaseIds: ["TC-B"],
    coveringUnitIds: ["WU-003"],
    blockedBy: [],
    signedOff: false,
  },
];

function setView(mode: "cases" | "batches"): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ "demo:3": { testbenchViewMode: mode } }));
}

function renderPanel(readOnly: boolean) {
  return render(
    <TestBenchPanel projectId="demo" benchId={3} focusedSpecPath={FOCUSED} readOnly={readOnly} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  const response: TestbenchPlanResponse = {
    plan,
    // TC-A failed, so the batch view would offer its fix issue panel.
    results: {
      caseResults: {
        "TC-A": { observationMarks: {}, derivedStatus: "failed", notes: [] },
      },
    } as unknown as TestbenchPlanResponse["results"],
    stale: true,
    planHash: "h",
    recovered: false,
  };
  vi.mocked(api.fetchTestbenchPlan).mockResolvedValue(response);
  vi.mocked(api.fetchGates).mockResolvedValue({ gates, invalidSpecs: [] } as never);
  vi.mocked(api.fetchGate).mockResolvedValue(gates[0] as never);
});

describe("TestBenchPanel read-only (#1653)", () => {
  it("shows the cases, the progress, the case detail and the archived cases with no write control", async () => {
    const user = userEvent.setup();
    setView("cases");
    renderPanel(true);

    // The spec's cases and its progress show.
    const rows = await screen.findAllByTestId("case-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Overall")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change focused spec" })).toBeNull();

    // The plan changed, and the banner says so, with no Reconcile action.
    expect(screen.getByTestId("staleness-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("staleness-banner-reconcile")).toBeNull();

    // The case detail shows the case, with its marks disabled and no lifecycle
    // action or add-note form.
    await user.click(rows[0]);
    const detail = screen.getByRole("region", { name: "Case detail: case TC-A" });
    expect(within(detail).getByText("Do the only thing")).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: /Case status/ })).toBeDisabled();
    expect(within(detail).getByRole("radio", { name: "Pass" })).toBeDisabled();
    expect(within(detail).queryByTestId("case-retire-open")).toBeNull();
    expect(within(detail).queryByTestId("case-supersede-open")).toBeNull();
    // A narrow pane puts the notes in a drawer: open it, and the notes show
    // with no add-note form.
    await user.click(within(detail).getByRole("button", { name: "Notes (0)" }));
    expect(within(detail).getByText("No notes yet.")).toBeInTheDocument();
    expect(within(detail).queryByRole("textbox", { name: "Add a note" })).toBeNull();

    // The archived case shows, with no Restore.
    expect(screen.getByTestId("archived-case-TC-OLD")).toBeInTheDocument();
    expect(screen.queryByTestId("archived-restore-TC-OLD")).toBeNull();
  });

  it("lists and opens the batches with no Combine, Split, Sign off or fix issue", async () => {
    const user = userEvent.setup();
    setView("batches");
    renderPanel(true);

    expect(await screen.findAllByTestId("gate-card")).toHaveLength(2);
    expect(screen.queryByTestId("merge-mode-trigger")).toBeNull();
    expect(screen.queryByTestId("gate-split-trigger")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open gate WU-010" }));
    expect(await screen.findByRole("button", { name: "Back to batches" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign off batch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();

    await user.click((await screen.findAllByTestId("case-row"))[0]);
    const detail = screen.getByRole("region", { name: "Case detail: case TC-A" });
    expect(within(detail).getByRole("button", { name: /Case status/ })).toBeDisabled();
    expect(screen.queryByLabelText("File fix issue")).toBeNull();
  });

  it("offers every write control without the prop", async () => {
    const user = userEvent.setup();
    setView("cases");
    renderPanel(false);

    const rows = await screen.findAllByTestId("case-row");
    expect(screen.getByRole("button", { name: "Change focused spec" })).toBeInTheDocument();
    expect(screen.getByTestId("staleness-banner-reconcile")).toBeInTheDocument();
    expect(screen.getByTestId("archived-restore-TC-OLD")).toBeInTheDocument();
    await user.click(rows[0]);
    const detail = screen.getByRole("region", { name: "Case detail: case TC-A" });
    expect(within(detail).getByRole("button", { name: /Case status/ })).toBeEnabled();
    expect(within(detail).getByTestId("case-retire-open")).toBeInTheDocument();
    await user.click(within(detail).getByRole("button", { name: "Notes (0)" }));
    expect(within(detail).getByRole("textbox", { name: "Add a note" })).toBeInTheDocument();
  });

  it("offers Combine, Split and the fix issue on the batches without the prop", async () => {
    const user = userEvent.setup();
    setView("batches");
    renderPanel(false);

    expect(await screen.findAllByTestId("gate-card")).toHaveLength(2);
    expect(screen.getByTestId("merge-mode-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("gate-split-trigger")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open gate WU-010" }));
    expect(await screen.findByRole("button", { name: "Sign off batch" })).toBeInTheDocument();
    await user.click((await screen.findAllByTestId("case-row"))[0]);
    expect(await screen.findByLabelText("File fix issue")).toBeInTheDocument();
  });
});
