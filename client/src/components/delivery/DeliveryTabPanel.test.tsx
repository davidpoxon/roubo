// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
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
    resumeDelivery: vi.fn(),
    launchDelivery: vi.fn(),
    fetchTerminals: vi.fn(),
  };
});
import * as api from "../../lib/api";
import DeliveryTabPanel from "./DeliveryTabPanel";

const bench = {
  id: 3,
  projectId: "demo",
  variant: "specbench",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "attach",
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
    expect(screen.getByTestId("delivery-budget")).toHaveTextContent("$0.42 of $5.00");
    expect(screen.getByTestId("delivery-decision-controls")).toHaveTextContent(
      "One file per unit or one per stack?",
    );
    expect(screen.getByRole("button", { name: "one file per stack" })).toBeInTheDocument();
    expect(screen.getByTestId("delivery-steering-controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "main: balanced" })).toBeInTheDocument();
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

  it("waits for a record that the session has not written yet, with no control", async () => {
    vi.mocked(api.fetchDelivery).mockRejectedValueOnce(
      readError({ code: "DELIVERY_RECORD_MISSING", error: "No delivery record yet" }),
    );
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    const callout = await screen.findByTestId("delivery-read-error");
    expect(callout).toHaveAttribute("role", "status");
    expectNoControls();
  });

  it("offers a launch-mode bench with no record its launch again, and launches on press", async () => {
    vi.mocked(api.fetchDelivery).mockRejectedValue(
      readError({ code: "DELIVERY_RECORD_MISSING", error: "No delivery record yet" }),
    );
    vi.mocked(api.launchDelivery).mockResolvedValue({ sessionId: "session-2" });
    renderWithProviders(
      <DeliveryTabPanel bench={{ ...bench, status: "active", deliveryBindMode: "launch" }} />,
    );

    const control = await screen.findByTestId("delivery-launch-control");
    expect(screen.getByTestId("delivery-read-error")).toContainElement(control);
    // Launching is the only control: the record's controls still wait for it.
    expect(screen.queryByTestId("delivery-lifecycle-controls")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Launch the delivery session" }));
    await waitFor(() => expect(api.launchDelivery).toHaveBeenCalledWith("demo", 3));
  });

  it.each(["clearing", "error"] as const)(
    "disables the launch control while the bench is %s",
    async (status) => {
      vi.mocked(api.fetchDelivery).mockRejectedValue(
        readError({ code: "DELIVERY_RECORD_MISSING", error: "No delivery record yet" }),
      );
      renderWithProviders(
        <DeliveryTabPanel bench={{ ...bench, status, deliveryBindMode: "launch" }} />,
      );

      expect(
        await screen.findByRole("button", { name: "Launch the delivery session" }),
      ).toBeDisabled();
    },
  );

  it("disables the launch control while the session the bench launched is live", async () => {
    vi.mocked(api.fetchDelivery).mockRejectedValue(
      readError({ code: "DELIVERY_RECORD_MISSING", error: "No delivery record yet" }),
    );
    vi.mocked(api.fetchTerminals).mockResolvedValue([
      { id: "session-1", benchKey: "demo:3", label: "agent", createdAt: "now", status: "live" },
    ]);
    renderWithProviders(
      <DeliveryTabPanel
        bench={{
          ...bench,
          status: "active",
          deliveryBindMode: "launch",
          deliverySessionId: "session-1",
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch the delivery session" })).toBeDisabled(),
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

    it("SB-TC-022 reads 3 of 10 cases met, counts covered requirements, and reads no units done", async () => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(progressSnapshot());
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      const cases = await screen.findByTestId("delivery-stat-cases");
      expect(cases).toHaveTextContent("3 of 10 cases met");
      expect(screen.getByTestId("delivery-stat-requirements")).toHaveTextContent(
        "1 of 2 requirements covered",
      );
      const progress = screen.getByTestId("delivery-progress");
      expect(progress).not.toHaveTextContent(/units?/i);
      expect(screen.getByTestId("delivery-snapshot")).not.toHaveTextContent(/2 of 4 units/);
    });

    it("SB-TC-022 opens a met case's verify record and links the pull request of the unit that met it", async () => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(progressSnapshot());
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      const metCases = await screen.findByTestId("delivery-met-cases");
      // Only the met cases are offered.
      expect(screen.queryByRole("button", { name: ids[3] })).not.toBeInTheDocument();
      expect(screen.queryByTestId(`delivery-verify-record-${ids[0]}`)).not.toBeInTheDocument();

      const caseButton = screen.getByRole("button", { name: ids[0] });
      await userEvent.click(caseButton);

      expect(caseButton).toHaveAttribute("aria-expanded", "true");
      const verifyRecord = screen.getByTestId(`delivery-verify-record-${ids[0]}`);
      expect(metCases).toContainElement(verifyRecord);
      expect(verifyRecord).toHaveTextContent("passed");
      expect(verifyRecord).toHaveTextContent("tier b, high confidence");
      expect(verifyRecord).toHaveTextContent("report.xml#FIX-TC-001");
      expect(verifyRecord).toHaveTextContent("The suite row passed.");
      expect(screen.getByRole("link", { name: "Pull request of B" })).toHaveAttribute(
        "href",
        "https://github.com/demo/demo/pull/2",
      );
    });

    it("SB-TC-022 links no pull request whose url is not a web address", async () => {
      const snapshot = progressSnapshot();
      snapshot.progress.caseList = snapshot.progress.caseList.map((entry) =>
        entry.met ? { ...entry, prUrl: "javascript:alert(1)" } : entry,
      );
      vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot);
      renderWithProviders(<DeliveryTabPanel bench={bench} />);

      await userEvent.click(await screen.findByRole("button", { name: ids[1] }));

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

    await userEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.resumeDelivery).toHaveBeenCalledWith("demo", 3));
  });

  it.each(["clearing", "error"] as const)(
    "disables Resume while the bench is %s",
    async (status) => {
      vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
      renderWithProviders(<DeliveryTabPanel bench={{ ...bench, status }} />);

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

    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled());
    expect(api.fetchTerminals).toHaveBeenCalledWith("demo", 3);

    vi.mocked(api.fetchTerminals).mockResolvedValue([
      { id: "session-1", benchKey: "demo:3", label: "agent", createdAt: "now", status: "ended" },
    ]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["terminals"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled());
  });
});
