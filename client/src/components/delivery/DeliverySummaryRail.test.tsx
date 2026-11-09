// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import type { DeliveryCrossCheckResponse } from "@roubo/shared/delivery-bench";
import {
  DELIVERY_CONTROL_SCHEMA_ID,
  DELIVERY_CONTROL_SCHEMA_VERSION,
  type DeliveryControl,
} from "@roubo/shared/delivery-control-contract";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import { DeliveryCrossCheckChip } from "./DeliveryCrossCheck";
import { BurnHealthPanel, DecisionSummaryPanel, NextBoundaryPanel } from "./DeliverySummaryRail";

afterEach(cleanup);

function recordWithDecisions() {
  const record = fourUnitRecord();
  return {
    ...record,
    decisions: [
      {
        id: "D-2",
        question: "Keep the cache per unit?",
        options: ["per unit", "per stack"],
        default: "per unit",
        status: "open",
        unit_id: "B",
        raised_at: "2026-10-16T09:20:00Z",
      },
      {
        id: "D-1",
        question: "Retry the flaky check?",
        options: ["retry", "skip"],
        default: "retry",
        status: "defaulted",
        unit_id: "A",
        raised_at: "2026-10-16T09:10:00Z",
      },
    ],
  };
}

describe("BurnHealthPanel", () => {
  it("holds spent, jams and cases in one strip and opens the cost view from its header", async () => {
    const onOpen = vi.fn();
    render(
      <BurnHealthPanel
        snapshot={foldDelivery({ record: fourUnitRecord(), events: [] })}
        onOpenCostHealthControls={onOpen}
      />,
    );
    const panel = screen.getByRole("region", { name: "Burn and health" });
    const strip = within(panel).getByTestId("delivery-burn-health-stats");
    expect(strip.children).toHaveLength(3);
    expect(within(strip).getByTestId("delivery-rail-stat-spent")).toHaveTextContent("Spent");
    expect(within(strip).getByTestId("delivery-rail-stat-jams")).toHaveTextContent(
      "no unit is jammed",
    );
    expect(within(strip).getByTestId("delivery-rail-stat-cases")).toHaveTextContent("cases met");
    await userEvent.click(within(panel).getByRole("button", { name: "Cost, health and controls" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("BurnHealthPanel figures", () => {
  it("lists the jammed units in stack order, reads the cases met over the total, and names an overrun", () => {
    const record = fourUnitRecord();
    const jammed = {
      ...record,
      budget: { ...record.budget, soft_budget_usd: 1, spent_usd: 1.5 },
      units: record.units.map((unit) =>
        unit.id === "C" || unit.id === "B" ? { ...unit, status: "jammed" } : unit,
      ),
    };
    render(
      <BurnHealthPanel
        snapshot={foldDelivery({ record: jammed, events: [] })}
        onOpenCostHealthControls={() => undefined}
      />,
    );
    const jams = screen.getByTestId("delivery-rail-stat-jams");
    expect(jams).toHaveTextContent("2");
    expect(jams).toHaveTextContent("B, C");
    expect(screen.getByTestId("delivery-rail-stat-cases")).toHaveTextContent(
      /^Cases\d+ \/ \d+ cases met$/,
    );
    expect(screen.getByTestId("delivery-rail-stat-spent")).toHaveTextContent(
      "of 1.00 soft budget, over budget",
    );
  });
});

describe("DecisionSummaryPanel", () => {
  it("shows the open decision first with its question, the counts, and a link to the pile", async () => {
    const onOpen = vi.fn();
    render(
      <DecisionSummaryPanel
        snapshot={foldDelivery({ record: recordWithDecisions(), events: [] })}
        onOpenDecisions={onOpen}
      />,
    );
    const panel = screen.getByRole("region", { name: "Decision summary" });
    expect(within(panel).getByRole("heading", { name: "Decisions" })).toBeTruthy();
    expect(within(panel).getByTestId("delivery-decision-summary-counts")).toHaveTextContent(
      "0 to review · 1 pending",
    );
    const items = within(panel).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("D-2 · open");
    expect(items[0]).toHaveTextContent("Keep the cache per unit?");
    expect(items[1]).toHaveTextContent("D-1 · defaulted");
    expect(items[1]).not.toHaveTextContent("Retry the flaky check?");
    // Nothing in the summary answers a decision.
    expect(within(panel).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(within(panel).getByRole("button", { name: "Open the decision pile" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("says so when no decision is on the pile", () => {
    render(
      <DecisionSummaryPanel
        snapshot={foldDelivery({ record: fourUnitRecord(), events: [] })}
        onOpenDecisions={() => undefined}
      />,
    );
    expect(screen.getByText("No decision is on the pile")).toBeTruthy();
  });
});

describe("NextBoundaryPanel", () => {
  it("names the next boundary's unit and its status, and what is queued for it", () => {
    render(<NextBoundaryPanel snapshot={foldDelivery({ record: fourUnitRecord(), events: [] })} />);
    const panel = screen.getByRole("region", { name: "Boundary summary" });
    expect(within(panel).getByRole("heading", { name: "Next boundary" })).toBeTruthy();
    expect(within(panel).getByText("A · running")).toBeTruthy();
    expect(within(panel).getByText("Nothing is queued for it")).toBeTruthy();
  });

  it("lists each note and role change queued for the boundary", () => {
    const control = (seq: number, kind: string, body: object, target?: string) =>
      ({
        $schema: DELIVERY_CONTROL_SCHEMA_ID,
        schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
        delivery_id: "demo-delivery-1",
        control_seq: seq,
        kind,
        body,
        ...(target !== undefined && { target_id: target }),
        durability: "durable",
        issued_at: "2026-10-16T10:00:00Z",
        status: "pending",
      }) as DeliveryControl;
    render(
      <NextBoundaryPanel
        snapshot={foldDelivery({
          record: fourUnitRecord(),
          events: [],
          controls: [
            control(3, "steering-note", { note: "Prefer the dialog component" }),
            control(4, "role-change", { tier: "fast" }, "coder"),
          ],
        })}
      />,
    );
    const panel = screen.getByRole("region", { name: "Boundary summary" });
    expect(within(panel).getByTestId("delivery-next-boundary-item-3")).toHaveTextContent(
      "note queued",
    );
    expect(within(panel).getByTestId("delivery-next-boundary-item-3")).toHaveTextContent(
      "Prefer the dialog component",
    );
    expect(within(panel).getByTestId("delivery-next-boundary-item-4")).toHaveTextContent(
      "role queued",
    );
    expect(within(panel).getByTestId("delivery-next-boundary-item-4")).toHaveTextContent(
      "coder: fast",
    );
  });

  it("says so when no unit boundary is ahead", () => {
    const record = fourUnitRecord();
    const done = {
      ...record,
      units: record.units.map((unit) => ({ ...unit, status: "done" })),
    };
    render(<NextBoundaryPanel snapshot={foldDelivery({ record: done, events: [] })} />);
    const panel = screen.getByRole("region", { name: "Boundary summary" });
    expect(within(panel).getByText("No unit boundary is ahead")).toBeTruthy();
  });
});

function crossCheck(blocking: boolean[]): DeliveryCrossCheckResponse {
  return {
    disagreements: blocking.map((block, index) => ({
      class: index === 0 ? "layer-order-differs" : "branch-missing",
      blocking: block,
      unitId: "A",
      claimed: "claimed",
      observed: "observed",
      source: "git",
    })),
    refreshedAt: "2026-10-16T10:00:05Z",
    sourceError: null,
  };
}

describe("DeliveryCrossCheckChip", () => {
  it.each([
    [[false], "1 disagreement · layer-order-differs"],
    [[false, true, true], "3 disagreements · 2 blocking"],
    [[false, false], "2 disagreements"],
  ])("reads %j as %s and opens the cross-check on a press", async (blocking, text) => {
    const onOpen = vi.fn();
    render(<DeliveryCrossCheckChip crossCheck={crossCheck(blocking)} onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: `Show the cross-check: ${text}` });
    expect(chip).toHaveTextContent(text);
    await userEvent.click(chip);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("names a source it could not read when no disagreement was found", () => {
    render(
      <DeliveryCrossCheckChip
        crossCheck={{
          ...crossCheck([]),
          sourceError: { source: "github", message: "fetch failed" },
        }}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByTestId("delivery-crosscheck-chip")).toHaveTextContent(
      "cross-check · source not read",
    );
  });

  it("does not show while the cross-check has nothing to show", () => {
    render(<DeliveryCrossCheckChip crossCheck={crossCheck([])} onOpen={() => undefined} />);
    expect(screen.queryByTestId("delivery-crosscheck-chip")).toBeNull();
  });
});
