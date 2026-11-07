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
    steps: [],
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
  it("lists the escalated cases on the case surface and marks one Met, and one Not met with a note, through the case status route", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const list = await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });
    const surfaces = within(list).getAllByTestId("testbench-case-surface");
    expect(surfaces.map((s) => s.getAttribute("data-case-id"))).toEqual(CASES);

    await user.click(within(surfaces[0]).getByRole("button", { name: "Met" }));
    await waitFor(() =>
      expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, "FX-TC-001", "passed"),
    );

    await user.click(within(surfaces[1]).getByRole("button", { name: "Not met" }));
    const form = screen.getByRole("form", { name: "Not met evidence for FX-TC-002" });
    await user.type(within(form).getByRole("textbox", { name: "Note" }), "Broken banner.");
    await user.click(within(form).getByRole("button", { name: "Mark Not met" }));
    await waitFor(() =>
      expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, "FX-TC-002", "failed", {
        note: "Broken banner.",
      }),
    );
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

    const reached: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await user.tab();
      const focused = document.activeElement as HTMLElement;
      expect(focused).not.toBe(document.body);
      reached.push(focused.textContent ?? "");
    }
    expect(reached).toEqual(["Close the sitting", "Met", "Not met", "Met", "Not met"]);
    expect(
      within(list)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Mark FX-TC-001", "Mark FX-TC-002"]);

    // Step 3: no WCAG 2.1 AA finding, with the evidence form open too.
    expectNoAxeFindings(await axe(container));
    await user.click(within(items[0]).getByRole("button", { name: "Not met" }));
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
