// @vitest-environment jsdom
// A unit's drill-in on the Delivery tab (SB-FR-013, SB-NFR-003, SB-NFR-004,
// SB-US-004): the timeline first, with the Diff and Verify tabs beside it and
// no terminal (#1659), seams marked on the timeline, the events the record
// already carries, the 1,000-event bound, keyboard and screen-reader
// operation, and the empty states of a unit with no events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { Bench } from "@roubo/shared";
import {
  GATE_PROVISIONAL_STATUS,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { deriveDeliveryTimeSplit } from "@roubo/shared/delivery-time-split";
import type { CaseResult } from "@roubo/shared/testbench-contracts";
import { expectNoAxeFindings } from "../../test/axe";
import { renderWithProviders } from "../../test/renderWithProviders";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";
import { HELD_DRAFT_LABEL } from "./delivery-map-model";
import { timelineTime } from "./delivery-timeline-model";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchDeliveryEvents: vi.fn(),
    fetchDeliveryUnitDiff: vi.fn(),
    fetchDeliveryTime: vi.fn(),
    fetchTerminals: vi.fn(),
    resumeDelivery: vi.fn(),
    launchDelivery: vi.fn(),
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

function Harness({ of = bench }: { of?: Bench }) {
  useNotificationStream();
  return <DeliveryTabPanel bench={of} />;
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
  vi.mocked(api.fetchDeliveryTime).mockReset();
  vi.mocked(api.fetchDeliveryTime).mockImplementation(async () =>
    deriveDeliveryTimeSplit({ record, events: [...log], now: Date.parse("2026-10-16T10:00:00Z") }),
  );
  vi.mocked(api.fetchTerminals).mockReset();
  vi.mocked(api.fetchTerminals).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Unit drill-in", () => {
  it("SB-TC-029 shows the timeline first, with the Diff and Verify tabs beside it and no terminal", async () => {
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
        caseList: [
          {
            id: "FX-TC-001",
            title: "FX-TC-001",
            met: true,
            result: passed,
            metBy: "B",
            prUrl: null,
          },
        ],
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

    // Step 1: open B from the map. The timeline comes first, and the panel of
    // the Diff and Verify tabs sits beside it (#1621). The drill-in holds no
    // terminal: the delivery runs in the bench's Terminal tab (#1659).
    const drillIn = await openUnit("B");
    const timeline = within(drillIn).getByRole("region", { name: "Timeline of unit B" });
    const diff = within(drillIn).getByRole("region", { name: "Diff of unit B" });
    expect(within(drillIn).getAllByRole("region")[0]).toBe(timeline);
    const tabs = within(drillIn).getByTestId("unit-diff-verify");
    expect([...(timeline.parentElement?.children ?? [])]).toEqual([timeline, tabs]);
    expect(within(drillIn).queryByRole("region", { name: /Terminal/ })).not.toBeInTheDocument();
    expect(within(drillIn).queryByRole("textbox")).not.toBeInTheDocument();
    // Diff is the selected tab, and Verify waits behind it.
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Diff", "Verify"]);
    expect(within(tabs).getByRole("tab", { name: "Diff" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(diff).toBeVisible();
    expect(within(drillIn).getByTestId("unit-verify")).not.toBeVisible();

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

    // Step 4: the Verify tab shows the result of the case B implements.
    await userEvent.click(within(tabs).getByRole("tab", { name: "Verify" }));
    const verify = within(drillIn).getByRole("region", { name: "Verify results of unit B" });
    expect(verify).toBeVisible();
    expect(diff).not.toBeVisible();
    expect(within(verify).getByTestId("unit-verify-gate-after-b")).toHaveTextContent(
      "gate-after-b",
    );
    expect(within(verify).getByTestId("unit-verify-FX-TC-001")).toHaveTextContent("FX-TC-001");
  });

  it("heads the drill-in with the unit's id, title and chips for what the record holds of it (#1621)", async () => {
    const base = withStatus(fourUnitRecord(), { B: "running" });
    record = {
      ...base,
      units: base.units.map((unit) =>
        unit.id === "B"
          ? {
              ...unit,
              depends_on: ["A", "D"],
              pr_url: "https://github.com/demo/demo/pull/47",
              cost_usd: 2.65,
            }
          : unit,
      ),
    };
    renderWithProviders(<Harness />);

    // B: on stack A over its base A, with a dependency beyond its base, a pull
    // request, the gate after it and a cost.
    const drillIn = await openUnit("B");
    const heading = within(drillIn).getByRole("heading", { level: 2, name: "B Second" });
    expect(heading).toHaveFocus();
    const chips = within(drillIn).getByRole("list", { name: "About unit B" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual([
      "running",
      "stack A · layer 1 · base A",
      "after A, D",
      "#47",
      "gate gate-after-b · pending",
      "USD 2.65",
    ]);

    // D: the first unit of its stack, with no dependency, no pull request, no
    // gate and no cost, takes only the status and stack chips.
    await userEvent.click(within(drillIn).getByRole("button", { name: "Close" }));
    const own = await openUnit("D");
    const ownChips = within(own).getByRole("list", { name: "About unit D" });
    expect(
      within(ownChips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["done", "stack D · layer 0"]);
  });

  it("names a layered unit's empty dependencies beside its base, since its base is not one of them (#1635)", async () => {
    record = {
      ...fourUnitRecord(),
      units: fourUnitRecord().units.map((unit) =>
        unit.id === "C" ? { ...unit, depends_on: [] } : unit,
      ),
    };
    renderWithProviders(<Harness />);

    // C sits on stack A over its base B, but depends on nothing: the
    // dependency chip says so, apart from the stack chip's base.
    const drillIn = await openUnit("C");
    const chips = within(drillIn).getByRole("list", { name: "About unit C" });
    expect(within(chips).getByTestId("unit-chip-stack")).toHaveTextContent(
      "stack A · layer 2 · base B",
    );
    expect(within(chips).getByTestId("unit-chip-dependencies")).toHaveTextContent(
      "no dependencies",
    );
  });

  it("names a held unit's pull request as a held draft, not its number (#1621)", async () => {
    const base = withStatus(fourUnitRecord(), { B: "done", C: "running" });
    record = {
      ...base,
      units: base.units.map((unit) =>
        unit.id === "C" ? { ...unit, pr_url: "https://github.com/demo/demo/pull/48" } : unit,
      ),
      stack: {
        ...base.stack,
        gates: base.stack.gates.map((gate) =>
          gate.id === "gate-after-b" ? { ...gate, status: GATE_PROVISIONAL_STATUS } : gate,
        ),
      },
    };
    renderWithProviders(<Harness />);

    // A provisional gate after B holds C, the layer above it.
    const drillIn = await openUnit("C");
    expect(within(drillIn).getByTestId("unit-chip-pr")).toHaveTextContent(HELD_DRAFT_LABEL);
    expect(within(drillIn).getByTestId("unit-chip-pr")).not.toHaveTextContent("#48");
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
      `Generation seam: session-b-2 · ok · ${timelineTime(at(44))}`,
    );
  });

  it("SB-TC-031 shows a done unit's events on its timeline, the ones the record carries included, and no terminal", async () => {
    // The record already carries A's two events: the server reads them from
    // the delivery outbox and answers them with the count it folded (#1659).
    record = { ...withStatus(fourUnitRecord(), { A: "done", B: "running" }), last_event_seq: 9 };
    const carried = [
      unitEvent(8, "A", "unit.changed", { status: "running" }, at(40)),
      unitEvent(9, "A", "unit.changed", { status: "done" }, at(45)),
    ];
    vi.mocked(api.fetchDeliveryEvents).mockImplementation(async (_p, _b, query = {}) => ({
      events: query.unit === "A" ? carried : [],
      acceptedSeq: 9,
      ...(query.unit !== undefined && { folded: query.unit === "A" ? 2 : 0 }),
    }));
    renderWithProviders(<Harness />);

    const drillIn = await openUnit("A");
    await waitFor(() => expect(timelineOrder()).toEqual(["event:9", "event:8"]));
    expect(within(drillIn).queryByTestId("unit-timeline-empty")).not.toBeInTheDocument();
    // A row is a plain row of the list: nothing on it takes a press.
    expect(within(screen.getByTestId("timeline-event-9")).queryByRole("button")).toBeNull();
    // No terminal and no transcript: nothing in the drill-in takes text.
    expect(within(drillIn).queryByRole("region", { name: /Terminal|transcript/ })).toBeNull();
    expect(within(drillIn).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("puts the day in front of the time of an event from an earlier day, the exact instant on hover", async () => {
    // Two days after the events: each row names its weekday, in local time.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(at(45)) + 2 * 86_400_000);
    try {
      log = [unitEvent(8, "A", "unit.changed", { status: "running" }, at(40, 7))];
      renderWithProviders(<Harness />);

      await openUnit("A");
      const time = await waitFor(() =>
        within(screen.getByTestId("timeline-event-8")).getByText(/\d{2}:\d{2}:\d{2}$/),
      );
      expect(time.tagName).toBe("TIME");
      expect(time).toHaveTextContent(/^[A-Z][a-z]{2} \d{2}:\d{2}:07$/);
      expect(time).toHaveTextContent(timelineTime(at(40, 7)));
      expect(time).toHaveAttribute("title", at(40, 7));
      expect(time).toHaveAttribute("datetime", at(40, 7));
    } finally {
      vi.useRealTimers();
    }
  });

  it("SB-TC-031 names the count the record holds when the outbox no longer has a done unit's events", async () => {
    // The session wrote the record past A's two events and the outbox holds
    // none of them: the server counts them as folded.
    record = { ...withStatus(fourUnitRecord(), { A: "done" }), last_event_seq: 9 };
    vi.mocked(api.fetchDeliveryEvents).mockImplementation(async (_p, _b, query = {}) => ({
      events: [],
      acceptedSeq: 9,
      ...(query.unit !== undefined && { folded: query.unit === "A" ? 2 : 0 }),
    }));
    renderWithProviders(<Harness />);

    const drillIn = await openUnit("A");
    const empty = await within(drillIn).findByTestId("unit-timeline-empty");
    expect(empty).toHaveTextContent(
      "No newer events for unit A: the delivery record holds its 2 events.",
    );
    expect(empty).toHaveAttribute("data-folded", "true");
  });

  it("#1659 appends the record-covered events a later read brings, once each", async () => {
    // The delivery posts no event: each read takes the unit's events from the
    // outbox, up to the seq the record carries.
    let recordSeq = 9;
    const outbox = [
      unitEvent(8, "A", "unit.changed", { status: "running" }, at(40)),
      unitEvent(9, "A", "note", { text: "Opened the worktree" }, at(41)),
      unitEvent(10, "A", "note", { text: "Ran the suite" }, at(42)),
      unitEvent(11, "A", "unit.changed", { status: "done" }, at(43)),
    ];
    record = { ...withStatus(fourUnitRecord(), { A: "running" }), last_event_seq: recordSeq };
    vi.mocked(api.fetchDeliveryEvents).mockImplementation(async (_p, _b, query = {}) => {
      const carried = outbox.filter(
        (event) =>
          event.seq <= recordSeq && (query.unit === undefined || event.unit_id === query.unit),
      );
      return {
        events: carried.filter((event) => query.after === undefined || event.seq > query.after),
        acceptedSeq: recordSeq,
        ...(query.unit !== undefined && { folded: carried.length }),
      };
    });
    renderWithProviders(<Harness />);
    await openUnit("A");
    await waitFor(() => expect(timelineOrder()).toEqual(["event:9", "event:8"]));

    // The session writes the record past two more events, and a frame says so.
    recordSeq = 11;
    record = { ...record, last_event_seq: recordSeq };
    act(() =>
      source.onmessage?.({
        data: JSON.stringify({
          type: "delivery",
          projectId: "demo",
          benchId: 3,
          change: "snapshot",
          seq: recordSeq,
        }),
      } as MessageEvent),
    );

    await waitFor(() =>
      expect(timelineOrder()).toEqual(["event:11", "event:10", "event:9", "event:8"]),
    );
    expect(api.fetchDeliveryEvents).toHaveBeenLastCalledWith("demo", 3, { after: 9, unit: "A" });
  });

  it("SB-TC-032 shows a posted event within 2 seconds and keeps the most recent 1,000 of a burst with keys still working", async () => {
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

    // Step 2: 1,000 more events in one minute, posted in ten batches. Between
    // each post and its render, a key on the page still does its work: the
    // arrow keys move the selection between the Diff and Verify tabs. The
    // 100 ms bound itself is not measured here: jsdom dispatches a key
    // synchronously, so no render can delay it and a timing would prove nothing.
    for (let batch = 0; batch < 10; batch += 1) {
      const events = Array.from({ length: 100 }, (_, index) => {
        const seq = 10 + batch * 100 + index;
        return unitEvent(seq, "B", "note", { text: `Turn ${seq}` }, at(42 + batch, index % 60));
      });
      post(...events);
      const [from, to] = batch % 2 === 0 ? ["Diff", "Verify"] : ["Verify", "Diff"];
      const tab = screen.getByRole("tab", { name: from });
      tab.focus();
      fireEvent.keyDown(tab, { key: batch % 2 === 0 ? "ArrowRight" : "ArrowLeft" });
      expect(screen.getByRole("tab", { name: to })).toHaveAttribute("aria-selected", "true");
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
  }, 60_000);

  it("SB-TC-033 reaches every panel by keyboard with its name and has no axe findings", async () => {
    const user = userEvent.setup();
    record = withStatus(fourUnitRecord(), { B: "running" });
    log = [unitEvent(8, "B", "unit.changed", { status: "running" }, at(40))];
    const { container } = renderWithProviders(<Harness />);
    const drillIn = await openUnit("B");
    await waitFor(() => expect(timelineOrder()).toEqual(["event:8"]));

    // Step 1: Tab from the timeline to the Diff and Verify tabs and their
    // panels; each announces its name.
    within(drillIn).getByRole("button", { name: "Close" }).focus();
    await user.tab();
    expect(screen.getByRole("region", { name: "Timeline of unit B" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("list", { name: "Events of unit B, newest first" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("tab", { name: "Diff" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("region", { name: "Diff of unit B" })).toHaveFocus();
    // Shift+Tab reaches the tab list, and the arrow key selects Verify.
    await user.tab({ shift: true });
    expect(screen.getByRole("tab", { name: "Diff" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Verify" })).toHaveAttribute("aria-selected", "true");
    await user.tab();
    expect(screen.getByRole("region", { name: "Verify results of unit B" })).toHaveFocus();

    // Step 2: the accessibility suite over the drill-in.
    expectNoAxeFindings(await axe(container));
  });

  it("SB-TC-035 shows an empty state naming the unit in each panel for a unit with no events", async () => {
    log = [unitEvent(8, "B", "unit.changed", { status: "running" }, at(40))];
    renderWithProviders(<Harness />);

    // Step 1: open D before any event names it.
    const drillIn = await openUnit("D");
    // Each empty state shows within its own panel.
    const timeline = within(drillIn).getByRole("region", { name: "Timeline of unit D" });
    expect(await within(timeline).findByTestId("unit-timeline-empty")).toHaveTextContent(
      "No events for unit D yet.",
    );
    const diff = within(drillIn).getByRole("region", { name: "Diff of unit D" });
    expect(await within(diff).findByTestId("unit-diff-empty")).toHaveTextContent(
      "No diff for unit D yet: it has no commit.",
    );
    // Verify waits behind the Diff tab; selected, it shows its empty state.
    await userEvent.click(within(drillIn).getByRole("tab", { name: "Verify" }));
    const verify = within(drillIn).getByRole("region", { name: "Verify results of unit D" });
    expect(within(verify).getByTestId("unit-verify-empty")).toBeVisible();
    expect(within(verify).getByTestId("unit-verify-empty")).toHaveTextContent(
      "No verify results for unit D: no gate after it names a case.",
    );
    const time = within(drillIn).getByRole("region", { name: "Time of unit D" });
    // D is done in the record and the history starts at seq 8, so D finished
    // before it: the panel says D has no time there, not that it never started.
    expect(
      await within(time).findByText("Unit D has no time in the event history."),
    ).toBeInTheDocument();
    expect(within(drillIn).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("#1671 shows the unit's time split below the timeline and the tabs", async () => {
    record = withStatus(fourUnitRecord(), { B: "pending" });
    log = [unitEvent(8, "B", "unit.changed", { status: "running" }, at(40))];
    renderWithProviders(<Harness />);

    const drillIn = await openUnit("B");
    const regions = within(drillIn).getAllByRole("region");
    expect(regions[0]).toHaveAccessibleName("Timeline of unit B");
    const time = within(drillIn).getByRole("region", { name: "Time of unit B" });
    expect(regions.at(-1)).toBe(time);
    // B has run since 09:40, and the split is read at 10:00.
    const agent = await within(time).findByTestId("unit-time-agent");
    expect(agent).toHaveTextContent("Agent working");
    expect(agent).toHaveTextContent("20m");
    expect(agent).toHaveTextContent("20 minutes, 100 percent");
    expect(within(time).getByTestId("unit-time-operator")).toHaveTextContent("0 percent");
    expect(within(time).getByTestId("unit-time-total")).toHaveTextContent("20 minutes");
    expect(time).toHaveTextContent("from 2026-10-16 09:40 UTC");
  });

  it("lists the verify results as rows under their gate, each opening its evidence (#1659)", async () => {
    const result = {
      observationMarks: {},
      derivedStatus: "passed",
      notes: [{ text: "Checked by hand on the bench" }],
      verification: {
        tier: "a",
        confidence: "high",
        evidence: ["vitest client/src/components/delivery/UnitDrillIn.test.tsx passes"],
        author: "verify",
        timestamp: at(50),
      },
    } as unknown as CaseResult;
    decorate = (snapshot) => ({
      ...snapshot,
      progress: {
        ...snapshot.progress,
        caseList: [
          {
            id: "FX-TC-001",
            title: "The second layer reads back",
            met: true,
            result,
            metBy: "B",
            prUrl: null,
          },
        ],
      },
    });
    renderWithProviders(<Harness />);

    const drillIn = await openUnit("B");
    await userEvent.click(within(drillIn).getByRole("tab", { name: "Verify" }));
    const verify = within(drillIn).getByRole("region", { name: "Verify results of unit B" });

    // The gate heads its cases with its id and state.
    const gate = within(verify).getByTestId("unit-verify-gate-after-b");
    expect(within(gate).getByRole("heading", { name: /gate-after-b/ })).toHaveTextContent(
      "gate-after-b · pending",
    );
    // A row: the case's status, its id, its title and its verification tier,
    // with the ids kept on one line.
    const row = within(gate).getByRole("button", { name: /FX-TC-001/ });
    expect(row).toHaveTextContent("FX-TC-001");
    expect(row).toHaveTextContent("The second layer reads back");
    expect(row).toHaveTextContent("tier a · high");
    expect(row).toHaveAccessibleName(/^FX-TC-001 The second layer reads back, Passed/);
    expect(within(row).getByText("FX-TC-001")).toHaveClass("whitespace-nowrap");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(verify).queryByTestId("unit-verify-evidence-FX-TC-001")).not.toBeInTheDocument();

    // The row opens the evidence beneath it, and closes it again.
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const evidence = within(verify).getByTestId("unit-verify-evidence-FX-TC-001");
    expect(evidence).toHaveTextContent("UnitDrillIn.test.tsx passes");
    expect(evidence).toHaveTextContent("Checked by hand on the bench");
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(verify).queryByTestId("unit-verify-evidence-FX-TC-001")).not.toBeInTheDocument();
  });
});
