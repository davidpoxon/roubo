// @vitest-environment jsdom
//
// The cross-check rail on the Delivery tab by keyboard and screen reader
// (SB-FR-029, SB-NFR-004, SB-US-010): each disagreement is an entry in the Tab
// order, announced with its class and whether it blocks; Enter on an entry
// focuses its unit or gate on the map; and a blocking class holds Approve
// back with the class named in place.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench } from "@roubo/shared";
import type { DeliveryCrossCheckDisagreement } from "@roubo/shared/delivery-bench";
import {
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { createDeliveryReducer } from "@roubo/shared/delivery-reducer";
import { renderWithProviders } from "../../test/renderWithProviders";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchDeliveryCrossCheck: vi.fn(),
    approveDelivery: vi.fn(),
    fetchTerminals: vi.fn(),
  };
});
import * as api from "../../lib/api";
import DeliveryTabPanel from "./DeliveryTabPanel";
import { openCostView, returnToMap } from "../../test/delivery-views";

const bench = {
  id: 3,
  projectId: "demo",
  variant: "specbench",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "attach",
} as unknown as Bench;

// Four units A, B, C and D, a stack of A, B and C, and gates after B and after
// C, running, with no review and no gating case.
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
    decisions: [],
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

const HEAD_MOVED: DeliveryCrossCheckDisagreement = {
  class: "head-commit-differs",
  blocking: true,
  unitId: "A",
  claimed: { local: "a".repeat(40) },
  observed: { local: "e".repeat(40) },
  source: "git",
};
const GATE_DIFFERS: DeliveryCrossCheckDisagreement = {
  class: "gate-state-differs",
  blocking: true,
  unitId: "gate-after-b",
  claimed: "passed",
  observed: "stale",
  source: "test-results.json",
};
const RECORD_STALE: DeliveryCrossCheckDisagreement = {
  class: "record-stale",
  blocking: false,
  unitId: "B",
  claimed: "2026-10-16T09:30:00Z",
  observed: "2026-10-16T10:00:00Z",
  source: "git",
};

// One disagreement of each display-only class.
const DISPLAY_ONLY: DeliveryCrossCheckDisagreement[] = [
  {
    class: "layer-order-differs",
    blocking: false,
    stack: "A",
    claimed: ["fx/0-a", "fx/1-b", "fx/2-c"],
    observed: ["fx/0-a", "fx/2-c", "fx/1-b"],
    source: "stack",
  },
  {
    class: "base-branch-differs",
    blocking: false,
    unitId: "C",
    claimed: "fx/1-b",
    observed: "main",
    source: "pull-request-api",
  },
  {
    class: "case-status-differs",
    blocking: false,
    unitId: "gate-after-c",
    caseId: "FX-TC-003",
    claimed: "met",
    observed: "failed",
    source: "test-results.json",
  },
  RECORD_STALE,
];

function withDisagreements(disagreements: DeliveryCrossCheckDisagreement[]): void {
  vi.mocked(api.fetchDeliveryCrossCheck).mockResolvedValue({
    disagreements,
    refreshedAt: "2026-10-16T10:00:05Z",
    sourceError: null,
  });
}

beforeEach(() => {
  vi.mocked(api.fetchDelivery).mockReset();
  vi.mocked(api.fetchDelivery).mockResolvedValue(
    createDeliveryReducer().fold({ record: record(), events: [] }),
  );
  vi.mocked(api.fetchDeliveryCrossCheck).mockReset();
  vi.mocked(api.approveDelivery).mockReset();
  vi.mocked(api.fetchTerminals).mockReset();
  vi.mocked(api.fetchTerminals).mockResolvedValue([]);
});

async function rail(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Cross-check" });
}

describe("The cross-check rail by keyboard and screen reader", () => {
  it("SB-TC-078 tabs to each of three entries, announced with its class and whether it blocks, and Enter focuses its unit or gate on the map", async () => {
    withDisagreements([HEAD_MOVED, GATE_DIFFERS, RECORD_STALE]);
    const user = userEvent.setup();
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const region = await rail();
    const entries = within(region).getAllByRole("button");
    expect(entries).toHaveLength(3);

    // Step 1: Tab reaches the rail, and each entry in turn.
    for (let step = 0; step < 30 && document.activeElement !== entries[0]; step += 1) {
      await user.tab();
    }
    expect(entries[0]).toHaveFocus();
    expect(entries[0]).toHaveAccessibleName("head-commit-differs, blocking, A");
    await user.tab();
    expect(entries[1]).toHaveFocus();
    expect(entries[1]).toHaveAccessibleName("gate-state-differs, blocking, gate-after-b");
    await user.tab();
    expect(entries[2]).toHaveFocus();
    expect(entries[2]).toHaveAccessibleName("record-stale, shown only, B");

    // Step 2: Enter on the gate entry focuses the gate on the map.
    entries[1].focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("gate-marker-gate-after-b")).toHaveFocus();

    // And on a unit entry, the unit.
    entries[0].focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("unit-node-A")).toHaveFocus();
    expect(screen.getByTestId("unit-node-A")).toHaveAttribute("aria-current", "true");
  });

  it("Enter on a gate entry focuses the row of the unit it follows in the list view", async () => {
    withDisagreements([GATE_DIFFERS]);
    const user = userEvent.setup();
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const region = await rail();
    await user.click(screen.getByRole("button", { name: "List" }));
    const entry = within(region).getByRole("button", {
      name: "gate-state-differs, blocking, gate-after-b",
    });
    entry.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("unit-row-B")).toHaveFocus();
  });

  it("shows each display-only class on the rail as shown only, and it does not hold Approve back", async () => {
    withDisagreements(DISPLAY_ONLY);
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const region = await rail();
    const rows = within(region).getAllByTestId("delivery-crosscheck-row");
    expect(rows.map((row) => row.getAttribute("data-class"))).toEqual([
      "layer-order-differs",
      "base-branch-differs",
      "case-status-differs",
      "record-stale",
    ]);
    for (const row of rows) {
      expect(row).toHaveAttribute("data-blocking", "false");
      expect(within(row).getByRole("button")).toHaveAccessibleName(/, shown only, /);
    }
    await openCostView();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.queryByTestId("delivery-approve-reason")).not.toBeInTheDocument();
  });

  it("holds Approve back under a blocking class and names the class in place", async () => {
    withDisagreements([HEAD_MOVED]);
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await rail();
    await openCostView();
    const approve = screen.getByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve).toBeDisabled());
    const reason = screen.getByTestId("delivery-approve-reason");
    expect(reason).toHaveAttribute("data-code", "CROSSCHECK_BLOCKED");
    expect(reason).toHaveTextContent("head-commit-differs");
    expect(approve).toHaveAccessibleDescription(/head-commit-differs/);
  });

  it("shows the route's CROSSCHECK_BLOCKED in place of a generic error when the view had not read the class yet", async () => {
    withDisagreements([]);
    vi.mocked(api.approveDelivery).mockRejectedValue(
      new api.ApiError(
        "The cross-check finds head-commit-differs, a blocking disagreement, which blocks the approval: reconcile the delivery record with its source of truth first",
        409,
        "CROSSCHECK_BLOCKED",
        { code: "CROSSCHECK_BLOCKED", classes: ["head-commit-differs"] },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await openCostView(user);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve).toBeEnabled());
    // The next cross-check read lists the class the route found.
    withDisagreements([HEAD_MOVED]);
    await user.click(approve);
    const reason = await screen.findByTestId("delivery-approve-reason");
    expect(reason).toHaveAttribute("data-code", "CROSSCHECK_BLOCKED");
    expect(reason).toHaveTextContent("head-commit-differs");
    expect(screen.queryByText("The approval was not sent")).not.toBeInTheDocument();
    // The refusal reads the cross-check again, so the rail lists the class.
    await returnToMap(user);
    const region = await rail();
    expect(within(region).getByRole("button")).toHaveAccessibleName(
      "head-commit-differs, blocking, A",
    );
  });
});
