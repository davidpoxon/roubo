// @vitest-environment jsdom
// The Test bench tab of a Spec Bench (SB-FR-026, SB-FR-027): the gate
// sitting's banner for its phase, its stage control, and the Cases list beside
// the Case panel, which shows the chosen case on the TestBench case surface,
// marked through the case status route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { Bench } from "@roubo/shared";
import type { DeliverySnapshotResponse } from "@roubo/shared/delivery-bench";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import {
  TEST_CASES_SCHEMA_ID,
  type CaseResult,
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
    stageTestbenchCase: vi.fn(),
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

type User = ReturnType<typeof userEvent.setup>;

// Chooses a case in the Cases list and returns the Case panel that shows it.
async function openCase(user: User, list: HTMLElement, caseId: string): Promise<HTMLElement> {
  await user.click(within(list).getByRole("button", { name: new RegExp(`^${caseId} ·`) }));
  return screen.getByRole("region", { name: `Case ${caseId}` });
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

    // The first case shows in the Case panel until another is chosen.
    expect(screen.getByRole("region", { name: "Case FX-TC-001" })).toBeInTheDocument();

    // Each case, once chosen, renders on the TestBench case surface: its detail
    // region, with the case's title, its steps and observations, and its
    // status control. The chosen row is marked current.
    for (const caseId of CASES) {
      const panel = await openCase(user, list, caseId);
      expect(
        within(list).getByRole("button", { name: new RegExp(`^${caseId} ·`) }),
      ).toHaveAttribute("aria-current", "true");
      expect(within(panel).getByTestId("testbench-case-surface")).toHaveAttribute(
        "data-case-id",
        caseId,
      );
      const detail = within(panel).getByRole("region", { name: `Case detail: Case ${caseId}` });
      expect(within(detail).getByRole("heading", { name: `Case ${caseId}` })).toBeInTheDocument();
      expect(within(detail).getByText(`Open ${caseId}`)).toBeInTheDocument();
      expect(within(detail).getByText(`${caseId} behaves`)).toBeInTheDocument();
      expect(within(detail).getByRole("button", { name: /Case status/ })).toBeInTheDocument();
    }

    // Met: the case surface's status control sets the override to Passed.
    const first = await openCase(user, list, "FX-TC-001");
    await user.click(within(first).getByRole("button", { name: /Case status/ }));
    await user.click(await screen.findByRole("option", { name: "Passed" }));
    await waitFor(() =>
      expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, "FX-TC-001", "passed"),
    );

    // Not met with evidence, through the same case status route.
    const second = await openCase(user, list, "FX-TC-002");
    const evidenceToggle = within(second).getByRole("button", {
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
    expect(await within(second).findByRole("alert")).toHaveTextContent(
      "The fix unit could not be filed.",
    );
    expect(
      within(await openCase(user, list, "FX-TC-001")).queryByRole("alert"),
    ).not.toBeInTheDocument();
  });

  it("SB-TC-062 the case surface shows the staged state after the stage route answers 200, and says the case opened cold after 404", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    vi.mocked(api.stageTestbenchCase).mockImplementation(async (_p, _b, caseId) => {
      if (caseId === "FX-TC-002") {
        throw new api.ApiError(
          "Case FX-TC-002 has no state recipe, so it opens cold",
          404,
          "RECIPE_NOT_FOUND",
        );
      }
      return {
        caseId,
        unitId: "FX-UNIT-B",
        commit: "0123456789abcdef0123456789abcdef01234567",
        observation: { description: "The banner reads staged" },
        steps: [
          { index: 0, kind: "command", status: "passed", detail: "exited 0" },
          {
            index: 1,
            kind: "open-url",
            status: "passed",
            url: "http://localhost:5173/benches/3",
          },
        ],
      };
    });
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const list = await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });

    // Step 1: a case with a recipe is staged, and its surface shows the staged
    // state: the commit, the observation to make and the step report.
    const first = await openCase(user, list, "FX-TC-001");
    await user.click(within(first).getByRole("button", { name: "Stage FX-TC-001" }));
    await waitFor(() =>
      expect(api.stageTestbenchCase).toHaveBeenCalledWith("demo", 3, "FX-TC-001"),
    );
    const staged = await within(first).findByRole("region", {
      name: "Staged state of FX-TC-001",
    });
    expect(staged).toHaveTextContent("FX-TC-001 is staged at commit 0123456789abcdef");
    expect(staged).toHaveTextContent("Look for: The banner reads staged");
    const steps = within(staged).getByRole("list", {
      name: "Steps of the state recipe of FX-TC-001",
    });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(steps).getByRole("link", { name: "http://localhost:5173/benches/3" }),
    ).toHaveAttribute("href", "http://localhost:5173/benches/3");

    // Step 2: a case with no recipe opens cold, and its surface says so.
    const second = await openCase(user, list, "FX-TC-002");
    await user.click(within(second).getByRole("button", { name: "Stage FX-TC-002" }));
    expect(await within(second).findByTestId("case-opened-cold")).toHaveTextContent(
      "FX-TC-002 opened cold: it has no state recipe.",
    );
    expect(within(second).queryByRole("region", { name: /Staged state/ })).not.toBeInTheDocument();
    expect(within(second).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SB-TC-062 shows the server's message naming the pin commit after 409, and the step report after 422", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    vi.mocked(api.stageTestbenchCase).mockImplementation(async (_p, _b, caseId) => {
      if (caseId === "FX-TC-001") {
        throw new api.ApiError(
          "The state recipe of case FX-TC-001 was recorded at commit fedcba9, not at the pin commit 0123456789",
          409,
          "RECIPE_COMMIT_MISMATCH",
        );
      }
      throw new api.ApiError(
        "Step 0 (command) of the state recipe failed: exited 3",
        422,
        "RECIPE_STEP_FAILED",
        {
          caseId,
          unitId: "FX-UNIT-B",
          commit: "0123456",
          observation: { description: "The banner reads staged" },
          steps: [
            { index: 0, kind: "command", status: "failed", detail: "exited 3, expected 0" },
            { index: 1, kind: "open-url", status: "skipped" },
          ],
        },
      );
    });
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const list = await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });

    const first = await openCase(user, list, "FX-TC-001");
    await user.click(within(first).getByRole("button", { name: "Stage FX-TC-001" }));
    expect(await within(first).findByRole("alert")).toHaveTextContent(
      "not at the pin commit 0123456789",
    );

    const second = await openCase(user, list, "FX-TC-002");
    await user.click(within(second).getByRole("button", { name: "Stage FX-TC-002" }));
    expect(await within(second).findByRole("alert")).toHaveTextContent("exited 3");
    const steps = within(second).getByRole("list", {
      name: "Steps of the state recipe of FX-TC-002",
    });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("data-step-status")),
    ).toEqual(["failed", "skipped"]);
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
    const banner = await screen.findByRole("region", { name: "Gate gate-after-b sitting" });
    expect(banner).toHaveAttribute("data-state", "ready");
    expect(banner).toHaveAttribute("data-blocked", "true");
    // The title and the fix unit line are both announced.
    expect(
      within(banner)
        .getAllByRole("status")
        .map((status) => status.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual([
      "Sitting blocked · Gate gate-after-b · ready to sit",
      "Blocked by a fix unit filed for cases marked Not met: example/fixture#77 (FX-TC-001)",
    ]);
    // A ready sitting offers only Open the sitting, and lists no case yet.
    expect(screen.queryByRole("button", { name: "Close the sitting" })).not.toBeInTheDocument();
    expect(screen.getByText("The escalated cases show here once the sitting opens.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open the sitting" }));
    await waitFor(() =>
      expect(api.openDeliverySitting).toHaveBeenCalledWith("demo", 3, "gate-after-b"),
    );
  });

  it("SB-TC-067 the sitting banner, the case filter, the case list, the Case panel and the stage control are reachable and named, the stagger does not steal focus and collapses under reduced motion, and axe finds nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    const { container, unmount } = renderWithProviders(<SpecBenchTestBench bench={bench} />);

    // Step 1: the banner names the gate and its phase, as a heading and a
    // status line, and every control is reached by Tab with a name.
    const banner = await screen.findByRole("region", { name: "Gate gate-after-b sitting" });
    expect(banner).toHaveAttribute("data-state", "open");
    expect(
      within(banner).getByRole("heading", { level: 2, name: "Gate gate-after-b" }),
    ).toBeInTheDocument();
    expect(within(banner).getByRole("status")).toHaveTextContent(
      "Gate gate-after-b · sitting open",
    );
    const list = await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });
    // The staggered entrance moved no focus.
    expect(document.activeElement).toBe(document.body);
    const items = within(list).getAllByTestId("sitting-case");
    expect(items.map((item) => item.style.animationDelay)).toEqual([
      "0ms",
      `${GATE_CASES_STAGGER_MS}ms`,
    ]);
    items.forEach((item) => expect(item).toHaveClass("animate-rise-in"));

    // Tab order: the stage control, the case filter, each row of the Cases
    // list, then on the chosen case's TestBench surface its status control,
    // its observation mark, its lifecycle actions and its notes, then its
    // Stage control and the Mark row. Each is found by its name.
    const panel = screen.getByRole("region", { name: "Case FX-TC-001" });
    const expected: HTMLElement[] = [
      screen.getByRole("button", { name: "Close the sitting" }),
      screen.getByRole("tab", { name: "Escalated" }),
      ...CASES.map((caseId) =>
        within(list).getByRole("button", { name: new RegExp(`^${caseId} ·`) }),
      ),
      within(panel).getByRole("button", { name: /Case status/ }),
      within(
        within(panel).getByRole("radiogroup", {
          name: "Mark observation pass or fail: FX-TC-001 behaves",
        }),
      ).getByRole("radio", { name: "Pass" }),
      within(panel).getByRole("button", { name: "Retire" }),
      within(panel).getByRole("button", { name: "Supersede" }),
      within(panel).getByRole("button", { name: "Notes (0)" }),
      within(panel).getByRole("button", { name: "Stage FX-TC-001" }),
      within(panel).getByRole("button", { name: "Mark FX-TC-001 Met" }),
      within(panel).getByRole("button", { name: "Mark FX-TC-001 Not met with evidence" }),
      within(panel).getByRole("button", { name: "Mark FX-TC-001 Still blocked" }),
    ];
    for (const element of expected) {
      await user.tab();
      expect(document.activeElement).toBe(element);
    }

    // Step 3: no WCAG 2.1 AA finding with the case surfaces rendered, and with
    // the evidence form open too.
    expectNoAxeFindings(await axe(container));
    await user.click(
      within(panel).getByRole("button", { name: "Mark FX-TC-001 Not met with evidence" }),
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
  it("the Mark row marks the chosen case Met and Still blocked through the case status route", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const list = await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });
    const panel = await openCase(user, list, "FX-TC-002");
    await user.click(within(panel).getByRole("button", { name: "Mark FX-TC-002 Met" }));
    await waitFor(() =>
      expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, "FX-TC-002", "passed"),
    );
    await user.click(within(panel).getByRole("button", { name: "Mark FX-TC-002 Still blocked" }));
    await waitFor(() =>
      expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, "FX-TC-002", "blocked"),
    );
  });

  it("counts the cases that automation passed, lists the escalated ones by default, and the whole gating set on its tab", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    vi.mocked(api.fetchTestbenchPlan).mockResolvedValue({
      plan,
      results: {
        updatedAt: "2026-10-16T10:00:00Z",
        caseResults: {
          "FX-TC-001": {
            observationMarks: {},
            derivedStatus: "passed",
            notes: [],
            verification: {
              tier: "b",
              confidence: "high",
              evidence: ["suite row"],
              author: { name: "verify", email: "verify@example.test" },
              timestamp: "2026-10-16T10:00:00Z",
            },
          },
        },
      },
      stale: false,
      planHash: "hash",
      recovered: false,
    });
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    expect(await screen.findByTestId("sitting-counts")).toHaveTextContent(
      "1 of 2 passed by automation · 1 escalated to you",
    );
    const cases = screen.getByRole("region", { name: "Cases" });
    expect(cases).toHaveTextContent("escalated 1 · all 2");
    const escalated = within(cases).getByRole("list", {
      name: "Escalated cases of gate gate-after-b",
    });
    expect(
      within(escalated)
        .getAllByTestId("sitting-case")
        .map((item) => item.getAttribute("data-case-id")),
    ).toEqual(["FX-TC-002"]);
    expect(screen.getByRole("region", { name: "Case FX-TC-002" })).toBeInTheDocument();

    await user.click(within(cases).getByRole("tab", { name: "Gating set" }));
    const gating = within(cases).getByRole("list", { name: "Gating set of gate gate-after-b" });
    const rows = within(gating).getAllByTestId("sitting-case");
    expect(rows.map((item) => item.getAttribute("data-case-id"))).toEqual(CASES);
    // The case that automation passed reads dimmed, with its status.
    const passedRow = within(rows[0]).getByRole("button");
    expect(passedRow).toHaveClass("opacity-60");
    expect(passedRow).toHaveTextContent("Passed");
    expect(within(rows[1]).getByRole("button")).not.toHaveClass("opacity-60");
  });

  it("says when no case of the gate is escalated", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    const passed = {
      observationMarks: {},
      derivedStatus: "passed" as const,
      notes: [],
      verification: {
        tier: "b" as const,
        confidence: "high" as const,
        evidence: [],
        author: { name: "verify", email: "verify@example.test" },
        timestamp: "2026-10-16T10:00:00Z",
      },
    };
    vi.mocked(api.fetchTestbenchPlan).mockResolvedValue({
      plan,
      results: {
        updatedAt: "2026-10-16T10:00:00Z",
        caseResults: { "FX-TC-001": passed, "FX-TC-002": passed },
      },
      stale: false,
      planHash: "hash",
      recovered: false,
    });
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    expect(
      await screen.findByText("No case of this gate is escalated. Gating set lists all 2."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Case FX-TC/ })).not.toBeInTheDocument();
  });

  it("the banner says the build is coming up while the sitting prepares, and names a failed smoke check", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({
        gateId: "gate-after-b",
        state: "preparing",
        commit: "0123456789abcdef0123456789abcdef01234567",
        smokeCheck: {
          passed: false,
          checkedAt: "2026-10-16T10:00:00Z",
          detail: "GET / answered 502",
        },
      }),
    );
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const banner = await screen.findByRole("region", { name: "Gate gate-after-b sitting" });
    expect(banner).toHaveAttribute("data-state", "preparing");
    expect(banner).not.toHaveAttribute("data-blocked");
    expect(banner).toHaveTextContent(
      "The build is coming up at the gate commit 0123456. You are called once it is live and its smoke check passes.",
    );
    expect(banner).toHaveTextContent("smoke check failed");
    expect(within(banner).getByTestId("delivery-gate-sitting-smoke")).toHaveTextContent(
      "Last smoke check: GET / answered 502",
    );
    // Open the sitting waits for a ready build; Close the sitting is offered.
    expect(screen.getByRole("button", { name: "Open the sitting" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close the sitting" })).toBeEnabled();
    expect(screen.queryByRole("list", { name: /cases of gate/ })).not.toBeInTheDocument();
  });
  it("a case keeps its staged state and its evidence draft while another case is chosen", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    vi.mocked(api.stageTestbenchCase).mockResolvedValue({
      caseId: "FX-TC-001",
      unitId: "FX-UNIT-B",
      commit: "0123456",
      observation: { description: "The banner reads staged" },
      steps: [],
    });
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const list = await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });
    const first = await openCase(user, list, "FX-TC-001");
    await user.click(within(first).getByRole("button", { name: "Stage FX-TC-001" }));
    await within(first).findByRole("region", { name: "Staged state of FX-TC-001" });
    await user.click(
      within(first).getByRole("button", { name: "Mark FX-TC-001 Not met with evidence" }),
    );
    await user.type(
      within(screen.getByRole("form", { name: "Not met evidence for FX-TC-001" })).getByRole(
        "textbox",
        { name: "Note" },
      ),
      "Half typed.",
    );

    // Choosing the second case shows its panel alone.
    await openCase(user, list, "FX-TC-002");
    expect(screen.queryByRole("region", { name: "Case FX-TC-001" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Staged state of FX-TC-001" })).toBeNull();

    // Back on the first case, its staged state and its draft are still there.
    const again = await openCase(user, list, "FX-TC-001");
    expect(
      within(again).getByRole("region", { name: "Staged state of FX-TC-001" }),
    ).toHaveTextContent("FX-TC-001 is staged at commit 0123456");
    expect(
      within(screen.getByRole("form", { name: "Not met evidence for FX-TC-001" })).getByRole(
        "textbox",
        { name: "Note" },
      ),
    ).toHaveValue("Half typed.");
    expect(api.stageTestbenchCase).toHaveBeenCalledTimes(1);
  });

  it("shows the first case of the new list when the chosen case is not in it", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    // The results writer: FX-TC-001 passed by automation, and each mark written
    // over the case's result, so a read after a mark returns it.
    const caseResults: Record<string, CaseResult> = {
      "FX-TC-001": {
        observationMarks: {},
        derivedStatus: "passed",
        notes: [],
        verification: {
          tier: "b",
          confidence: "high",
          evidence: [],
          author: { name: "verify", email: "verify@example.test" },
          timestamp: "2026-10-16T10:00:00Z",
        },
      },
    };
    vi.mocked(api.fetchTestbenchPlan).mockImplementation(async () => ({
      plan,
      results: { updatedAt: "2026-10-16T10:00:00Z", caseResults: { ...caseResults } },
      stale: false,
      planHash: "hash",
      recovered: false,
    }));
    vi.mocked(api.setStatusOverride).mockImplementation(async (_p, _b, caseId, override) => {
      const before: CaseResult = caseResults[caseId] ?? {
        observationMarks: {},
        derivedStatus: "not_started",
        notes: [],
      };
      const result: CaseResult = {
        ...before,
        statusOverride: {
          status: override as CaseStatus,
          author: { name: "Ada Operator", email: "ada@example.test" },
          timestamp: "2026-10-16T10:05:00Z",
        },
      };
      caseResults[caseId] = result;
      return result;
    });
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    await screen.findByRole("list", { name: "Escalated cases of gate gate-after-b" });
    const cases = screen.getByRole("region", { name: "Cases" });
    await user.click(within(cases).getByRole("tab", { name: "Gating set" }));
    const gating = within(cases).getByRole("list", { name: "Gating set of gate gate-after-b" });
    // The case automation passed is chosen on the gating set, then the filter
    // goes back to Escalated, where it is not listed.
    await openCase(user, gating, "FX-TC-001");
    await user.click(within(cases).getByRole("tab", { name: "Escalated" }));
    expect(screen.getByRole("region", { name: "Case FX-TC-002" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Case FX-TC-001" })).not.toBeInTheDocument();
    // The operator's mark on the case automation passed leaves it out of the
    // Escalated list and keeps the counts.
    await user.click(within(cases).getByRole("tab", { name: "Gating set" }));
    await openCase(
      user,
      within(cases).getByRole("list", { name: "Gating set of gate gate-after-b" }),
      "FX-TC-001",
    );
    await user.click(screen.getByRole("button", { name: "Mark FX-TC-001 Still blocked" }));
    await waitFor(() =>
      expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, "FX-TC-001", "blocked"),
    );
    await waitFor(() =>
      expect(
        within(
          within(cases).getByRole("list", { name: "Gating set of gate gate-after-b" }),
        ).getByRole("button", { name: /^FX-TC-001 ·/ }),
      ).toHaveTextContent("Blocked"),
    );
    expect(screen.getByTestId("sitting-counts")).toHaveTextContent(
      "1 of 2 passed by automation · 1 escalated to you",
    );
    expect(within(cases).getByRole("button", { name: /^FX-TC-001 ·/ })).toHaveClass("opacity-60");
    await user.click(within(cases).getByRole("tab", { name: "Escalated" }));
    expect(
      within(within(cases).getByRole("list", { name: "Escalated cases of gate gate-after-b" }))
        .getAllByTestId("sitting-case")
        .map((item) => item.getAttribute("data-case-id")),
    ).toEqual(["FX-TC-002"]);
  });

  it("the open banner shows the pinned commit and a live build, and names every fix unit that blocks the gate", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({
        gateId: "gate-after-b",
        state: "open",
        commit: "0123456789abcdef0123456789abcdef01234567",
        smokeCheck: { passed: true, checkedAt: "2026-10-16T10:00:00Z" },
        fixUnitBlockers: [
          { caseId: "FX-TC-001", fixRef: "example/fixture#77", filedAt: "2026-10-16T10:00:00Z" },
          { caseId: "FX-TC-002", fixRef: "example/fixture#78", filedAt: "2026-10-16T10:05:00Z" },
        ],
        blocked: true,
      }),
    );
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const banner = await screen.findByRole("region", { name: "Gate gate-after-b sitting" });
    expect(banner).toHaveTextContent("pinned 0123456");
    expect(banner).toHaveTextContent("build live · smoke ok");
    expect(within(banner).getByTestId("delivery-gate-sitting-blocked")).toHaveTextContent(
      "Blocked by 2 fix units filed for cases marked Not met: example/fixture#77 (FX-TC-001), example/fixture#78 (FX-TC-002)",
    );
  });

  it("an open sitting with no smoke check recorded reads its build live", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      snapshot({ gateId: "gate-after-b", state: "open" }),
    );
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const banner = await screen.findByRole("region", { name: "Gate gate-after-b sitting" });
    expect(banner).toHaveTextContent("build live");
    expect(banner).not.toHaveTextContent("build coming up");
  });
});
