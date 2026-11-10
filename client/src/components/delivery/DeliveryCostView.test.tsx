// @vitest-environment jsdom
// The cost view of the Delivery tab (#1623): a title row with the lifecycle
// badge and buttons, then the Burn, Time (#1671), Health, Role matrix,
// Decision mode and Drift ledger panels, in that order. Each reads figures the
// snapshot has, except Time, which reads the delivery's time split.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench } from "@roubo/shared";
import type { DeliveryCrossCheckResponse } from "@roubo/shared/delivery-bench";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord, unitChanged } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { formatElapsed } from "./delivery-health-model";
import { deriveDeliveryTimeSplit } from "@roubo/shared/delivery-time-split";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, fetchDeliveryTime: vi.fn() };
});
import * as api from "../../lib/api";
import DeliveryCostView from "./DeliveryCostView";

beforeEach(() => {
  vi.mocked(api.fetchDeliveryTime).mockReset();
  vi.mocked(api.fetchDeliveryTime).mockImplementation(async () =>
    deriveDeliveryTimeSplit({
      record: fourUnitRecord(),
      events: [unitChanged(8, "B", "running")],
      now: Date.parse("2026-10-16T10:00:00Z"),
    }),
  );
});

const bench = {
  id: 3,
  projectId: "demo",
  status: "active",
  variant: "specbench",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "launch",
} as unknown as Bench;

// Two display-only disagreements.
const crossCheck: DeliveryCrossCheckResponse = {
  disagreements: ["A", "B"].map((unitId) => ({
    class: "layer-order-differs",
    blocking: false,
    unitId,
    claimed: "1",
    observed: "2",
    source: "git",
  })),
  refreshedAt: "2026-10-16T10:00:00Z",
  sourceError: null,
};

function renderView(
  events: DeliveryEvent[] = [],
  onOpenUnit = vi.fn(),
  lifecycle: { ended_at?: string } = {},
  edit: (record: ReturnType<typeof fourUnitRecord>) => void = () => undefined,
) {
  const record = fourUnitRecord();
  record.lifecycle = { ...record.lifecycle, ...lifecycle };
  record.budget = {
    ...record.budget,
    by_role: { main: 0.12, "unit-coder": 0.2, "gate-verifier": 0.02 },
  };
  record.roles = { main: { tier: "balanced" }, "unit-coder": { tier: "fast" } };
  record.drift = [
    {
      kind: "spec",
      detail: "Added a case",
      detected_at: "2026-10-16T10:31:00Z",
      file: "test-cases.json",
      summary: "Added a case",
      ids: ["FX-TC-009"],
      unit_id: "B",
    },
  ];
  edit(record);
  renderWithProviders(
    <section aria-label="Cost, health and controls">
      <DeliveryCostView
        bench={bench}
        snapshot={foldDelivery({ record, events })}
        title="Cost, health and controls"
        ended={false}
        attached={false}
        sessionStartBlocked={false}
        crossCheck={crossCheck}
        driftLedgerRef={() => undefined}
        onOpenUnit={onOpenUnit}
      />
    </section>,
  );
  return onOpenUnit;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DeliveryCostView", () => {
  it("shows the title row, then Burn, Time, Health, Role matrix, Decision mode and Drift ledger, in that order", () => {
    renderView();
    const order = [
      screen.getByRole("heading", { level: 2, name: "Cost, health and controls" }),
      screen.getByTestId("delivery-lifecycle"),
      screen.getByRole("region", { name: "Lifecycle" }),
      screen.getByRole("region", { name: "Burn" }),
      screen.getByRole("region", { name: "Time of the delivery" }),
      screen.getByRole("region", { name: "Health" }),
      screen.getByRole("region", { name: "Roles" }),
      screen.getByRole("region", { name: "Decision mode" }),
      screen.getByRole("region", { name: "Drift ledger" }),
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1].compareDocumentPosition(order[index])).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    expect(screen.getByTestId("delivery-lifecycle")).toHaveTextContent("running");
    expect(
      within(screen.getByRole("region", { name: "Lifecycle" })).getByRole("button", {
        name: "Wind down",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Decision mode" })).getByTestId(
        "delivery-mode-control",
      ),
    ).toBeInTheDocument();
  });

  it("#1671 shows the delivery's elapsed time split beside the burn, the parts adding up to it", async () => {
    renderView();
    const time = screen.getByRole("region", { name: "Time of the delivery" });
    // The delivery started at 09:00 and the split is read at 10:00.
    expect(await within(time).findByTestId("delivery-time-total")).toHaveTextContent(
      "Total1h 00m1 hour",
    );
    expect(time).toHaveTextContent("since 2026-10-16 09:00 UTC");
    for (const state of ["agent", "operator", "gate", "no_session"]) {
      expect(within(time).getByTestId(`delivery-time-${state}`)).toBeInTheDocument();
    }
  });

  it("fills the Burn strip with spent, the top role, spend against the estimate and the elapsed time", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-17T13:30:00Z"), toFake: ["Date"] });
    renderView();
    expect(screen.getByTestId("delivery-stat-spent")).toHaveTextContent("0.42 of 5.00 soft budget");
    const role = screen.getByTestId("delivery-stat-by-role");
    expect(role).toHaveTextContent("0.20");
    expect(role).toHaveTextContent("unit-coder · 48 percent");
    expect(role).toHaveTextContent("main 0.12 · gate-verifier 0.02");
    expect(screen.getByTestId("delivery-stat-estimate")).toHaveTextContent(
      "3.20 spent is 13 percent of it",
    );
    expect(screen.getByTestId("delivery-stat-elapsed")).toHaveTextContent(
      "1d 04h since 2026-10-16 09:00 UTC",
    );
  });

  it("says no role has a cost yet and there is no estimate when the record has neither", () => {
    renderView([], vi.fn(), {}, (record) => {
      record.budget = { estimate_usd: 0, soft_budget_usd: 5, spent_usd: 0.42 };
    });
    const role = screen.getByTestId("delivery-stat-by-role");
    expect(role).toHaveTextContent("none");
    expect(role).toHaveTextContent("no role has a cost yet");
    expect(screen.getByTestId("delivery-stat-estimate")).toHaveTextContent("0.00 no estimate");
  });

  it("stops the elapsed time at the end of an ended delivery", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-20T00:00:00Z"), toFake: ["Date"] });
    renderView([], vi.fn(), { ended_at: "2026-10-16T12:15:00Z" });
    expect(screen.getByTestId("delivery-stat-elapsed")).toHaveTextContent(
      "3h 15m ended 2026-10-16 12:15 UTC",
    );
  });

  it("writes an elapsed time in minutes, then hours and minutes, then days and hours", () => {
    expect(formatElapsed(42 * 60_000)).toBe("42m");
    expect(formatElapsed((3 * 60 + 5) * 60_000)).toBe("3h 05m");
    expect(formatElapsed((26 * 60 + 59) * 60_000)).toBe("1d 02h");
  });

  it("counts the jams and disagreements, and shows each jam as a callout that opens its unit", async () => {
    const onOpenUnit = renderView([unitChanged(8, "B", "jammed")]);
    const health = screen.getByRole("region", { name: "Health" });
    expect(health.querySelector("header")).toHaveTextContent("1 jam · 2 disagreements");
    expect(within(health).getByTestId("delivery-health-line")).toHaveAttribute(
      "data-health",
      "blocked",
    );
    const jam = within(health).getByTestId("delivery-jam-row-B");
    expect(jam).toHaveTextContent("BSecondjammed");
    await userEvent.setup().click(within(jam).getByRole("button", { name: "Open B" }));
    expect(onOpenUnit).toHaveBeenCalledWith("B");
  });

  it("gives each role its share of the spend, and each drift row its time, file, ids and unit", () => {
    renderView();
    expect(screen.getByTestId("role-spent-unit-coder")).toHaveTextContent("$0.20 · 48 percent");
    const ledger = screen.getByRole("region", { name: "Drift ledger" });
    expect(ledger.querySelector("header")).toHaveTextContent("1 entry");
    const row = within(ledger).getByTestId("delivery-drift-row-0");
    expect(row.querySelector('[data-col="time"]')).toHaveTextContent("2026-10-16 10:31 UTC");
    expect(row).toHaveTextContent("test-cases.json");
    expect(row.querySelector('[data-col="ids"]')).toHaveTextContent(/^FX-TC-009$/);
    expect(row.querySelector('[data-col="unit"]')).toHaveTextContent("· B");
  });
});
