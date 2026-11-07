// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type {
  DeliveryCrossCheckDisagreement,
  DeliveryCrossCheckResponse,
} from "@roubo/shared/delivery-bench";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import DeliveryRail from "./DeliveryHealth";

afterEach(() => {
  cleanup();
});

// One disagreement of each of the nine classes, in the server's class order.
const NINE: DeliveryCrossCheckDisagreement[] = [
  {
    class: "branch-missing",
    blocking: true,
    unitId: "D",
    claimed: "fx/0-d",
    observed: null,
    source: "git",
  },
  {
    class: "head-commit-differs",
    blocking: true,
    unitId: "A",
    claimed: { local: "a".repeat(40) },
    observed: { local: "e".repeat(40) },
    source: "git",
  },
  {
    class: "layer-order-differs",
    blocking: false,
    stack: "A",
    claimed: ["fx/0-a", "fx/1-b", "fx/2-c"],
    observed: ["fx/0-a", "fx/2-c", "fx/1-b"],
    source: "stack",
  },
  {
    class: "pr-state-differs",
    blocking: true,
    unitId: "B",
    blocksAbove: ["C"],
    claimed: "https://github.com/example/fixture/pull/2",
    observed: "closed",
    source: "pull-request-api",
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
    class: "gate-state-differs",
    blocking: true,
    unitId: "gate-after-b",
    claimed: "passed",
    observed: "stale",
    source: "test-results.json",
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
  {
    class: "plan-hash-mismatch",
    blocking: true,
    claimed: "hash-1",
    observed: "hash-2",
    source: "test-results.json",
  },
  {
    class: "record-stale",
    blocking: false,
    unitId: "B",
    claimed: "2026-10-16T09:30:00Z",
    observed: "2026-10-16T10:00:00Z",
    source: "git",
  },
];

function crossCheck(
  overrides: Partial<DeliveryCrossCheckResponse> = {},
): DeliveryCrossCheckResponse {
  return {
    disagreements: NINE,
    refreshedAt: "2026-10-16T10:00:05Z",
    sourceError: null,
    ...overrides,
  };
}

function renderRail(check: DeliveryCrossCheckResponse | undefined) {
  const snapshot = foldDelivery({ record: fourUnitRecord(), events: [] });
  return render(<DeliveryRail snapshot={snapshot} crossCheck={check} />);
}

describe("The cross-check on the delivery rail", () => {
  it("SB-TC-074 lists all nine disagreements on the rail, each with its class and whether it blocks", () => {
    renderRail(crossCheck());
    const rail = screen.getByRole("group", { name: "Delivery health" });
    const rows = within(rail).getAllByTestId("delivery-crosscheck-row");
    expect(rows).toHaveLength(9);
    expect(rows.map((row) => row.getAttribute("data-class"))).toEqual(NINE.map((d) => d.class));
    expect(rows[0]).toHaveTextContent("branch-missing");
    expect(rows[0]).toHaveTextContent("D");
    expect(rows[0]).toHaveTextContent("blocking");
    expect(rows[2]).toHaveTextContent("A");
    expect(rows[2]).toHaveTextContent("shown only");
    expect(rows[6]).toHaveTextContent("gate-after-c FX-TC-003");
    expect(rows[7]).toHaveTextContent("delivery");
    expect(screen.queryByTestId("delivery-crosscheck-source-error")).not.toBeInTheDocument();
  });

  it("SB-TC-075 shows the source error naming GitHub beside the previous list, and clears it on the next good refresh", () => {
    const { rerender } = renderRail(
      crossCheck({ sourceError: { source: "github", message: "fetch failed" } }),
    );
    const error = screen.getByTestId("delivery-crosscheck-source-error");
    expect(error).toHaveAttribute("role", "status");
    expect(error).toHaveTextContent("GitHub could not be read: fetch failed");
    expect(screen.getAllByTestId("delivery-crosscheck-row")).toHaveLength(9);

    const snapshot = foldDelivery({ record: fourUnitRecord(), events: [] });
    rerender(<DeliveryRail snapshot={snapshot} crossCheck={crossCheck()} />);
    expect(screen.queryByTestId("delivery-crosscheck-source-error")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("delivery-crosscheck-row")).toHaveLength(9);
  });

  it("shows nothing while the cross-check finds nothing, or has not been read", () => {
    const { rerender } = renderRail(crossCheck({ disagreements: [] }));
    expect(screen.queryByTestId("delivery-crosscheck")).not.toBeInTheDocument();
    const snapshot = foldDelivery({ record: fourUnitRecord(), events: [] });
    rerender(<DeliveryRail snapshot={snapshot} />);
    expect(screen.queryByTestId("delivery-crosscheck")).not.toBeInTheDocument();
  });
});
