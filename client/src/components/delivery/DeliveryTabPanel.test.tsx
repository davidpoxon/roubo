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
import { renderWithProviders, makeQueryClient } from "../../test/renderWithProviders";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, fetchDelivery: vi.fn(), resumeDelivery: vi.fn(), fetchTerminals: vi.fn() };
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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled(),
    );
    expect(api.fetchTerminals).toHaveBeenCalledWith("demo", 3);

    vi.mocked(api.fetchTerminals).mockResolvedValue([
      { id: "session-1", benchKey: "demo:3", label: "agent", createdAt: "now", status: "ended" },
    ]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["terminals"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled());
  });
});
