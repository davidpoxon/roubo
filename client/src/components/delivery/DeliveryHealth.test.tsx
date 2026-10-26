// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord, unitChanged, unitEvent } from "../../test/delivery-fixtures";
import DeliveryBurn from "./DeliveryBurn";
import DeliveryDriftLedger from "./DeliveryDriftLedger";
import DeliveryJams from "./DeliveryJams";
import DeliveryRail from "./DeliveryHealth";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const LAST_EVENT = "2026-10-16T10:00:00Z";

// An event of the whole delivery, which names no unit.
function deliveryEvent(seq: number, type: string, payload: Record<string, unknown>): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts: LAST_EVENT,
    payload,
  };
}

describe("Delivery rail", () => {
  it("SB-TC-053 turns the chip stale 2 minutes after the last event with the record's age, and the next event clears it", () => {
    vi.useFakeTimers({ now: Date.parse(LAST_EVENT) });
    const record = fourUnitRecord();
    const events = [unitChanged(8, "B", "running")];
    const { rerender } = render(<DeliveryRail snapshot={foldDelivery({ record, events })} />);
    const chip = () => screen.getByTestId("delivery-health-chip");
    expect(chip()).toHaveAttribute("data-health", "fresh");
    expect(screen.queryByTestId("delivery-record-age")).not.toBeInTheDocument();

    // Step 1: the tooling stops, and 2 minutes pass with no event.
    act(() => vi.advanceTimersByTime(115_000));
    expect(chip()).toHaveAttribute("data-health", "fresh");
    act(() => vi.advanceTimersByTime(5_000));
    expect(chip()).toHaveAttribute("data-health", "stale");
    expect(chip()).toHaveTextContent("stale");
    // The record was last written at 09:30, 32 minutes before the clock.
    expect(screen.getByTestId("delivery-record-age")).toHaveTextContent("record 32m old");
    fireEvent.click(chip());
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("delivery-health-reason")).toHaveTextContent(
      "No event for 2 minutes",
    );

    // Step 2: one event arrives.
    const next = unitEvent(9, "B", "seam.ran", { seam: "plan" }, "2026-10-16T10:02:00Z");
    rerender(<DeliveryRail snapshot={foldDelivery({ record, events: [...events, next] })} />);
    expect(chip()).toHaveAttribute("data-health", "fresh");
    expect(screen.queryByTestId("delivery-record-age")).not.toBeInTheDocument();
  });

  it("reads disconnected while the stream is down and the delivery is not jammed", () => {
    vi.useFakeTimers({ now: Date.parse(LAST_EVENT) });
    render(
      <DeliveryRail
        snapshot={foldDelivery({ record: fourUnitRecord(), events: [] })}
        disconnected
      />,
    );
    expect(screen.getByTestId("delivery-health-chip")).toHaveAttribute(
      "data-health",
      "disconnected",
    );
  });
});

describe("Burn meter", () => {
  it("SB-TC-046 shows spend against the soft budget, per unit and per role, and moves with unit.changed and budget.changed", () => {
    const record = fourUnitRecord();
    record.budget = { ...record.budget, by_role: { main: 0.3, "unit-coder": 0.12 } };
    const { rerender } = render(<DeliveryBurn snapshot={foldDelivery({ record, events: [] })} />);
    const spent = screen.getByTestId("delivery-stat-spent");
    expect(spent).toHaveTextContent("0.42");
    expect(spent).toHaveTextContent("of 5.00 soft budget");
    expect(screen.getByTestId("delivery-burn-unit-A")).toHaveTextContent("0.42");
    expect(screen.queryByTestId("delivery-burn-unit-B")).not.toBeInTheDocument();
    expect(screen.getByTestId("delivery-burn-role-main")).toHaveTextContent("0.30");
    expect(screen.getByTestId("delivery-burn-role-unit-coder")).toHaveTextContent("0.12");

    const events = [
      unitEvent(8, "B", "unit.changed", { cost_usd: 0.25 }, LAST_EVENT),
      deliveryEvent(9, "budget.changed", { spent_usd: 5.5, by_role: { "unit-coder": 0.37 } }),
    ];
    rerender(<DeliveryBurn snapshot={foldDelivery({ record, events })} />);
    expect(screen.getByTestId("delivery-stat-spent")).toHaveTextContent("5.50");
    expect(screen.getByTestId("delivery-stat-spent")).toHaveTextContent("over budget");
    expect(screen.getByTestId("delivery-burn-unit-B")).toHaveTextContent("0.25");
    expect(screen.getByTestId("delivery-burn-role-unit-coder")).toHaveTextContent("0.37");
    expect(screen.getByTestId("delivery-burn-role-main")).toHaveTextContent("0.30");
  });
});

describe("Drift ledger", () => {
  it("SB-TC-048 lists each drift entry with file, summary, ids and the spec-layer pull request, and a drift.detected adds a row", () => {
    const record = fourUnitRecord();
    record.drift = [1, 2, 3].map((n) => ({
      kind: "spec",
      detail: `Edit ${n}`,
      detected_at: `2026-10-16T09:0${n}:00Z`,
      file: "prd.md",
      summary: `Edit ${n}`,
      ids: [`FX-FR-00${n}`],
      pr_url: "https://github.com/demo/demo/pull/7",
    }));
    const { rerender } = render(
      <DeliveryDriftLedger snapshot={foldDelivery({ record, events: [] })} />,
    );
    expect(screen.getAllByTestId(/^delivery-drift-row-/)).toHaveLength(3);
    const first = screen.getByTestId("delivery-drift-row-0");
    const col = (row: HTMLElement, name: string) =>
      row.querySelector(`[data-col="${name}"]`)?.textContent ?? "";
    expect([col(first, "file"), col(first, "summary"), col(first, "ids")]).toEqual([
      "prd.md",
      "Edit 1",
      "FX-FR-001",
    ]);
    expect(within(first).getByRole("link", { name: "Spec-layer pull request" })).toHaveAttribute(
      "href",
      "https://github.com/demo/demo/pull/7",
    );

    const drift = deliveryEvent(8, "drift.detected", {
      kind: "spec",
      file: "test-cases.json",
      summary: "Added a case",
      ids: ["FX-TC-009", "FX-TC-010"],
      pr_url: "https://github.com/demo/demo/pull/7",
    });
    rerender(<DeliveryDriftLedger snapshot={foldDelivery({ record, events: [drift] })} />);
    expect(screen.getAllByTestId(/^delivery-drift-row-/)).toHaveLength(4);
    const added = screen.getByTestId("delivery-drift-row-3");
    expect([col(added, "file"), col(added, "summary"), col(added, "ids")]).toEqual([
      "test-cases.json",
      "Added a case",
      "FX-TC-009FX-TC-010",
    ]);
  });

  it("shows an entry from before the spec-edit fields by its kind and detail", () => {
    const record = fourUnitRecord();
    record.drift = [{ kind: "scope", detail: "Unit B grew", detected_at: "2026-10-16T09:01:00Z" }];
    render(<DeliveryDriftLedger snapshot={foldDelivery({ record, events: [] })} />);
    const row = screen.getByTestId("delivery-drift-row-0");
    expect(row).toHaveTextContent("scope");
    expect(row).toHaveTextContent("Unit B grew");
    expect(row).toHaveTextContent("no spec-layer pull request");
  });
});

describe("Jam list", () => {
  it("lists each jammed unit with its id, title and status word, and drops a unit that resumes", () => {
    const record = fourUnitRecord();
    const { rerender } = render(<DeliveryJams snapshot={foldDelivery({ record, events: [] })} />);
    expect(screen.getByTestId("delivery-jams")).toHaveTextContent("No unit is jammed");

    const jammed = [unitChanged(8, "B", "jammed"), unitChanged(9, "C", "stuck")];
    rerender(<DeliveryJams snapshot={foldDelivery({ record, events: jammed })} />);
    const rows = screen.getAllByTestId(/^delivery-jam-row-/);
    expect(rows.map((row) => row.dataset.unit)).toEqual(["B", "C"]);
    expect(rows[0]).toHaveTextContent("BSecondjammed");
    expect(rows[1]).toHaveTextContent("CThirdstuck");

    const resumed = [...jammed, unitChanged(10, "B", "running")];
    rerender(<DeliveryJams snapshot={foldDelivery({ record, events: resumed })} />);
    expect(screen.getAllByTestId(/^delivery-jam-row-/).map((row) => row.dataset.unit)).toEqual([
      "C",
    ]);
  });
});
