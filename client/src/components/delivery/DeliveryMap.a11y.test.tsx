// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";

// A unit's drill-in reads its events, diff and transcript.
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchDeliveryEvents: vi.fn(),
    fetchDeliveryUnitDiff: vi.fn(),
    fetchDeliveryUnitTranscript: vi.fn(),
  };
});
import * as api from "../../lib/api";
import DeliveryMap from "./DeliveryMap";

function snapshot() {
  return foldDelivery({ record: fourUnitRecord(), events: [] });
}

const FOCUS_RING = ["focus-visible:ring-2", "focus-visible:ring-focus-ring"];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot());
  vi.mocked(api.fetchDeliveryEvents).mockResolvedValue({ events: [], acceptedSeq: 7 });
  vi.mocked(api.fetchDeliveryUnitDiff).mockImplementation(async (_p, _b, unit) => ({
    unit,
    base: null,
    head: null,
    diff: "",
    truncated: false,
  }));
  vi.mocked(api.fetchDeliveryUnitTranscript).mockImplementation(async (_p, _b, unit) => ({
    unit,
    sessionId: null,
    from: null,
    to: null,
    lines: [],
  }));
});

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("Delivery map accessibility", () => {
  it("SB-TC-025 is fully operable by keyboard and screen reader in both views", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <DeliveryMap projectId="demo" benchId={3} snapshot={snapshot()} />,
    );

    // Step 1: Tab through the graph view. The view toggle comes first, then
    // every node and gate marker in dependency order.
    await user.tab();
    expect(screen.getByRole("button", { name: "Graph" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "List" })).toHaveFocus();
    const expected = [
      "unit-node-A",
      "unit-node-B",
      "gate-marker-gate-after-b",
      "unit-node-C",
      "gate-marker-gate-after-c",
      "unit-node-D",
    ];
    for (const testId of expected) {
      await user.tab();
      const focused = screen.getByTestId(testId);
      expect(focused).toHaveFocus();
      for (const ring of FOCUS_RING) expect(focused.className).toContain(ring);
    }

    // Step 2: Enter on a node opens its drill-in.
    screen.getByTestId("unit-node-B").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "Unit B" })).toBeInTheDocument();

    // Step 3: every node is named with its id, status and layer, and axe finds
    // nothing in either view.
    for (const [id, status, layer] of [
      ["A", "running", 0],
      ["B", "pending", 1],
      ["C", "pending", 2],
      ["D", "done", 0],
    ] as const) {
      const name = screen.getByTestId(`unit-node-${id}`).getAttribute("aria-label") ?? "";
      expect(name).toContain(id);
      expect(name).toContain(status);
      expect(name).toContain(`layer ${layer}`);
    }
    expect(screen.getByRole("button", { name: /^Gate gate-after-b, pending/ })).toBeInTheDocument();
    expectNoAxeFindings(await axe(container));

    await user.click(screen.getByRole("button", { name: "List" }));
    for (const id of ["A", "B", "C", "D"]) {
      const row = screen.getByTestId(`unit-row-${id}`);
      for (const ring of FOCUS_RING) expect(row.className).toContain(ring);
    }
    screen.getByTestId("unit-row-C").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "Unit C" })).toBeInTheDocument();
    expectNoAxeFindings(await axe(container));
  });

  for (const theme of THEMES) {
    for (const view of ["graph", "list"] as const) {
      it(`has no axe findings in the ${view} view in ${theme}`, async () => {
        localStorage.setItem(
          "roubo-bench-view-state",
          JSON.stringify({ "demo:3": { deliveryMapView: view } }),
        );
        const { container } = renderInTheme(
          <DeliveryMap projectId="demo" benchId={3} snapshot={snapshot()} />,
          theme,
        );
        expect(
          screen.getByTestId(view === "graph" ? "delivery-graph" : "delivery-list"),
        ).toBeInTheDocument();
        expectNoAxeFindings(await axe(container));
      });
    }
  }
});
