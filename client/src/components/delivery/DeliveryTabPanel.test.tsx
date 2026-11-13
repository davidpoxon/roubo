// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench } from "@roubo/shared";
import {
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { createDeliveryReducer } from "@roubo/shared/delivery-reducer";
import type { DeliveryReadError } from "@roubo/shared/delivery-bench";
import type { CaseResult, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import { renderWithProviders, makeQueryClient } from "../../test/renderWithProviders";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchDeliveryCrossCheck: vi.fn(),
    resumeDelivery: vi.fn(),
    launchDelivery: vi.fn(),
    fetchTerminals: vi.fn(),
    fetchTestbenchPlan: vi.fn(),
    fetchDeliverySpecSummary: vi.fn(),
  };
});
import * as api from "../../lib/api";
import {
  DELIVERY_CROSS_CHECK_REFETCH_MS,
  DELIVERY_CROSS_CHECK_RETRIES,
  DELIVERY_CROSS_CHECK_RETRY_MS,
  shouldRetryDeliveryCrossCheck,
} from "../../hooks/useDeliveryCrossCheck";
import DeliveryTabPanel from "./DeliveryTabPanel";
import { LAUNCH_GRACE_MS } from "./delivery-startup";
import {
  openCasesView,
  openCostView,
  openDecisionsView,
  openSteeringView,
  returnToMap,
} from "../../test/delivery-views";

const bench = {
  id: 3,
  projectId: "demo",
  variant: "specbench",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "attach",
  notifications: [],
  createdAt: "2026-10-16T09:00:00Z",
} as unknown as Bench;

function record(): DeliveryRecord {
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    spec_slug: "fixture-spec",
    plan_hash: "hash",
    mode: { value: "attended", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { A: ["A", "B", "C"], D: ["D"] },
      gates: [
        { id: "gate-after-b", after: ["B"], status: "pending", cases: [] },
        { id: "gate-after-c", after: ["C"], status: "pending", cases: [] },
      ],
    },
    units: [
      { id: "A", title: "Base", status: "done", stack: "A", layer: 0, depends_on: [] },
      { id: "B", title: "Second", status: "running", stack: "A", layer: 1, depends_on: ["A"] },
      { id: "C", title: "Third", status: "pending", stack: "A", layer: 2, depends_on: ["B"] },
      { id: "D", title: "Own", status: "pending", stack: "D", layer: 0, depends_on: [] },
    ],
    decisions: [
      {
        id: "decision-1",
        question: "One file per unit or one per stack?",
        options: ["one file per unit", "one file per stack"],
        default: "one file per unit",
        status: "open",
        raised_at: "2026-10-16T09:05:00Z",
      },
    ],
    steering: [],
    budget: { estimate_usd: 3.2, soft_budget_usd: 5, spent_usd: 0.42 },
    roles: { main: { tier: "balanced" } },
    health: { status: "ok", checked_at: "2026-10-16T09:30:00Z" },
    drift: [],
    seams: {},
    lifecycle: { state: "running", armed: true, started_at: "2026-10-16T09:00:00Z" },
    last_event_seq: 7,
    updated_at: "2026-10-16T09:30:00Z",
  };
}

function snapshot() {
  return createDeliveryReducer().fold({ record: record(), events: [] });
}

function readError(error: DeliveryReadError): api.ApiError {
  return new api.ApiError(error.error, 409, error.code, error);
}

function expectNoControls() {
  for (const id of [
    "delivery-decision-controls",
    "delivery-steering-controls",
    "delivery-role-controls",
    "delivery-lifecycle-controls",
  ]) {
    expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  }
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.mocked(api.fetchDelivery).mockReset();
  vi.mocked(api.resumeDelivery).mockReset();
  vi.mocked(api.launchDelivery).mockReset();
  vi.mocked(api.fetchTerminals).mockReset();
  vi.mocked(api.fetchTestbenchPlan).mockReset();
  vi.mocked(api.fetchTestbenchPlan).mockRejectedValue(new Error("no plan in this test"));
  vi.mocked(api.fetchDeliverySpecSummary).mockReset();
  vi.mocked(api.fetchDeliverySpecSummary).mockRejectedValue(new Error("no summary in this test"));
  vi.mocked(api.fetchDeliveryCrossCheck).mockReset();
  vi.mocked(api.fetchDeliveryCrossCheck).mockResolvedValue({
    disagreements: [],
    refreshedAt: null,
    sourceError: null,
  });
});

describe("DeliveryTabPanel", () => {
  it("shows the conformance error naming budget and no control, then the snapshot and controls once restored", async () => {
    vi.mocked(api.fetchDelivery).mockRejectedValueOnce(
      readError({
        code: "DELIVERY_NONCONFORMANT",
        error: "The delivery record is missing its budget section",
        section: "budget",
        sections: ["budget"],
      }),
    );
    const queryClient = makeQueryClient();
    renderWithProviders(<DeliveryTabPanel bench={bench} />, { queryClient });

    const callout = await screen.findByTestId("delivery-read-error");
    expect(callout).toHaveAttribute("role", "alert");
    expect(callout).toHaveTextContent(/budget/);
    expectNoControls();

    // Step 4: the section is restored and the tab reads again.
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    await act(() => queryClient.invalidateQueries());

    await waitFor(() => expect(screen.getByTestId("delivery-snapshot")).toBeInTheDocument());
    expect(screen.queryByTestId("delivery-read-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("delivery-lifecycle")).toHaveTextContent("running");
    expect(screen.getByTestId("delivery-stat-spent")).toHaveTextContent("0.42 of 5.00 soft budget");
    expect(screen.getByTestId("delivery-decision-controls")).toHaveTextContent(
      "One file per unit or one per stack?",
    );
    await openDecisionsView();
    expect(screen.getByRole("button", { name: "one file per stack" })).toBeInTheDocument();
    expect(screen.getByTestId("delivery-steering-controls")).toBeInTheDocument();
    await returnToMap();
    await openCostView();
    expect(screen.getByRole("combobox", { name: "Model of main" })).toHaveValue("balanced");
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
  });

  it("shows the validation error naming units and exposes no control", async () => {
    vi.mocked(api.fetchDelivery).mockRejectedValueOnce(
      readError({
        code: "DELIVERY_INVALID",
        error: "The delivery record has an invalid units: Invalid input: expected array",
        field: "units",
        errors: ["units: Invalid input: expected array, received object"],
      }),
    );
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    const callout = await screen.findByTestId("delivery-read-error");
    expect(callout).toHaveTextContent("The delivery record has an invalid units field");
    expectNoControls();
  });

  it("shows the version mismatch and exposes no control", async () => {
    vi.mocked(api.fetchDelivery).mockRejectedValueOnce(
      readError({
        code: "DELIVERY_VERSION_MISMATCH",
        error: "The delivery record is at contract version 2.0.0",
        found: "2.0.0",
        supported: "1.0.0",
      }),
    );
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    const callout = await screen.findByTestId("delivery-read-error");
    expect(callout).toHaveTextContent(/version 2\.0\.0, and this bench reads 1\.0\.0/);
    expectNoControls();
  });

  describe("a record the session has not written yet", () => {
    const missing = () =>
      readError({ code: "DELIVERY_RECORD_MISSING", error: "No delivery record yet" });
    const launchBench = (over: Partial<Bench> = {}): Bench => ({
      ...bench,
      status: "active",
      deliveryBindMode: "launch",
      ...over,
    });
    const liveSession = {
      id: "session-1",
      benchKey: "demo:3",
      label: "agent",
      createdAt: "2026-10-16T09:01:00Z",
      status: "live" as const,
    };

    beforeEach(() => {
      vi.mocked(api.fetchDelivery).mockRejectedValue(missing());
    });

    it("shows the delivery's start-up as a neutral status, not a fault, with no control", async () => {
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      const startup = await screen.findByTestId("delivery-startup");
      expect(startup).toHaveAttribute("role", "status");
      expect(startup).toHaveAttribute("data-phase", "attach-waiting");
      expect(startup.className).not.toMatch(/danger/);
      expect(screen.queryByTestId("delivery-read-error")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expectNoControls();
    });

    it("shows the units and gates of the spec in the bench workspace", async () => {
      vi.mocked(api.fetchDeliverySpecSummary).mockResolvedValue({
        slug: "fixture-spec",
        units: 4,
        gates: 1,
      });
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      expect(await screen.findByTestId("delivery-startup-counts")).toHaveTextContent(
        "4 units and 1 gate in this spec",
      );
      expect(api.fetchDeliverySpecSummary).toHaveBeenCalledWith("demo", 3);
    });

    it("plans the delivery while the session runs, with no launch control", async () => {
      vi.mocked(api.fetchTerminals).mockResolvedValue([liveSession]);
      renderWithProviders(
        <DeliveryTabPanel bench={launchBench({ deliverySessionId: "session-1" })} />,
      );

      await waitFor(() =>
        expect(screen.getByTestId("delivery-startup")).toHaveAttribute("data-phase", "planning"),
      );
      expect(screen.getByTestId("delivery-startup-phase")).toHaveTextContent(
        "Planning the delivery",
      );
      expect(screen.getByTestId("delivery-startup-step-session")).toHaveAttribute(
        "data-status",
        "done",
      );
      expect(screen.getByTestId("delivery-startup-step-planning")).toHaveAttribute(
        "data-status",
        "running",
      );
      expect(screen.queryByTestId("delivery-launch-control")).not.toBeInTheDocument();
    });

    it("waits for the operator in the Terminal, which one press opens", async () => {
      vi.mocked(api.fetchTerminals).mockResolvedValue([liveSession]);
      const onOpenTerminal = vi.fn();
      renderWithProviders(
        <DeliveryTabPanel
          bench={launchBench({
            deliverySessionId: "session-1",
            notifications: [
              {
                id: "n-1",
                type: "agent-waiting",
                priority: "action-needed",
                sourceSessionId: "session-1",
                createdAt: "2026-10-16T09:02:00Z",
              },
            ],
          })}
          onOpenTerminal={onOpenTerminal}
        />,
      );

      const open = await screen.findByRole("button", { name: "Open the terminal" });
      expect(screen.getByTestId("delivery-startup-phase")).toHaveTextContent("Waiting for you");
      expect(screen.getByTestId("delivery-startup-step-operator")).toHaveAttribute(
        "data-status",
        "running",
      );
      await userEvent.click(open);
      expect(onOpenTerminal).toHaveBeenCalledOnce();
      expect(screen.queryByTestId("delivery-launch-control")).not.toBeInTheDocument();
    });

    it("offers the launch again once the session ended without the record, and launches on press", async () => {
      vi.mocked(api.fetchTerminals).mockResolvedValue([
        { ...liveSession, status: "ended", exitCode: 1 },
      ]);
      vi.mocked(api.launchDelivery).mockResolvedValue({ sessionId: "session-2" });
      renderWithProviders(
        <DeliveryTabPanel bench={launchBench({ deliverySessionId: "session-1" })} />,
      );

      const launch = await screen.findByRole("button", { name: "Launch the delivery session" });
      expect(launch).toBeEnabled();
      expect(screen.getByTestId("delivery-startup-step-session")).toHaveTextContent("exit code 1");
      // Launching is the only control: the record's controls still wait for it.
      expect(screen.queryByTestId("delivery-lifecycle-controls")).not.toBeInTheDocument();
      await userEvent.click(launch);
      await waitFor(() => expect(api.launchDelivery).toHaveBeenCalledWith("demo", 3));
    });

    it("offers the launch again once the session was closed from the Terminal", async () => {
      vi.mocked(api.fetchTerminals).mockResolvedValue([]);
      renderWithProviders(
        <DeliveryTabPanel bench={launchBench({ deliverySessionId: "session-1" })} />,
      );

      expect(
        await screen.findByRole("button", { name: "Launch the delivery session" }),
      ).toBeEnabled();
      expect(screen.getByTestId("delivery-startup")).toHaveAttribute("data-phase", "session-ended");
    });

    it("does not read a just-recorded session as gone from a list cached before it started", async () => {
      // The Terminal tab's list was read while the bench prepared, before the
      // launch recorded its session; the next read has not answered yet.
      const queryClient = makeQueryClient();
      queryClient.setQueryData(["terminals", "demo", 3], []);
      vi.mocked(api.fetchTerminals).mockReturnValue(new Promise(() => {}));
      renderWithProviders(
        <DeliveryTabPanel bench={launchBench({ deliverySessionId: "session-1" })} />,
        { queryClient },
      );

      const startup = await screen.findByTestId("delivery-startup");
      await act(async () => {
        await Promise.resolve();
      });
      expect(startup).toHaveAttribute("data-phase", "planning");
      expect(screen.queryByTestId("delivery-launch-control")).not.toBeInTheDocument();
    });

    it("offers the launch again once no session started within the grace period", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderWithProviders(<DeliveryTabPanel bench={launchBench()} />);
        const startup = await screen.findByTestId("delivery-startup");
        expect(startup).toHaveAttribute("data-phase", "starting");
        expect(screen.queryByTestId("delivery-launch-control")).not.toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(LAUNCH_GRACE_MS);
        });

        expect(startup).toHaveAttribute("data-phase", "launch-stalled");
        expect(screen.getByRole("button", { name: "Launch the delivery session" })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("offers the launch again after the create-time launch failed, naming the cause", async () => {
      renderWithProviders(
        <DeliveryTabPanel
          bench={launchBench({
            notifications: [
              {
                id: "n-2",
                type: "agent-launch-failed",
                priority: "action-needed",
                metadata: { message: "The delivery session did not start: no agent" },
                createdAt: "2026-10-16T09:01:00Z",
              },
            ],
          })}
        />,
      );

      expect(
        await screen.findByRole("button", { name: "Launch the delivery session" }),
      ).toBeEnabled();
      expect(screen.getByTestId("delivery-startup")).toHaveAttribute("data-phase", "launch-failed");
      expect(screen.getByTestId("delivery-startup-step-session")).toHaveTextContent(
        "The delivery session did not start: no agent",
      );
    });

    it.each(["clearing", "error"] as const)(
      "offers no launch control while the bench is %s",
      async (status) => {
        renderWithProviders(<DeliveryTabPanel bench={launchBench({ status })} />);

        const startup = await screen.findByTestId("delivery-startup");
        expect(startup).toHaveAttribute("data-phase", "bench-unavailable");
        expect(screen.queryByTestId("delivery-launch-control")).not.toBeInTheDocument();
      },
    );
  });

  it("offers no launch control on a launch-mode bench whose record does not conform", async () => {
    vi.mocked(api.fetchDelivery).mockRejectedValueOnce(
      readError({
        code: "DELIVERY_NONCONFORMANT",
        error: "The delivery record is missing its budget section",
        section: "budget",
        sections: ["budget"],
      }),
    );
    renderWithProviders(
      <DeliveryTabPanel bench={{ ...bench, status: "active", deliveryBindMode: "launch" }} />,
    );

    await screen.findByTestId("delivery-read-error");
    expectNoControls();
  });

  describe("SB-TC-022 progress in cases met and requirements covered", () => {
    const caseId = (n: number) => `FIX-TC-${String(n).padStart(3, "0")}`;
    const ids = Array.from({ length: 10 }, (_, index) => caseId(index + 1));
    const passed: CaseResult = {
      observationMarks: {},
      derivedStatus: "passed",
      notes: [
        {
          id: "note-1",
          text: "The suite row passed.",
          author: { name: "Ada", email: "ada@example.com" },
          timestamp: "2026-10-16T09:20:00Z",
          statusAtWrite: "passed",
        },
      ],
      verification: {
        tier: "b",
        confidence: "high",
        evidence: ["report.xml#FIX-TC-001"],
        author: { name: "verifier", email: "verifier@example.com" },
        timestamp: "2026-10-16T09:25:00Z",
      },
    };

    // A and B are done; only 3 of the 10 gating cases pass.
    function progressSnapshot() {
      const base = record();
      const plan: TestCasesPlan = {
        $schema: "https://roubo.dev/schema/testbench/test-cases/v1.2.0.json",
        schemaVersion: "1.2.0",
        specSlug: "fixture-spec",
        cases: ids.map((id, index) => ({
          id,
          title: id,
          area: "fixture",
          level: 1,
          type: "functional",
          steps: [],
          tags: [],
          linked_requirement_ids: [index < 3 ? "FIX-FR-001" : "FIX-FR-002"],
          linked_user_story_ids: [],
        })),
      };
      return createDeliveryReducer().fold({
        record: {
          ...base,
          stack: {
            ...base.stack,
            gates: [
              { id: "gate-after-b", after: ["B"], status: "pending", cases: ids.slice(0, 5) },
              { id: "gate-after-c", after: ["C"], status: "pending", cases: ids.slice(5) },
            ],
          },
          units: base.units.map((unit) =>
            unit.id === "B"
              ? { ...unit, status: "done", pr_url: "https://github.com/demo/demo/pull/2" }
              : unit,
          ),
        },
        events: [],
        plan,
        results: {
          planHash: base.plan_hash,
          updatedAt: "2026-10-16T09:30:00Z",
          caseResults: { [ids[0]]: passed, [ids[1]]: passed, [ids[2]]: passed },
        },
      });
    }

    function planResponse(snapshot: ReturnType<typeof progressSnapshot>) {
      return {
        plan: {
          $schema: "https://roubo.dev/schema/testbench/test-cases/v1.2.0.json",
          schemaVersion: "1.2.0",
          specSlug: "fixture-spec",
          cases: snapshot.progress.caseList.map((entry, index) => ({
            id: entry.id,
            title: `Case title ${entry.id}`,
            area: "fixture",
            level: 2,
            type: "functional",
            steps: [
              {
                id: "s1",
                instruction: `Open the thing for ${entry.id}`,
                observations: [{ id: "o1", expected: "The thing shows" }],
              },
            ],
            tags: [],
            linked_requirement_ids: [index < 3 ? "FIX-FR-001" : "FIX-FR-002"],
            linked_user_story_ids: ["FIX-US-001"],
          })),
        },
        results: null,
        stale: false,
        planHash: "fixture",
        recovered: false,
      } as unknown as Awaited<ReturnType<typeof api.fetchTestbenchPlan>>;
    }

    it("SB-TC-022 reads 3 of 10 cases met, counts covered requirements, and reads no units done", async () => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(progressSnapshot());
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      expect(await screen.findByTestId("delivery-header-progress")).toHaveTextContent(
        "3 of 10 cases met",
      );
      // The map view no longer repeats the progress under the map (#1655).
      expect(screen.queryByTestId("delivery-progress")).not.toBeInTheDocument();
      expect(screen.queryByTestId("delivery-met-cases")).not.toBeInTheDocument();

      await openCasesView();
      const cases = await screen.findByTestId("delivery-stat-cases");
      expect(cases).toHaveTextContent("3 of 10 cases met");
      expect(screen.getByTestId("delivery-stat-requirements")).toHaveTextContent(
        "1 of 2 requirements covered",
      );
      const progress = screen.getByTestId("delivery-progress");
      expect(progress).not.toHaveTextContent(/units?/i);
      expect(screen.getByTestId("delivery-snapshot")).not.toHaveTextContent(/2 of 4 units/);
    });

    it("opens the cases view from the rail's Cases figure and returns to the map", async () => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(progressSnapshot());
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      const figure = await screen.findByTestId("delivery-rail-stat-cases");
      await userEvent.click(figure);
      expect(await screen.findByTestId("delivery-view-cases")).toHaveFocus();
      expect(screen.getByTestId("delivery-view-map")).not.toBeVisible();

      await returnToMap();
      expect(screen.queryByTestId("delivery-view-cases")).not.toBeInTheDocument();
      expect(screen.getByTestId("delivery-rail-stat-cases")).toHaveFocus();
    });

    it("opens the cases view from the header's progress and gives the focus back to it", async () => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(progressSnapshot());
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      await openCasesView();
      expect(await screen.findByTestId("delivery-view-cases")).toHaveFocus();
      expect(screen.getByTestId("delivery-case-list")).toBeInTheDocument();

      await returnToMap();
      expect(screen.queryByTestId("delivery-view-cases")).not.toBeInTheDocument();
      expect(screen.getByTestId("delivery-header-progress")).toHaveFocus();
    });

    it("SB-TC-022 opens a met case's verify record and links the pull request of the unit that met it", async () => {
      const snapshot = progressSnapshot();
      vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot);
      vi.mocked(api.fetchTestbenchPlan).mockResolvedValue(planResponse(snapshot));
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      await openCasesView();
      const list = await screen.findByTestId("delivery-case-list");
      // Every gating case is listed, and the first met case is selected.
      expect(within(list).getAllByRole("button", { name: /^FIX-TC-/ })).toHaveLength(10);
      const first = screen.getByTestId(`delivery-case-${ids[0]}`);
      expect(first).toHaveAttribute("aria-current", "true");
      const verifyRecord = screen.getByTestId(`delivery-verify-record-${ids[0]}`);
      expect(verifyRecord).toHaveTextContent("passed");
      expect(verifyRecord).toHaveTextContent("tier b, high confidence");
      expect(verifyRecord).toHaveTextContent("report.xml#FIX-TC-001");
      expect(verifyRecord).toHaveTextContent("The suite row passed.");
      expect(screen.getByRole("link", { name: "Pull request of B" })).toHaveAttribute(
        "href",
        "https://github.com/demo/demo/pull/2",
      );
      // The detail says what the case is and what it links.
      const detail = screen.getByTestId("delivery-case-detail");
      expect(await within(detail).findByText(`Case title ${ids[0]}`)).toBeInTheDocument();
      expect(within(detail).getByTestId("delivery-case-steps")).toHaveTextContent(
        `Open the thing for ${ids[0]}Expects: The thing shows`,
      );
      expect(within(detail).getByTestId("delivery-case-requirements")).toHaveTextContent(
        "FIX-FR-001",
      );
      expect(detail).toHaveTextContent("FIX-US-001");

      // The arrow keys move the selection, and the Met filter hides the unmet cases.
      first.focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(screen.getByTestId(`delivery-case-${ids[1]}`)).toHaveFocus();
      expect(screen.getByTestId(`delivery-verify-record-${ids[1]}`)).toBeInTheDocument();
      await userEvent.click(within(list).getByRole("button", { name: "Met" }));
      expect(within(list).getAllByRole("button", { name: /^FIX-TC-/ })).toHaveLength(3);
      expect(screen.queryByTestId(`delivery-case-${ids[3]}`)).not.toBeInTheDocument();
    });

    it("says a gating case that is not met has no unit that met it yet", async () => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(progressSnapshot());
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      await openCasesView();
      await userEvent.click(await screen.findByTestId(`delivery-case-${ids[3]}`));
      const record = screen.getByTestId(`delivery-verify-record-${ids[3]}`);
      expect(record).toHaveTextContent("No unit has met this case yet.");
      expect(record).not.toHaveTextContent("No gate names this case");
    });

    it("shows the case id and its verify record when the test plan cannot be read", async () => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(progressSnapshot());
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      await openCasesView();
      expect(await screen.findByTestId("delivery-case-text-missing")).toHaveTextContent(
        "The case text is not available: the test plan could not be read.",
      );
      expect(screen.getByTestId(`delivery-verify-record-${ids[0]}`)).toBeInTheDocument();
    });

    it("SB-TC-022 links no pull request whose url is not a web address", async () => {
      const snapshot = progressSnapshot();
      snapshot.progress.caseList = snapshot.progress.caseList.map((entry) =>
        entry.met ? { ...entry, prUrl: "javascript:alert(1)" } : entry,
      );
      vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot);
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      await openCasesView();
      await userEvent.click(await screen.findByTestId(`delivery-case-${ids[1]}`));

      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.getByTestId(`delivery-verify-record-${ids[1]}`)).toHaveTextContent(
        "B has no pull request yet.",
      );
    });
  });

  it("resumes the delivery from the lifecycle controls", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    vi.mocked(api.resumeDelivery).mockResolvedValue({ resume: "demo-delivery-1" });
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    await openCostView();
    await userEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.resumeDelivery).toHaveBeenCalledWith("demo", 3));
  });

  it.each(["clearing", "error"] as const)(
    "disables Resume while the bench is %s",
    async (status) => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
      renderWithProviders(<DeliveryTabPanel bench={{ ...bench, status }} />);

      await openCostView();
      expect(await screen.findByRole("button", { name: "Resume" })).toBeDisabled();
    },
  );

  it("disables Resume while the session the bench launched is live, and enables it once it ends", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    vi.mocked(api.fetchTerminals).mockResolvedValueOnce([
      { id: "session-1", benchKey: "demo:3", label: "agent", createdAt: "now", status: "live" },
    ]);
    const queryClient = makeQueryClient();
    renderWithProviders(
      <DeliveryTabPanel bench={{ ...bench, status: "active", deliverySessionId: "session-1" }} />,
      { queryClient },
    );

    await openCostView();
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled());
    expect(api.fetchTerminals).toHaveBeenCalledWith("demo", 3);

    vi.mocked(api.fetchTerminals).mockResolvedValue([
      { id: "session-1", benchKey: "demo:3", label: "agent", createdAt: "now", status: "ended" },
    ]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["terminals"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled());
  });

  it("heads the snapshot with the spec slug, the case progress, the rail and the mode, then the source paths", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    const header = await screen.findByTestId("delivery-header");
    expect(within(header).getByTestId("delivery-slug")).toHaveTextContent("fixture-spec");
    expect(within(header).getByTestId("delivery-header-progress")).toHaveTextContent(
      /\d+ of \d+ cases met/,
    );
    expect(within(header).getByTestId("delivery-rail")).toBeInTheDocument();
    expect(within(header).getByTestId("delivery-mode-label")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-source")).toHaveTextContent(
      "/repos/demo/.specifications/fixture-spec",
    ); // The intro that names the spec before the snapshot loads is gone, so the
    // slug shows once.
    expect(screen.queryByText(/^Delivering/)).not.toBeInTheDocument();
    expect(screen.getAllByText("fixture-spec")).toHaveLength(1);
  });

  it("names the spec in the intro while the snapshot is read", () => {
    vi.mocked(api.fetchDelivery).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    expect(screen.getByText(/^Delivering/)).toBeInTheDocument();
    expect(screen.queryByTestId("delivery-header")).not.toBeInTheDocument();
  });

  it("SB-TC-075 shows a source it could not read on the chip and in the rail when no disagreement was found", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    vi.mocked(api.fetchDeliveryCrossCheck).mockResolvedValue({
      disagreements: [],
      refreshedAt: "2026-10-16T10:00:05Z",
      sourceError: { source: "github", message: "fetch failed" },
    });
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    const chip = await screen.findByTestId("delivery-crosscheck-chip");
    expect(chip).toHaveTextContent("cross-check · source not read");
    const rail = screen.getByRole("complementary", { name: "Delivery summary" });
    const panel = within(rail).getByTestId("delivery-crosscheck");
    expect(within(panel).getByTestId("delivery-crosscheck-source-error")).toHaveTextContent(
      "GitHub could not be read",
    );
    expect(within(panel).queryAllByTestId("delivery-crosscheck-row")).toHaveLength(0);
  });

  it("brings the decision pile into view from the rail's Decisions panel", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    const rail = await screen.findByRole("complementary", { name: "Delivery summary" });
    await userEvent.click(within(rail).getByRole("button", { name: "Open the decision pile" }));
    expect(document.activeElement).toBe(screen.getByTestId("delivery-decision-pile-target"));
  });

  it("SB-TC-074 reads the cross-check with the snapshot and lists every disagreement on the rail", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    const classes = [
      "branch-missing",
      "head-commit-differs",
      "layer-order-differs",
      "pr-state-differs",
      "base-branch-differs",
      "gate-state-differs",
      "case-status-differs",
      "plan-hash-mismatch",
      "record-stale",
    ];
    vi.mocked(api.fetchDeliveryCrossCheck).mockResolvedValue({
      disagreements: classes.map((cls) => ({
        class: cls,
        blocking: false,
        unitId: "A",
        claimed: "claimed",
        observed: "observed",
        source: "git",
      })),
      refreshedAt: "2026-10-16T10:00:05Z",
      sourceError: { source: "github", message: "fetch failed" },
    });
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    // The rail of summary panels holds the cross-check, and the header names
    // the count on its chip instead of listing the entries.
    const rail = await screen.findByRole("complementary", { name: "Delivery summary" });
    await waitFor(() =>
      expect(within(rail).getAllByTestId("delivery-crosscheck-row")).toHaveLength(9),
    );
    expect(api.fetchDeliveryCrossCheck).toHaveBeenCalledWith("demo", 3);
    expect(within(rail).getByTestId("delivery-crosscheck-source-error")).toHaveTextContent(
      "GitHub could not be read",
    );
    const header = screen.getByTestId("delivery-header");
    expect(within(header).queryAllByTestId("delivery-crosscheck-row")).toHaveLength(0);
    const chip = within(header).getByTestId("delivery-crosscheck-chip");
    expect(chip).toHaveTextContent("9 disagreements");
    await userEvent.click(chip);
    expect(document.activeElement).toBe(within(rail).getByTestId("delivery-crosscheck"));
  });

  it("SB-TC-074 reads the cross-check again after exactly 5 seconds, so the rail lists what a restart reconciled within 5 seconds", async () => {
    expect(DELIVERY_CROSS_CHECK_REFETCH_MS).toBe(5_000);
    // Only the query's interval runs on the test's clock; every other timer is
    // real, so reads resolve and render on their own.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
      const nine = [
        "branch-missing",
        "head-commit-differs",
        "layer-order-differs",
        "pr-state-differs",
        "base-branch-differs",
        "gate-state-differs",
        "case-status-differs",
        "plan-hash-mismatch",
        "record-stale",
      ].map((cls) => ({
        class: cls,
        blocking: false,
        unitId: "A",
        claimed: "claimed",
        observed: "observed",
        source: "git" as const,
      }));
      // The first read lists nothing yet; every read after it lists the nine.
      vi.mocked(api.fetchDeliveryCrossCheck)
        .mockResolvedValueOnce({ disagreements: [], refreshedAt: null, sourceError: null })
        .mockResolvedValue({
          disagreements: nine,
          refreshedAt: "2026-10-16T10:00:05Z",
          sourceError: null,
        });
      renderWithProviders(<DeliveryTabPanel bench={bench} />);
      const rail = await screen.findByRole("complementary", { name: "Delivery summary" });
      await waitFor(() => expect(api.fetchDeliveryCrossCheck).toHaveBeenCalledTimes(1));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(within(rail).queryAllByTestId("delivery-crosscheck-row")).toHaveLength(0);

      // Not before the interval.
      await act(() => vi.advanceTimersByTimeAsync(4_999));
      expect(api.fetchDeliveryCrossCheck).toHaveBeenCalledTimes(1);
      expect(within(rail).queryAllByTestId("delivery-crosscheck-row")).toHaveLength(0);

      // At the interval, the second read lists all nine.
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(api.fetchDeliveryCrossCheck).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(within(rail).getAllByTestId("delivery-crosscheck-row")).toHaveLength(9),
      );
      expect(api.fetchDeliveryCrossCheck).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SB-TC-074 reads the cross-check again 1 second after a read the restarting server could not answer, well within 5 seconds", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    const nine = [
      "branch-missing",
      "head-commit-differs",
      "layer-order-differs",
      "pr-state-differs",
      "base-branch-differs",
      "gate-state-differs",
      "case-status-differs",
      "plan-hash-mismatch",
      "record-stale",
    ].map((cls) => ({
      class: cls,
      blocking: false,
      unitId: "A",
      claimed: "claimed",
      observed: "observed",
      source: "git" as const,
    }));
    // The server is down for the first read, and back for the next.
    vi.mocked(api.fetchDeliveryCrossCheck)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({
        disagreements: nine,
        refreshedAt: "2026-10-16T10:00:05Z",
        sourceError: null,
      });
    const started = Date.now();
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await waitFor(() => expect(screen.getAllByTestId("delivery-crosscheck-row")).toHaveLength(9), {
      timeout: 4_000,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(api.fetchDeliveryCrossCheck).toHaveBeenCalledTimes(2);
  });

  it("SB-TC-074 retries a cross-check read only when the server could not answer it", () => {
    expect(DELIVERY_CROSS_CHECK_RETRY_MS).toBe(1_000);
    expect(shouldRetryDeliveryCrossCheck(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryDeliveryCrossCheck(0, new api.ApiError("Bad Gateway", 502))).toBe(true);
    expect(
      shouldRetryDeliveryCrossCheck(
        0,
        readError({
          code: "DELIVERY_RECORD_MISSING",
          error: "No delivery record",
        } as DeliveryReadError),
      ),
    ).toBe(false);
    expect(
      shouldRetryDeliveryCrossCheck(DELIVERY_CROSS_CHECK_RETRIES, new TypeError("Failed to fetch")),
    ).toBe(false);
  });
});

describe("DeliveryTabPanel gate sitting", () => {
  it("SB-TC-058 shows the gate waiting for build while its smoke check has not passed, then ready to sit once it passed", async () => {
    // Step 1: gate.reached with the build down.
    vi.mocked(api.fetchDelivery).mockResolvedValue({
      ...snapshot(),
      sitting: {
        gateId: "gate-after-b",
        state: "preparing",
        commit: "b".repeat(40),
        smokeCheck: {
          passed: false,
          checkedAt: "2026-10-16T09:40:00Z",
          detail: "component 'web' at http://127.0.0.1:5173/ answered 503",
        },
      },
    });
    const queryClient = makeQueryClient();
    renderWithProviders(<DeliveryTabPanel bench={bench} />, { queryClient });

    const sitting = await screen.findByTestId("delivery-gate-sitting");
    expect(sitting).toHaveAttribute("data-state", "preparing");
    // The banner calls the operator to act, so it comes before the map.
    expect(
      sitting.compareDocumentPosition(screen.getByTestId("delivery-workspace")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(sitting).toHaveTextContent("gate-after-b");
    expect(within(sitting).getByTestId("delivery-gate-sitting-state")).toHaveTextContent(
      "waiting for build",
    );
    expect(sitting).not.toHaveTextContent("ready to sit");
    expect(within(sitting).getByTestId("delivery-gate-sitting-smoke")).toHaveTextContent(
      "answered 503",
    );

    // Step 2: the build is up and the smoke check passed.
    vi.mocked(api.fetchDelivery).mockResolvedValue({
      ...snapshot(),
      sitting: {
        gateId: "gate-after-b",
        state: "ready",
        commit: "b".repeat(40),
        smokeCheck: { passed: true, checkedAt: "2026-10-16T09:41:00Z" },
      },
    });
    await act(() => queryClient.invalidateQueries());
    await waitFor(() =>
      expect(screen.getByTestId("delivery-gate-sitting-state")).toHaveTextContent("ready to sit"),
    );
    expect(screen.getByTestId("delivery-gate-sitting")).toHaveAttribute("data-state", "ready");
    expect(screen.getByTestId("delivery-gate-sitting")).not.toHaveTextContent("waiting for build");
    expect(screen.queryByTestId("delivery-gate-sitting-smoke")).not.toBeInTheDocument();
  });

  it("SB-TC-058 shows no gate sitting while the bench has none", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />, { queryClient: makeQueryClient() });
    await screen.findByTestId("delivery-snapshot");
    expect(screen.queryByTestId("delivery-gate-sitting")).not.toBeInTheDocument();
  });
});

describe("The Delivery tab's views (#1620)", () => {
  function breadcrumb(): HTMLElement {
    return screen.getByRole("navigation", { name: "Breadcrumb" });
  }

  it("opens decisions and steering from the rail, and its Delivery crumb returns to the map with the focus on the link", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const link = await screen.findByRole("button", { name: "Open the decision pile" });

    await userEvent.click(link);
    expect(screen.getByTestId("delivery-view-map")).not.toBeVisible();
    const view = screen.getByRole("region", { name: "Decisions and steering" });
    expect(view).toBeVisible();
    expect(within(view).getByRole("heading", { name: "Decisions and steering" })).toBeVisible();
    expect(breadcrumb()).toHaveTextContent("Bench 3/Delivery/Decisions and steering");
    expect(within(breadcrumb()).getByText("Decisions and steering")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("delivery-decision-pile-target")).toHaveFocus();
    expect(within(view).getByTestId("delivery-steering-controls")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-cost-health-controls")).not.toBeVisible();

    await userEvent.click(within(breadcrumb()).getByRole("button", { name: "Delivery" }));
    expect(screen.getByTestId("delivery-view-map")).toBeVisible();
    expect(screen.getByTestId("delivery-decisions-steering")).not.toBeVisible();
    expect(link).toHaveFocus();
  });

  it("opens decisions and steering from the rail's Next boundary panel with the focus in the steering note, and the crumb returns to the link", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const link = await openSteeringView();

    const view = screen.getByRole("region", { name: "Decisions and steering" });
    expect(view).toBeVisible();
    expect(screen.getByTestId("delivery-view-map")).not.toBeVisible();
    expect(within(view).getByRole("textbox", { name: "Steering note" })).toHaveFocus();

    await returnToMap();
    expect(screen.getByTestId("delivery-view-map")).toBeVisible();
    expect(link).toHaveFocus();
  });

  it("focuses the steering panel when no unit boundary is ahead and the note is disabled", async () => {
    const done = record();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      createDeliveryReducer().fold({
        record: { ...done, units: done.units.map((unit) => ({ ...unit, status: "done" })) },
        events: [],
      }),
    );
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await openSteeringView();

    expect(screen.getByRole("textbox", { name: "Steering note" })).toBeDisabled();
    expect(screen.getByTestId("delivery-steering-target")).toHaveFocus();
  });

  it("opens cost, health and controls from the rail, and its Bench crumb also returns to the map", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const link = await screen.findByRole("button", { name: "Cost, health and controls" });
    // The role matrix, the mode switch and the lifecycle buttons live in the
    // cost view only, never on the map (#1623).
    const map = screen.getByTestId("delivery-view-map");
    for (const id of [
      "delivery-role-controls",
      "delivery-mode-control",
      "delivery-lifecycle-controls",
    ]) {
      expect(within(map).queryByTestId(id)).not.toBeInTheDocument();
    }

    await userEvent.click(link);
    const view = screen.getByRole("region", { name: "Cost, health and controls" });
    expect(view).toBeVisible();
    expect(view).toHaveFocus();
    expect(breadcrumb()).toHaveTextContent("Bench 3/Delivery/Cost, health and controls");
    expect(within(view).getByTestId("delivery-lifecycle-controls")).toBeInTheDocument();
    expect(within(view).getByTestId("delivery-role-controls")).toBeInTheDocument();
    expect(within(view).getByTestId("delivery-mode-control")).toBeInTheDocument();
    expect(within(view).queryByTestId("delivery-decision-pile-target")).not.toBeInTheDocument();

    await userEvent.click(within(breadcrumb()).getByRole("button", { name: "Bench 3" }));
    expect(screen.getByTestId("delivery-view-map")).toBeVisible();
    expect(view).not.toBeVisible();
    expect(link).toHaveFocus();
  });

  it("reads attached in the cost view's health line while the attached bench holds no session (#1623)", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await openCostView();
    expect(screen.getByTestId("delivery-health-line")).toHaveAttribute("data-health", "attached");
  });

  it("opens a jammed unit's drill-in from its callout in the cost view (#1623)", async () => {
    const jammed = record();
    jammed.units = jammed.units.map((unit) =>
      unit.id === "B" ? { ...unit, status: "jammed" } : unit,
    );
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      createDeliveryReducer().fold({ record: jammed, events: [] }),
    );
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await openCostView();
    const jam = screen.getByTestId("delivery-jam-row-B");

    await userEvent.click(within(jam).getByRole("button", { name: "Open B" }));
    expect(screen.getByTestId("delivery-cost-health-controls")).not.toBeVisible();
    expect(screen.getByRole("region", { name: "Unit B" })).toBeVisible();
    expect(breadcrumb()).toHaveTextContent("Bench 3/Delivery/B");
  });

  it("opens a gate's drill-in as a view, and Close returns to the map with the focus on the gate", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const marker = await screen.findByTestId("gate-marker-gate-after-b");

    await userEvent.click(marker);
    expect(screen.getByTestId("delivery-view-map")).not.toBeVisible();
    const drillIn = screen.getByRole("region", { name: "Gate gate-after-b" });
    expect(drillIn).toBeVisible();
    expect(breadcrumb()).toHaveTextContent("Bench 3/Delivery/gate-after-b");

    await userEvent.click(within(drillIn).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("delivery-drill-in")).not.toBeInTheDocument();
    expect(screen.getByTestId("delivery-view-map")).toBeVisible();
    expect(marker).toHaveFocus();
  });

  it("focuses the map when the view it returns from was not opened from the map", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    const onDecisionPileFocused = vi.fn();
    renderWithProviders(
      <DeliveryTabPanel
        bench={bench}
        decisionPileFocusKey="link-1"
        onDecisionPileFocused={onDecisionPileFocused}
      />,
    );
    // A link to the decision pile opens the decisions view on the pile.
    await waitFor(() => expect(screen.getByTestId("delivery-decision-pile-target")).toHaveFocus());
    expect(screen.getByRole("region", { name: "Decisions and steering" })).toBeVisible();
    expect(onDecisionPileFocused).toHaveBeenCalledWith("link-1");

    await userEvent.click(within(breadcrumb()).getByRole("button", { name: "Delivery" }));
    expect(screen.getByTestId("delivery-view-map")).toHaveFocus();
  });

  it("focuses the map after a link from outside the tab, even when a map node opened the view before it", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    const { rerender } = renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const node = await screen.findByTestId("unit-node-B");

    // Node B opens its drill-in, and the return gives node B the focus back.
    await userEvent.click(node);
    await userEvent.click(within(breadcrumb()).getByRole("button", { name: "Delivery" }));
    expect(node).toHaveFocus();

    // A link from outside the tab arrives while node B has the focus. Node B
    // did not open the decisions view, so the return focuses the map.
    rerender(<DeliveryTabPanel bench={bench} decisionPileFocusKey="link-2" />);
    await waitFor(() => expect(screen.getByTestId("delivery-decision-pile-target")).toHaveFocus());
    await userEvent.click(within(breadcrumb()).getByRole("button", { name: "Delivery" }));
    expect(screen.getByTestId("delivery-view-map")).toHaveFocus();
    expect(node).not.toHaveFocus();
  });

  it("opens a unit's drill-in from a list row, and the return gives the row the focus back", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await userEvent.click(await screen.findByRole("button", { name: "List" }));
    const row = screen.getByTestId("unit-row-C");

    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("delivery-view-map")).not.toBeVisible();
    expect(screen.getByRole("region", { name: "Unit C" })).toBeVisible();
    expect(breadcrumb()).toHaveTextContent("Bench 3/Delivery/C");

    await userEvent.click(within(breadcrumb()).getByRole("button", { name: "Delivery" }));
    expect(screen.getByTestId("unit-row-C")).toHaveFocus();
  });

  it("keeps an unsent steering note while the operator goes to the map and back", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open the decision pile" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Steering note" }), "Keep it short");

    await userEvent.click(within(breadcrumb()).getByRole("button", { name: "Delivery" }));
    await userEvent.click(screen.getByRole("button", { name: "Open the decision pile" }));
    expect(screen.getByRole("textbox", { name: "Steering note" })).toHaveValue("Keep it short");
  });
});
