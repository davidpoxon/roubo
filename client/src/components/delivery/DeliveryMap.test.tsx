// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench } from "@roubo/shared";
import { createDeliveryReducer, foldDelivery } from "@roubo/shared/delivery-reducer";
import { makeQueryClient, renderWithProviders } from "../../test/renderWithProviders";
import { cycleRecord, fourUnitRecord, unitChanged } from "../../test/delivery-fixtures";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    resumeDelivery: vi.fn(),
    launchDelivery: vi.fn(),
    fetchTerminals: vi.fn(),
    fetchDeliveryEvents: vi.fn(),
    fetchDeliveryUnitDiff: vi.fn(),
    fetchDeliveryUnitTranscript: vi.fn(),
  };
});
import * as api from "../../lib/api";
import { useNotificationStream } from "../../hooks/useNotificationStream";
import DeliveryTabPanel from "./DeliveryTabPanel";

const bench = {
  id: 3,
  projectId: "demo",
  variant: "specbench",
  status: "active",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "launch",
} as unknown as Bench;

// A stand-in for the notification stream, so a test can post the delivery
// frame that the server sends when it accepts an event.
interface FakeSource {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  readyState: number;
  close: () => void;
}
let source: FakeSource;
const FakeEventSource = vi.fn(function FakeEventSourceCtor() {
  source = { onmessage: null, onerror: null, onopen: null, readyState: 1, close: vi.fn() };
  return source;
});

function postFrame(seq: number) {
  source.onmessage?.({
    data: JSON.stringify({
      type: "delivery",
      projectId: "demo",
      benchId: 3,
      change: "snapshot",
      seq,
    }),
  } as MessageEvent);
}

function Harness() {
  useNotificationStream();
  return <DeliveryTabPanel bench={bench} />;
}

function nodeIds(): string[] {
  return screen.getAllByTestId(/^unit-node-/).map((node) => node.dataset.testid?.slice(10) ?? "");
}

function rowIds(): string[] {
  return screen.getAllByTestId(/^unit-row-/).map((row) => row.dataset.testid?.slice(9) ?? "");
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(api.fetchDelivery).mockReset();
  vi.mocked(api.resumeDelivery).mockReset();
  vi.mocked(api.fetchTerminals).mockReset();
  vi.mocked(api.fetchTerminals).mockResolvedValue([]);
  // A unit's drill-in reads its events, diff and transcript.
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
  vi.unstubAllGlobals();
});

describe("Delivery map", () => {
  it("SB-TC-020 shows units, edges, stack layers, gate state and unit status, and moves A to done within 2 seconds of the event", async () => {
    const record = fourUnitRecord();
    vi.mocked(api.fetchDelivery).mockResolvedValue(foldDelivery({ record, events: [] }));
    renderWithProviders(<Harness />);

    // Step 1: the Delivery tab in graph view.
    const graph = await screen.findByTestId("delivery-graph");
    expect(nodeIds().sort()).toEqual(["A", "B", "C", "D"]);

    const dependencyEdges = graph.querySelectorAll('[data-edge-kind="depends_on"]');
    expect(
      [...dependencyEdges].map(
        (edge) => `${edge.getAttribute("data-edge-from")}>${edge.getAttribute("data-edge-to")}`,
      ),
    ).toEqual(["unit:A>unit:B", "unit:B>unit:C"]);

    for (const [id, layer] of [
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ] as const) {
      expect(screen.getByTestId(`unit-node-${id}`)).toHaveTextContent(`stack A · layer ${layer}`);
    }
    expect(screen.getByTestId("unit-node-D")).toHaveTextContent("stack D · layer 0");

    const markers = screen.getAllByTestId(/^gate-marker-/);
    expect(markers).toHaveLength(2);
    for (const [gateId, unitId] of [
      ["gate-after-b", "B"],
      ["gate-after-c", "C"],
    ]) {
      const marker = screen.getByTestId(`gate-marker-${gateId}`);
      const unit = screen.getByTestId(`unit-node-${unitId}`);
      // After the unit in reading order and on the canvas, in the unit's lane.
      expect(unit.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(parseFloat(marker.style.left)).toBeGreaterThan(parseFloat(unit.style.left));
      expect(parseFloat(marker.style.top)).toBeGreaterThanOrEqual(parseFloat(unit.style.top));
    }
    expect(screen.getByTestId("gate-marker-gate-after-b")).toHaveTextContent("pending");
    expect(screen.getByTestId("gate-marker-gate-after-c")).toHaveTextContent("passed");

    expect(screen.getByTestId("unit-node-A")).toHaveTextContent("running");
    expect(screen.getByTestId("unit-node-B")).toHaveTextContent("pending");
    expect(screen.getByTestId("unit-node-C")).toHaveTextContent("pending");
    expect(screen.getByTestId("unit-node-D")).toHaveTextContent("done");

    // Step 2: the tooling posts the unit's done event; the server folds it and
    // sends a frame at the new seq.
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      foldDelivery({ record, events: [unitChanged(8, "A", "done")] }),
    );
    const posted = performance.now();
    act(() => postFrame(8));
    await waitFor(
      () => expect(screen.getByTestId("unit-node-A")).toHaveAttribute("data-status", "done"),
      { timeout: 2_000 },
    );
    expect(performance.now() - posted).toBeLessThan(2_000);
    expect(screen.getByTestId("unit-node-A")).toHaveTextContent("done");
  });

  it("SB-TC-021 shows the same units in the list, toggles back to the graph with the selection kept, and restores the last view on reload", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      foldDelivery({ record: fourUnitRecord(), events: [] }),
    );
    const first = renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await screen.findByTestId("delivery-graph");
    await userEvent.click(screen.getByTestId("unit-node-B"));
    expect(screen.getByTestId("unit-node-B")).toHaveAttribute("aria-current", "true");

    // Step 1: the list toggle.
    await userEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByTestId("delivery-graph")).not.toBeInTheDocument();
    expect(rowIds()).toEqual(["A", "B", "C", "D"]);
    const row = (id: string) => screen.getByTestId(`unit-row-${id}`);
    const cell = (id: string, col: string) =>
      row(id).querySelector(`[data-col="${col}"]`)?.textContent ?? "";
    expect([cell("A", "stack"), cell("A", "layer"), cell("A", "status")]).toEqual([
      "A",
      "0",
      "running",
    ]);
    expect([cell("B", "stack"), cell("B", "layer"), cell("B", "gate")]).toEqual([
      "A",
      "1",
      "gate-after-b · pending",
    ]);
    expect([cell("C", "layer"), cell("C", "gate")]).toEqual(["2", "gate-after-c · passed"]);
    expect([
      cell("D", "stack"),
      cell("D", "layer"),
      cell("D", "status"),
      cell("D", "gate"),
    ]).toEqual(["D", "0", "done", "no gate"]);
    expect(row("B")).toHaveAttribute("aria-current", "true");

    // Step 2: the graph toggle.
    await userEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByTestId("delivery-graph")).toBeInTheDocument();
    expect(screen.getByTestId("unit-node-B")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("unit-node-A")).not.toHaveAttribute("aria-current");

    // Step 3: choose the list again, then reload.
    await userEvent.click(screen.getByRole("button", { name: "List" }));
    first.unmount();
    renderWithProviders(<DeliveryTabPanel bench={bench} />, { queryClient: makeQueryClient() });
    expect(await screen.findByTestId("delivery-list")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("delivery-graph")).not.toBeInTheDocument();
  });

  it("SB-TC-028 names the dependency cycle on the map while the rest of the bench stays interactive", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      foldDelivery({ record: cycleRecord(), events: [] }),
    );
    vi.mocked(api.resumeDelivery).mockResolvedValue({ resume: "demo-delivery-1" });
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    const error = await screen.findByTestId("delivery-map-cycle");
    expect(error).toHaveAttribute("role", "alert");
    expect(error).toHaveTextContent("cycle");
    expect(error).toHaveTextContent("A depends on C, C depends on A.");
    expect(screen.queryByTestId("delivery-graph")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delivery-list")).not.toBeInTheDocument();

    // The rest of the tab still answers.
    expect(screen.getByTestId("delivery-lifecycle")).toHaveTextContent("running");
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.resumeDelivery).toHaveBeenCalledWith("demo", 3));
  });

  it("draws the map again once the cycle is fixed", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      foldDelivery({ record: cycleRecord(), events: [] }),
    );
    const queryClient = makeQueryClient();
    renderWithProviders(<DeliveryTabPanel bench={bench} />, { queryClient });
    await screen.findByTestId("delivery-map-cycle");

    vi.mocked(api.fetchDelivery).mockResolvedValue(
      foldDelivery({ record: fourUnitRecord(), events: [] }),
    );
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(screen.getByTestId("delivery-graph")).toBeInTheDocument());
    expect(screen.queryByTestId("delivery-map-cycle")).not.toBeInTheDocument();
  });

  it("opens the drill-in of a gate and closes it", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      foldDelivery({ record: fourUnitRecord(), events: [] }),
    );
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await userEvent.click(await screen.findByTestId("gate-marker-gate-after-c"));

    const drillIn = screen.getByRole("region", { name: "Gate gate-after-c" });
    expect(within(drillIn).getByText("FX-TC-002")).toBeInTheDocument();
    expect(within(drillIn).getByText("passed")).toBeInTheDocument();
    await userEvent.click(within(drillIn).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("delivery-drill-in")).not.toBeInTheDocument();
  });

  it("opens the drill-in of a unit from its list row", async () => {
    localStorage.setItem(
      "roubo-bench-view-state",
      JSON.stringify({ "demo:3": { deliveryMapView: "list" } }),
    );
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      foldDelivery({ record: fourUnitRecord(), events: [] }),
    );
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    await userEvent.click(await screen.findByTestId("unit-row-C"));

    const drillIn = screen.getByRole("region", { name: "Unit C" });
    expect(drillIn).toHaveTextContent("after B");
    expect(drillIn).toHaveTextContent("gate-after-c passed");
    expect(drillIn).toHaveTextContent("A, layer 2");
  });

  it("highlights the edges of the node under focus in the accent", async () => {
    const reducer = createDeliveryReducer();
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      reducer.fold({ record: fourUnitRecord(), events: [] }),
    );
    renderWithProviders(<DeliveryTabPanel bench={bench} />);
    const graph = await screen.findByTestId("delivery-graph");
    const edge = (from: string, to: string) =>
      graph.querySelector(`[data-edge-from="${from}"][data-edge-to="${to}"]`);
    expect(edge("unit:A", "unit:B")).toHaveClass("stroke-border-strong");

    act(() => screen.getByTestId("unit-node-B").focus());
    expect(edge("unit:A", "unit:B")).toHaveClass("stroke-accent");
    expect(edge("unit:B", "unit:C")).toHaveClass("stroke-accent");
    expect(edge("gate:gate-after-c", "unit:C")).toHaveClass("stroke-status-error");
  });
});
