// @vitest-environment jsdom
// A unit's drill-in on the Delivery tab (SB-FR-013, SB-NFR-003, SB-NFR-004,
// SB-US-004): the timeline first with the terminal beside it and the Diff and
// Verify panels beneath, seams marked on the timeline, a done unit's transcript
// replayed read-only, the 1,000-event bound, keyboard and screen-reader
// operation, and the empty states of a unit with no events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { Bench } from "@roubo/shared";
import type { DeliveryEvent, DeliveryRecord } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import type { CaseResult } from "@roubo/shared/testbench-contracts";
import { expectNoAxeFindings } from "../../test/axe";
import { renderWithProviders } from "../../test/renderWithProviders";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchDeliveryEvents: vi.fn(),
    fetchDeliveryUnitDiff: vi.fn(),
    fetchDeliveryUnitTranscript: vi.fn(),
    fetchTerminals: vi.fn(),
    resumeDelivery: vi.fn(),
    launchDelivery: vi.fn(),
  };
});

// The live terminal is xterm over a socket; a stand-in keeps its one input, the
// textarea xterm reads keys from, so the keyboard path can be driven.
vi.mock("../Terminal", () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <textarea aria-label={`Live delivery terminal ${sessionId}`} data-testid="live-terminal" />
  ),
}));

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
  deliverySessionId: "session-1",
} as unknown as Bench;

// The bench's accepted events, and the record they fold over: what the fake
// delivery tooling has posted so far.
let record: DeliveryRecord;
let log: DeliveryEvent[];
let decorate: (snapshot: DeliverySnapshot) => DeliverySnapshot;

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

// The tooling posts events; the server accepts them and sends the frame.
function post(...events: DeliveryEvent[]) {
  log.push(...events);
  act(() =>
    source.onmessage?.({
      data: JSON.stringify({
        type: "delivery",
        projectId: "demo",
        benchId: 3,
        change: "snapshot",
        seq: log.at(-1)?.seq ?? 7,
      }),
    } as MessageEvent),
  );
}

function Harness() {
  useNotificationStream();
  return <DeliveryTabPanel bench={bench} />;
}

function withStatus(base: DeliveryRecord, statuses: Record<string, string>): DeliveryRecord {
  return {
    ...base,
    units: base.units.map((unit) =>
      Object.hasOwn(statuses, unit.id) ? { ...unit, status: statuses[unit.id] } : unit,
    ),
  };
}

const at = (minute: number, second = 0) =>
  `2026-10-16T09:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;

async function openUnit(id: string) {
  await userEvent.click(await screen.findByTestId(`unit-node-${id}`));
  return screen.getByRole("region", { name: `Unit ${id}` });
}

function timelineOrder(): string[] {
  const list = screen.getByTestId("unit-timeline-list");
  return [...list.children].map((row) =>
    row.getAttribute("data-testid") === "timeline-seam"
      ? `seam:${row.textContent?.replace("Generation seam: ", "").split(" · ")[0]}`
      : `event:${row.getAttribute("data-seq")}`,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", FakeEventSource);
  record = fourUnitRecord();
  log = [];
  decorate = (snapshot) => snapshot;
  vi.mocked(api.fetchDelivery).mockReset();
  vi.mocked(api.fetchDelivery).mockImplementation(async () =>
    decorate(foldDelivery({ record, events: [...log] })),
  );
  vi.mocked(api.fetchDeliveryEvents).mockReset();
  vi.mocked(api.fetchDeliveryEvents).mockImplementation(async (_p, _b, query = {}) => ({
    events: log.filter(
      (event) =>
        (query.unit === undefined || event.unit_id === query.unit) &&
        (query.after === undefined || event.seq > query.after),
    ),
    acceptedSeq: log.at(-1)?.seq ?? record.last_event_seq,
  }));
  vi.mocked(api.fetchDeliveryUnitDiff).mockReset();
  vi.mocked(api.fetchDeliveryUnitDiff).mockImplementation(async (_p, _b, unit) => ({
    unit,
    base: null,
    head: null,
    diff: "",
    truncated: false,
  }));
  vi.mocked(api.fetchDeliveryUnitTranscript).mockReset();
  vi.mocked(api.fetchDeliveryUnitTranscript).mockImplementation(async (_p, _b, unit) => ({
    unit,
    sessionId: "session-1",
    from: null,
    to: null,
    lines: [],
  }));
  vi.mocked(api.fetchTerminals).mockReset();
  vi.mocked(api.fetchTerminals).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Unit drill-in", () => {
  it("SB-TC-029 shows the timeline first with the terminal beside it and the diff and verify beneath", async () => {
    record = withStatus(fourUnitRecord(), { B: "running" });
    log = [
      unitEvent(8, "B", "unit.changed", { status: "running" }, at(40)),
      unitEvent(9, "A", "unit.changed", { status: "done" }, at(41)),
      unitEvent(10, "B", "pull_request.opened", { text: "Draft opened on stack A" }, at(42)),
    ];
    const passed = { observationMarks: {}, derivedStatus: "passed", notes: [] } as CaseResult;
    decorate = (snapshot) => ({
      ...snapshot,
      progress: {
        ...snapshot.progress,
        caseList: [{ id: "FX-TC-001", met: true, result: passed, metBy: "B", prUrl: null }],
      },
    });
    vi.mocked(api.fetchDeliveryUnitDiff).mockResolvedValue({
      unit: "B",
      base: "0a1b2c3d4e5f",
      head: "1b2c3d4e5f60",
      diff: "diff --git a/b.txt b/b.txt\n+the second layer\n",
      truncated: false,
    });
    renderWithProviders(<Harness />);

    // Step 1: open B from the map.
    const drillIn = await openUnit("B");
    const timeline = within(drillIn).getByRole("region", { name: "Timeline of unit B" });
    const terminal = within(drillIn).getByRole("region", { name: "Terminal of unit B" });
    const diff = within(drillIn).getByRole("region", { name: "Diff of unit B" });
    const verify = within(drillIn).getByRole("region", { name: "Verify results of unit B" });
    expect(within(drillIn).getAllByRole("region")[0]).toBe(timeline);
    const top = drillIn.querySelector('[data-drill-in-row="top"]');
    const bottom = drillIn.querySelector('[data-drill-in-row="bottom"]');
    expect([...(top?.children ?? [])]).toEqual([timeline, terminal]);
    expect([...(bottom?.children ?? [])]).toEqual([diff, verify]);
    expect(top?.compareDocumentPosition(bottom as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // Step 2: the timeline reads GET /delivery/events?unit=B and shows only B's
    // events, the newest first.
    await waitFor(() => expect(timelineOrder()).toEqual(["event:10", "event:8"]));
    expect(api.fetchDeliveryEvents).toHaveBeenCalledWith("demo", 3, { unit: "B" });
    expect(timeline).toHaveTextContent("Draft opened on stack A");
    expect(timeline).toHaveTextContent("Status running");
    expect(within(timeline).queryByTestId("timeline-event-9")).not.toBeInTheDocument();

    // Step 3: the Diff panel shows the pull-request diff of B's layer.
    expect(await within(diff).findByTestId("unit-diff-text")).toHaveTextContent(
      "+the second layer",
    );
    expect(api.fetchDeliveryUnitDiff).toHaveBeenCalledWith("demo", 3, "B");

    // Step 4: the Verify panel shows the result of the case B implements.
    expect(within(verify).getByTestId("unit-verify-FX-TC-001")).toHaveTextContent(
      "FX-TC-001gate-after-bpassed",
    );
  });

  it("SB-TC-030 marks the record's seams of the unit and a posted seam event on the timeline", async () => {
    record = {
      ...withStatus(fourUnitRecord(), { B: "running" }),
      seams: {
        "session-b-1": { status: "ok", last_run_at: at(39), unit_id: "B" },
        "compaction-b": { status: "ok", last_run_at: at(42), unit_id: "B" },
        plan: { status: "ok", last_run_at: at(38) },
      },
    };
    log = [
      unitEvent(8, "B", "unit.changed", { status: "running" }, at(40)),
      unitEvent(9, "B", "note", { text: "Turn 12" }, at(43)),
    ];
    renderWithProviders(<Harness />);

    // Step 1: two seams inside B, each a marker among B's events.
    await openUnit("B");
    await waitFor(() =>
      expect(timelineOrder()).toEqual([
        "event:9",
        "seam:compaction-b",
        "event:8",
        "seam:session-b-1",
      ]),
    );
    expect(screen.getAllByTestId("timeline-seam")).toHaveLength(2);

    // Step 2: the tooling posts a seam event for B; a third marker appears
    // within 2 seconds.
    const posted = performance.now();
    post(unitEvent(10, "B", "seam.ran", { seam: "session-b-2", status: "ok" }, at(44)));
    await waitFor(() => expect(screen.getAllByTestId("timeline-seam")).toHaveLength(3), {
      timeout: 2_000,
    });
    expect(performance.now() - posted).toBeLessThan(2_000);
    expect(timelineOrder()[0]).toBe("seam:session-b-2");
    expect(screen.getAllByTestId("timeline-seam")[0]).toHaveTextContent(
      "Generation seam: session-b-2 · ok · 09:44:00",
    );
  });

  it("SB-TC-031 replays a done unit's transcript read-only and shows an active unit's terminal live", async () => {
    record = withStatus(fourUnitRecord(), { A: "done", B: "running" });
    log = [
      unitEvent(8, "A", "unit.changed", { status: "running" }, at(40)),
      unitEvent(9, "A", "unit.changed", { status: "done" }, at(45)),
      unitEvent(10, "B", "unit.changed", { status: "running" }, at(46)),
    ];
    vi.mocked(api.fetchDeliveryUnitTranscript).mockResolvedValue({
      unit: "A",
      sessionId: "session-1",
      from: at(40),
      to: at(45),
      lines: ["\x1b[32mbuilt A\x1b[0m\r\n", "the suite passed\r\n"],
    });
    renderWithProviders(<Harness />);

    // Step 1: A is done, so its terminal replays the recorded transcript.
    const drillIn = await openUnit("A");
    const terminal = within(drillIn).getByRole("region", { name: "Terminal of unit A" });
    const transcript = await within(terminal).findByRole("region", {
      name: "Recorded transcript of unit A, read-only",
    });
    expect(transcript).toHaveTextContent("built A the suite passed");
    expect(transcript.textContent).not.toContain("\x1b");
    expect(api.fetchDeliveryUnitTranscript).toHaveBeenCalledWith("demo", 3, "A");
    expect(within(terminal).getByTestId("unit-transcript-label")).toHaveTextContent(
      "Read-only: recorded transcript",
    );
    // No input is accepted: nothing in the panel takes text, and typing over the
    // transcript changes nothing.
    expect(within(terminal).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(terminal).queryByTestId("live-terminal")).not.toBeInTheDocument();
    await userEvent.type(transcript, "rm -rf");
    expect(transcript.textContent).toBe("built A\nthe suite passed\n");

    // Step 2: B is active, so its terminal is the live delivery session.
    await userEvent.click(within(drillIn).getByRole("button", { name: "Close" }));
    const active = await openUnit("B");
    const live = within(active).getByRole("region", { name: "Terminal of unit B" });
    expect(within(live).getByRole("textbox", { name: "Live delivery terminal session-1" }));
    expect(within(live).queryByTestId("unit-transcript-label")).not.toBeInTheDocument();
  });

  it("SB-TC-031 replays a done unit's transcript after the record carries all its events", async () => {
    // The session wrote the record past A's two events, so no event of A sits
    // above it: the server counts them as folded.
    record = { ...withStatus(fourUnitRecord(), { A: "done" }), last_event_seq: 9 };
    vi.mocked(api.fetchDeliveryEvents).mockImplementation(async (_p, _b, query = {}) => ({
      events: [],
      acceptedSeq: 9,
      ...(query.unit !== undefined && { folded: query.unit === "A" ? 2 : 0 }),
    }));
    vi.mocked(api.fetchDeliveryUnitTranscript).mockResolvedValue({
      unit: "A",
      sessionId: "session-1",
      from: at(40),
      to: at(45),
      lines: ["built A\r\n"],
    });
    renderWithProviders(<Harness />);

    const drillIn = await openUnit("A");
    const empty = await within(drillIn).findByTestId("unit-timeline-empty");
    expect(empty).toHaveTextContent(
      "No newer events for unit A: the delivery record holds its 2 events.",
    );
    expect(empty).toHaveAttribute("data-folded", "true");
    const terminal = within(drillIn).getByRole("region", { name: "Terminal of unit A" });
    expect(
      await within(terminal).findByRole("region", {
        name: "Recorded transcript of unit A, read-only",
      }),
    ).toHaveTextContent("built A");
    expect(within(terminal).getByTestId("unit-transcript-label")).toBeInTheDocument();
  });

  it("SB-TC-032 shows a posted event within 2 seconds and keeps the most recent 1,000 of a burst responsive", async () => {
    record = withStatus(fourUnitRecord(), { B: "running" });
    log = [unitEvent(8, "B", "unit.changed", { status: "running" }, at(40))];
    renderWithProviders(<Harness />);
    await openUnit("B");
    await waitFor(() => expect(timelineOrder()).toEqual(["event:8"]));

    // Step 1: one event for B reaches the timeline within 2 seconds.
    const posted = performance.now();
    post(unitEvent(9, "B", "note", { text: "Opened the worktree" }, at(41)));
    await waitFor(() => expect(screen.getByTestId("timeline-event-9")).toBeInTheDocument(), {
      timeout: 2_000,
    });
    expect(performance.now() - posted).toBeLessThan(2_000);

    // Step 2: 1,000 more events in one minute, posted in ten batches.
    for (let batch = 0; batch < 10; batch += 1) {
      const events = Array.from({ length: 100 }, (_, index) => {
        const seq = 10 + batch * 100 + index;
        return unitEvent(seq, "B", "note", { text: `Turn ${seq}` }, at(42 + batch, index % 60));
      });
      post(...events);
      const last = events.at(-1)?.seq ?? 0;
      await waitFor(() => expect(screen.getByTestId(`timeline-event-${last}`)).toBeInTheDocument());
    }
    // The log holds the most recent 1,000: seqs 10 to 1009, the first two gone.
    const rows = screen.getByTestId("unit-timeline-list").children;
    expect(rows).toHaveLength(1_000);
    expect(rows[0]).toHaveAttribute("data-seq", "1009");
    expect(rows[999]).toHaveAttribute("data-seq", "10");
    expect(screen.queryByTestId("timeline-event-9")).not.toBeInTheDocument();
    // The timeline keeps scrolling inside its own box.
    expect(screen.getByTestId("unit-timeline-list").className).toContain("overflow-y-auto");

    // Input on the page responds within 100 ms: the shortcut that leaves the
    // terminal moves the focus to the Diff panel.
    const input = screen.getByTestId("live-terminal");
    input.focus();
    const pressed = performance.now();
    fireEvent.keyDown(input, { key: "F6" });
    expect(screen.getByRole("region", { name: "Diff of unit B" })).toHaveFocus();
    expect(performance.now() - pressed).toBeLessThan(100);
  }, 60_000);

  it("SB-TC-033 reaches every panel by keyboard with its name, leaves the terminal by shortcut and has no axe findings", async () => {
    const user = userEvent.setup();
    record = withStatus(fourUnitRecord(), { B: "running" });
    log = [unitEvent(8, "B", "unit.changed", { status: "running" }, at(40))];
    const { container } = renderWithProviders(<Harness />);
    const drillIn = await openUnit("B");
    await waitFor(() => expect(timelineOrder()).toEqual(["event:8"]));

    // Step 1: Tab from the timeline to the terminal, the diff and the verify
    // panels; each announces its name.
    within(drillIn).getByRole("button", { name: "Close" }).focus();
    await user.tab();
    expect(screen.getByRole("region", { name: "Timeline of unit B" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("list", { name: "Events of unit B, newest first" })).toHaveFocus();
    await user.tab();
    const terminal = screen.getByRole("region", { name: "Terminal of unit B" });
    expect(terminal).toHaveFocus();
    expect(terminal).toHaveAccessibleDescription(/Press F6 to leave the terminal/);
    await user.tab();
    expect(screen.getByTestId("live-terminal")).toHaveFocus();
    // The terminal keeps Tab for itself, so F6 is the way out.
    await user.keyboard("{F6}");
    expect(screen.getByRole("region", { name: "Diff of unit B" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("region", { name: "Verify results of unit B" })).toHaveFocus();
    // Shift+F6 from inside the terminal goes back to the timeline.
    screen.getByTestId("live-terminal").focus();
    await user.keyboard("{Shift>}{F6}{/Shift}");
    expect(screen.getByRole("region", { name: "Timeline of unit B" })).toHaveFocus();

    // Step 2: the accessibility suite over the drill-in.
    expectNoAxeFindings(await axe(container));
  });

  it("SB-TC-035 shows an empty state naming the unit in all four panels for a unit with no events", async () => {
    log = [unitEvent(8, "B", "unit.changed", { status: "running" }, at(40))];
    renderWithProviders(<Harness />);

    // Step 1: open D before any event names it.
    const drillIn = await openUnit("D");
    expect(await within(drillIn).findByTestId("unit-timeline-empty")).toHaveTextContent(
      "No events for unit D yet.",
    );
    expect(await within(drillIn).findByTestId("unit-terminal-empty")).toHaveTextContent(
      "No transcript recorded for unit D.",
    );
    expect(await within(drillIn).findByTestId("unit-diff-empty")).toHaveTextContent(
      "No diff for unit D yet: it has no commit.",
    );
    expect(within(drillIn).getByTestId("unit-verify-empty")).toHaveTextContent(
      "No verify results for unit D: no gate after it names a case.",
    );
    expect(within(drillIn).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names a pending unit's terminal as waiting for output", async () => {
    renderWithProviders(<Harness />);
    const drillIn = await openUnit("C");
    expect(await within(drillIn).findByTestId("unit-terminal-empty")).toHaveTextContent(
      "No terminal output for unit C yet.",
    );
  });
});
