// @vitest-environment jsdom
// The Test bench tab of a Spec Bench (SB-FR-026, SB-FR-027): the gate
// sitting's phases, its stage control and the escalated cases on the TestBench
// case surface, marked through the case status route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { Bench } from "@roubo/shared";
import type { DeliverySnapshotResponse } from "@roubo/shared/delivery-bench";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import {
  TEST_CASES_SCHEMA_ID,
  type CaseStatus,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import { expectNoAxeFindings } from "../../test/axe";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchTestbenchPlan: vi.fn(),
    setStatusOverride: vi.fn(),
    openDeliverySitting: vi.fn(),
    closeDeliverySitting: vi.fn(),
  };
});

import * as api from "../../lib/api";
import SpecBenchTestBench, { GATE_CASES_STAGGER_MS } from "./SpecBenchTestBench";

const bench = {
  id: 3,
  projectId: "demo",
  variant: "specbench",
  focusedSpecPath: "/repo/.specifications/fixture-spec",
  workspacePath: "/benches/demo-3",
} as unknown as Bench;

const CASES = ["FX-TC-001", "FX-TC-002"];

const plan: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: "1.2.0",
  specSlug: "fixture-spec",
  cases: CASES.map((id) => ({
    id,
    title: `Case ${id}`,
    area: "fixture",
    level: 1,
    type: "functional",
    steps: [
      {
        id: "s1",
        instruction: `Open ${id}`,
        observations: [{ id: "o1", expected: `${id} behaves` }],
      },
    ],
    tags: [],
    linked_requirement_ids: ["FX-FR-001"],
    linked_user_story_ids: [],
  })),
};

// The four-unit record with the gate after B judging both cases.
function snapshot(sitting: DeliverySnapshotResponse["sitting"]): DeliverySnapshotResponse {
  const record = fourUnitRecord();
  record.stack.gates[0] = { ...record.stack.gates[0], cases: CASES };
  return { ...foldDelivery({ record, events: [] }), ...(sitting && { sitting }) };
}

function setReducedMotion(reduced: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduced && query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

beforeEach(() => {
  setReducedMotion(false);
  vi.mocked(api.fetchTestbenchPlan).mockResolvedValue({
    plan,
    results: null,
    stale: false,
    planHash: "hash",
    recovered: false,
  });
  vi.mocked(api.setStatusOverride).mockImplementation(async (_p, _b, _caseId, override) => ({
    observationMarks: {},
    derivedStatus: "not_started",
    statusOverride: {
      status: override as CaseStatus,
      author: { name: "Ada Operator", email: "ada@example.test" },
      timestamp: "2026-10-16T10:00:00Z",
    },
    notes: [],
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Spec Bench test bench tab", () => {
  it("SB-TC-063 lists the escalated cases on the TestBench case surface and marks one Met through its status control, and one Not met with a note, through the case status route", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    vi.mocked(api.setStatusOverride).mockImplementation(async (_p, _b, caseId, override) => ({
      observationMarks: {},
      derivedStatus: "not_started",
      statusOverride: {
        status: override as CaseStatus,
        author: { name: "Ada Operator", email: "ada@example.test" },
        timestamp: "2026-10-16T10:00:00Z",
      },
      notes: [],
      ...(caseId === "FX-TC-002" && {
        fixUnitError: { error: "The fix unit could not be filed." },
      }),
    }));
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const list = await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });
    const items = within(list).getAllByTestId("sitting-case");
    expect(items.map((item) => item.getAttribute("data-case-id"))).toEqual(CASES);

    // Each case renders on the TestBench case surface: its detail region, with
    // the case's title, its steps and observations, and its status control.
    CASES.forEach((caseId, index) => {
      const detail = within(items[index]).getByRole("region", {
        name: `Case detail: Case ${caseId}`,
      });
      expect(within(detail).getByRole("heading", { name: `Case ${caseId}` })).toBeInTheDocument();
      expect(within(detail).getByText(`Open ${caseId}`)).toBeInTheDocument();
      expect(within(detail).getByText(`${caseId} behaves`)).toBeInTheDocument();
      expect(within(detail).getByRole("button", { name: /Case status/ })).toBeInTheDocument();
    });

    // Met: the case surface's status control sets the override to Passed.
    await user.click(within(items[0]).getByRole("button", { name: /Case status/ }));
    await user.click(await screen.findByRole("option", { name: "Passed" }));
    await waitFor(() =>
      expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, "FX-TC-001", "passed"),
    );

    // Not met with evidence, through the same case status route.
    const evidenceToggle = within(items[1]).getByRole("button", {
      name: "Mark FX-TC-002 Not met with evidence",
    });
    expect(evidenceToggle).toHaveAttribute("aria-expanded", "false");
    await user.click(evidenceToggle);
    expect(evidenceToggle).toHaveAttribute("aria-expanded", "true");
    const form = screen.getByRole("form", { name: "Not met evidence for FX-TC-002" });
    await user.type(within(form).getByRole("textbox", { name: "Note" }), "Broken banner.");
    await user.click(within(form).getByRole("button", { name: "Mark Not met" }));
    await waitFor(() =>
      expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, "FX-TC-002", "failed", {
        note: "Broken banner.",
      }),
    );
    // A fix unit the server could not file shows as an alert on that case only.
    expect(await within(items[1]).findByRole("alert")).toHaveTextContent(
      "The fix unit could not be filed.",
    );
    expect(within(items[0]).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the gate blocked while a fix unit holds it, and the stage control opens a ready sitting", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({
        gateId: "gate-after-b",
        state: "ready",
        fixUnitBlockers: [
          { caseId: "FX-TC-001", fixRef: "example/fixture#77", filedAt: "2026-10-16T10:00:00Z" },
        ],
        blocked: true,
      }),
    );
    vi.mocked(api.openDeliverySitting).mockResolvedValue({ gateId: "gate-after-b" });
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    expect(await screen.findByTestId("sitting-gate-blocked")).toHaveTextContent(
      "example/fixture#77 (FX-TC-001)",
    );
    await user.click(screen.getByRole("button", { name: "Open the sitting" }));
    await waitFor(() =>
      expect(api.openDeliverySitting).toHaveBeenCalledWith("demo", 3, "gate-after-b"),
    );
  });

  it("SB-TC-067 the sitting phases, the case list and the stage control are reachable and named, the stagger does not steal focus and collapses under reduced motion, and axe finds nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    const { container, unmount } = renderWithProviders(<SpecBenchTestBench bench={bench} />);

    // Step 1: the three phases are named, the current one marked, and every
    // control is reached by Tab with a name.
    const phases = await screen.findByRole("list", { name: "Sitting phases" });
    expect(
      within(phases)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Waiting for build", "Ready to sit", "Sitting open"]);
    expect(within(phases).getByText("Sitting open")).toHaveAttribute("aria-current", "step");
    const list = await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });
    // The staggered entrance moved no focus.
    expect(document.activeElement).toBe(document.body);
    const items = within(list).getAllByTestId("sitting-case");
    expect(items.map((item) => item.style.animationDelay)).toEqual([
      "0ms",
      `${GATE_CASES_STAGGER_MS}ms`,
    ]);
    items.forEach((item) => expect(item).toHaveClass("animate-rise-in"));

    // Tab order: the stage control, then on each case's TestBench surface its
    // status control, its observation mark, its lifecycle actions and its notes,
    // and then its Not met evidence control. Each is found by its name.
    const expected: HTMLElement[] = [screen.getByRole("button", { name: "Close the sitting" })];
    CASES.forEach((caseId, index) => {
      const item = items[index];
      expected.push(
        within(item).getByRole("button", { name: /Case status/ }),
        within(
          within(item).getByRole("radiogroup", {
            name: `Mark observation pass or fail: ${caseId} behaves`,
          }),
        ).getByRole("radio", { name: "Pass" }),
        within(item).getByRole("button", { name: "Retire" }),
        within(item).getByRole("button", { name: "Supersede" }),
        within(item).getByRole("button", { name: "Notes (0)" }),
        within(item).getByRole("button", { name: `Mark ${caseId} Not met with evidence` }),
      );
    });
    for (const element of expected) {
      await user.tab();
      expect(document.activeElement).toBe(element);
    }

    // Step 3: no WCAG 2.1 AA finding with the case surfaces rendered, and with
    // the evidence form open too.
    expectNoAxeFindings(await axe(container));
    await user.click(
      within(items[0]).getByRole("button", { name: "Mark FX-TC-001 Not met with evidence" }),
    );
    const form = screen.getByRole("form", { name: "Not met evidence for FX-TC-001" });
    expect(within(form).getByRole("textbox", { name: "Note" })).toBeInTheDocument();
    expect(within(form).getByLabelText("Screenshot")).toBeInTheDocument();
    expectNoAxeFindings(await axe(container));
    unmount();

    // Step 2: under reduced motion the cases appear at once, with no stagger.
    setReducedMotion(true);
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const reducedList = await screen.findByRole("list", {
      name: "Escalated cases of gate gate-after-b",
    });
    for (const item of within(reducedList).getAllByTestId("sitting-case")) {
      expect(item).not.toHaveClass("animate-rise-in");
      expect(item.style.animationDelay).toBe("");
    }
  });
});
