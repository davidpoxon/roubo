// @vitest-environment jsdom
// A provisional gate (SB-FR-038, SB-US-014, SB-US-009): on the map it keeps the
// base ground and the default border with the preparing dot, its label and the
// count to confirm, and holds the pull requests above it as drafts; its review
// card lists the marks and opens the sitting; in the sitting each provisional
// case shows the agent's mark and evidence, which the operator confirms or
// changes through the results writer; and gate.confirmed for every case takes
// the gate out of the provisional state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench } from "@roubo/shared";
import type { DeliverySnapshotResponse } from "@roubo/shared/delivery-bench";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import {
  TEST_CASES_SCHEMA_ID,
  type CaseResult,
  type CaseStatus,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchTerminals: vi.fn(),
    fetchTestbenchPlan: vi.fn(),
    setStatusOverride: vi.fn(),
    openDeliverySitting: vi.fn(),
    closeDeliverySitting: vi.fn(),
  };
});
import * as api from "../../lib/api";
import { useNotificationStream } from "../../hooks/useNotificationStream";
import DeliveryTabPanel from "./DeliveryTabPanel";
import ReviewPile from "./ReviewPile";
import SpecBenchTestBench from "./SpecBenchTestBench";

const bench = {
  id: 3,
  projectId: "demo",
  variant: "specbench",
  status: "active",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  workspacePath: "/benches/demo-3",
  deliveryBindMode: "launch",
} as unknown as Bench;

const GATE = "gate-after-b";
const X = "FX-TC-001";
const Y = "FX-TC-002";
const Z = "FX-TC-003";
const PROVISIONAL_AT = "2026-10-16T09:45:00Z";

// The four-unit record in auto mode, with the gate after B judging `cases`.
function autoRecord(cases: string[]) {
  const record = { ...fourUnitRecord(), mode: { value: "auto" as const, pending: null } };
  record.stack.gates[0] = { ...record.stack.gates[0], cases };
  return record;
}

function provisional(seq: number, marks: Array<[string, "met" | "not_met"]>): DeliveryEvent {
  return unitEvent(
    seq,
    "B",
    "gate.provisional",
    {
      gate_id: GATE,
      cases: marks.map(([id, mark]) => ({ case: id, mark, evidence: `Evidence of ${id}.` })),
    },
    PROVISIONAL_AT,
  );
}

function confirmed(seq: number, cases: string[]): DeliveryEvent {
  return unitEvent(seq, "B", "gate.confirmed", { gate_id: GATE, cases }, "2026-10-16T11:00:00Z");
}

// ── The notification stream, so a test can post the frame of an event ──

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

// Chooses a case in the sitting's Cases list and returns the Case panel that
// shows it.
async function openCase(
  user: ReturnType<typeof userEvent.setup>,
  list: HTMLElement,
  caseId: string,
): Promise<HTMLElement> {
  await user.click(within(list).getByRole("button", { name: new RegExp(`^${caseId} ·`) }));
  return screen.getByRole("region", { name: `Case ${caseId}` });
}

function Harness() {
  useNotificationStream();
  return <DeliveryTabPanel bench={bench} />;
}

// Posts events: the server folds them and sends a frame at the last seq.
function post(record: ReturnType<typeof autoRecord>, events: DeliveryEvent[]) {
  vi.mocked(api.fetchDelivery).mockResolvedValue(foldDelivery({ record, events }));
  act(() => postFrame(events[events.length - 1].seq));
}

// ── The results the case status route writes, read back by the plan ──

const OPERATOR = { name: "Ada Operator", email: "ada@example.test" };
let results: Record<string, CaseResult>;

function planOf(cases: string[]): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: "1.2.0",
    specSlug: "fixture-spec",
    cases: cases.map((id) => ({
      id,
      title: `Case ${id}`,
      area: "fixture",
      level: 1,
      type: "functional",
      steps: [
        {
          id: "s1",
          instruction: `Open ${id}`,
          observations: [{ id: "o1", expected: `${id} behaves` }],
        },
      ],
      tags: [],
      linked_requirement_ids: ["FX-FR-001"],
      linked_user_story_ids: [],
    })),
  };
}

beforeEach(() => {
  localStorage.clear();
  results = {};
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(api.fetchTerminals).mockResolvedValue([]);
  vi.mocked(api.fetchTestbenchPlan).mockImplementation(async () => ({
    plan: planOf([X, Y]),
    results: { caseResults: { ...results }, updatedAt: "2026-10-16T10:00:00Z" },
    stale: false,
    planHash: "hash",
    recovered: false,
  }));
  // The results writer stamps the operator as author.
  vi.mocked(api.setStatusOverride).mockImplementation(async (_p, _b, caseId, override) => {
    const result: CaseResult = {
      observationMarks: {},
      derivedStatus: "not_started",
      statusOverride: {
        status: override as CaseStatus,
        author: OPERATOR,
        timestamp: "2026-10-16T10:00:00Z",
      },
      notes: [],
    };
    results[caseId] = result;
    return result;
  });
  vi.mocked(api.openDeliverySitting).mockResolvedValue({ gateId: GATE, state: "open" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("A provisional gate", () => {
  it("SB-TC-093 shows on the map with the preparing dot and the count to confirm, gains a review card, and holds the draft of the unit above it", async () => {
    const record = autoRecord([X, Y, Z]);
    vi.mocked(api.fetchDelivery).mockResolvedValue(foldDelivery({ record, events: [] }));
    renderWithProviders(<Harness />);
    await screen.findByTestId("delivery-graph");
    expect(screen.queryByTestId(`review-card-${GATE}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId("unit-pr-C")).not.toBeInTheDocument();

    // Step 1: the gate.provisional event for the gate after B, three cases.
    post(record, [
      provisional(8, [
        [X, "met"],
        [Y, "not_met"],
        [Z, "met"],
      ]),
    ]);
    const marker = screen.getByTestId(`gate-marker-${GATE}`);
    await waitFor(() => expect(marker).toHaveAttribute("data-gate-kind", "provisional"));
    // The base ground and the default border, not the gate node's danger set.
    expect(marker).toHaveClass("bg-bg-base", "border-border-strong");
    expect(marker).not.toHaveClass("bg-danger-surface");
    expect(marker).not.toHaveClass("border-status-error");
    // The preparing dot with the label provisional and the count 3.
    const status = marker.querySelector("[data-status]");
    expect(status).toHaveAttribute("data-status", "preparing");
    expect(status).toHaveTextContent("provisional · 3 to confirm");
    // The review stack gains one card for the gate.
    const card = await screen.findByTestId(`review-card-${GATE}`);
    expect(card).toHaveAttribute("data-kind", "gate");
    expect(screen.getAllByTestId(/^review-card-/)).toHaveLength(1);

    // Step 2: unit C, above the gate, reads as a held draft; B does not.
    expect(screen.getByTestId("unit-pr-C")).toHaveTextContent("draft · held");
    expect(screen.getByTestId("unit-node-C")).toHaveAccessibleName(/pull request draft · held/);
    expect(screen.queryByTestId("unit-pr-B")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unit-pr-D")).not.toBeInTheDocument();

    // Step 3: in the list view the gate badge reads the count still to confirm.
    await userEvent.click(screen.getByRole("button", { name: "List" }));
    const badge = screen.getByTestId(`gate-badge-${GATE}`);
    expect(badge).toHaveTextContent(`${GATE} · 3 to confirm`);
    expect(badge).toHaveClass("bg-accent-muted", "text-accent-text");
    expect(screen.getByTestId("unit-row-C").querySelector('[data-col="pr"]')?.textContent).toBe(
      "draft · held",
    );

    // One mark confirmed: the badge counts the two still to confirm.
    post(record, [
      provisional(8, [
        [X, "met"],
        [Y, "not_met"],
        [Z, "met"],
      ]),
      confirmed(9, [X]),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId(`gate-badge-${GATE}`)).toHaveTextContent(`${GATE} · 2 to confirm`),
    );
  });

  it("SB-TC-094 the gate card lists both marks with their evidence, and its only action, Open sitting, opens the gate's sitting", async () => {
    const user = userEvent.setup();
    const onSittingOpened = vi.fn();
    const snapshot = foldDelivery({
      record: autoRecord([X, Y]),
      events: [
        provisional(8, [
          [X, "met"],
          [Y, "not_met"],
        ]),
      ],
    });
    // The server opens the sitting, and the delivery it serves then carries it.
    let sittingOpen = false;
    vi.mocked(api.openDeliverySitting).mockImplementation(async () => {
      sittingOpen = true;
      return { gateId: GATE, state: "open" };
    });
    vi.mocked(api.fetchDelivery).mockImplementation(async () =>
      sittingOpen ? { ...snapshot, sitting: { gateId: GATE, state: "open" } } : snapshot,
    );
    renderWithProviders(
      <>
        <ReviewPile
          projectId="demo"
          benchId={3}
          snapshot={snapshot}
          onSittingOpened={onSittingOpened}
        />
        <SpecBenchTestBench bench={bench} />
      </>,
    );
    expect(
      await screen.findByText(/No gate sitting yet/, undefined, { timeout: 2000 }),
    ).toBeInTheDocument();

    // Step 1: both marks with their evidence, neutral, with no Confirm control.
    const card = screen.getByTestId(`review-card-${GATE}`);
    const marks = within(card).getByRole("list", { name: `Provisional marks of gate ${GATE}` });
    for (const [id, word] of [
      [X, "Met · provisional"],
      [Y, "Not met · provisional"],
    ]) {
      const mark = within(marks).getByTestId(`provisional-mark-${id}`);
      expect(within(mark).getByTestId(`provisional-mark-badge-${id}`)).toHaveTextContent(word);
      expect(within(mark).getByTestId(`provisional-mark-badge-${id}`)).toHaveClass("bg-bg-hover");
      expect(within(mark).getByTestId(`provisional-mark-evidence-${id}`)).toHaveTextContent(
        `Evidence of ${id}.`,
      );
    }
    // Its only action is Open sitting: no Accept, Overturn, Discuss or Confirm.
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Open sitting"]);
    expect(within(card).queryByTestId("review-choice")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("review-rationale")).not.toBeInTheDocument();

    // Step 2: Open sitting opens the gate's sitting, which the server pins at
    // the gate commit: the delivery is read again, so the Test bench shows the
    // sitting open with the gate's cases, the opening is announced, and the
    // bench is told so it shows the sitting.
    await user.click(within(card).getByRole("button", { name: "Open sitting" }));
    expect(api.openDeliverySitting).toHaveBeenCalledWith("demo", 3, GATE);
    const list = await screen.findByRole("list", { name: `Escalated cases of gate ${GATE}` });
    expect(
      within(list)
        .getAllByTestId("sitting-case")
        .map((c) => c.dataset.caseId),
    ).toEqual([X, Y]);
    expect(screen.getByRole("region", { name: `Gate ${GATE} sitting` })).toHaveAttribute(
      "data-state",
      "open",
    );
    expect(screen.getByTestId("review-announcer")).toHaveTextContent(
      `Opened the sitting of gate ${GATE}.`,
    );
    expect(onSittingOpened).toHaveBeenCalledWith(GATE);
  });

  it("SB-TC-094 Open sitting shows why the sitting could not open, and the bench is not told it opened", async () => {
    const user = userEvent.setup();
    const onSittingOpened = vi.fn();
    vi.mocked(api.openDeliverySitting).mockRejectedValue(
      new api.ApiError("A sitting is open already on gate gate-after-c", 409, "SITTING_OPEN"),
    );
    const snapshot = foldDelivery({
      record: autoRecord([X, Y]),
      events: [
        provisional(8, [
          [X, "met"],
          [Y, "not_met"],
        ]),
      ],
    });
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot);
    renderWithProviders(
      <ReviewPile
        projectId="demo"
        benchId={3}
        snapshot={snapshot}
        onSittingOpened={onSittingOpened}
      />,
    );
    const card = screen.getByTestId(`review-card-${GATE}`);
    await user.click(within(card).getByRole("button", { name: "Open sitting" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "A sitting is open already on gate gate-after-c",
    );
    // The card stays, with Open sitting enabled to try again.
    expect(within(card).getByRole("button", { name: "Open sitting" })).toBeEnabled();
    expect(screen.getByTestId("review-announcer")).toHaveTextContent("");
    expect(onSittingOpened).not.toHaveBeenCalled();
  });

  it("SB-TC-094 a gate card below a decision card shows the gate and the count to confirm, and raising it shows its marks and Open sitting", async () => {
    const user = userEvent.setup();
    // An agent decision made before the gate became provisional is on top.
    const decision = unitEvent(
      8,
      "B",
      "decision.decided",
      {
        decision_id: "decision-1",
        question: "Which layout for the cache?",
        options: ["one file per unit", "one file per stack"],
        default: "one file per unit",
        chosen: "one file per stack",
        rationale: "Fewer files.",
        affected_units: ["B", "C"],
        decided_at: "2026-10-16T09:00:00Z",
      },
      "2026-10-16T09:00:00Z",
    );
    const snapshot = foldDelivery({
      record: autoRecord([X, Y]),
      events: [
        decision,
        provisional(9, [
          [X, "met"],
          [Y, "not_met"],
        ]),
      ],
    });
    renderWithProviders(<ReviewPile projectId="demo" benchId={3} snapshot={snapshot} />);

    expect(screen.getByTestId("review-card-decision-1")).toHaveAttribute("data-position", "top");
    const lower = screen.getByTestId(`review-card-${GATE}`);
    expect(lower).toHaveAttribute("data-position", "lower");
    expect(lower).toHaveAttribute("data-kind", "gate");
    expect(within(lower).getByTestId("review-badge")).toHaveTextContent(`${GATE} · 2 to confirm`);
    expect(lower).toHaveTextContent("agent marked gate after B · provisional");
    // Below, the gate card shows no marks and no Open sitting.
    expect(within(lower).queryByTestId(`provisional-mark-${X}`)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open sitting" })).not.toBeInTheDocument();

    // Raising it puts the gate card on top with its marks and Open sitting.
    await user.click(lower);
    const top = screen.getByTestId(`review-card-${GATE}`);
    expect(top).toHaveAttribute("data-position", "top");
    expect(within(top).getByTestId(`provisional-mark-badge-${X}`)).toHaveTextContent(
      "Met · provisional",
    );
    expect(within(top).getByTestId(`provisional-mark-badge-${Y}`)).toHaveTextContent(
      "Not met · provisional",
    );
    expect(within(top).getByRole("button", { name: "Open sitting" })).toBeInTheDocument();
    expect(screen.getByTestId("review-card-decision-1")).toHaveAttribute("data-position", "lower");
  });

  it("SB-TC-094 a provisional case in the sitting shows its neutral badge and evidence, Confirm writes the mark with the operator as author and reads confirmed, and the case's own mark controls change it and it reads changed", async () => {
    const user = userEvent.setup();
    const snapshot: DeliverySnapshotResponse = {
      ...foldDelivery({
        record: autoRecord([X, Y]),
        events: [
          provisional(8, [
            [X, "met"],
            [Y, "not_met"],
          ]),
        ],
      }),
      sitting: { gateId: GATE, state: "open" },
    };
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot);
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
    const list = await screen.findByRole("list", { name: `Escalated cases of gate ${GATE}` });
    const caseX = await openCase(user, list, X);

    // Step 3: case X shows a neutral badge with the mark and the word
    // provisional, and the agent's evidence.
    const badgeX = within(caseX).getByTestId(`provisional-mark-badge-${X}`);
    expect(badgeX).toHaveTextContent("Met · provisional");
    expect(badgeX).toHaveClass("bg-bg-hover", "text-text-secondary");
    expect(badgeX).not.toHaveClass("bg-success-surface");
    expect(within(caseX).getByTestId(`provisional-mark-evidence-${X}`)).toHaveTextContent(
      `Evidence of ${X}.`,
    );
    expect(within(caseX).getByTestId(`provisional-mark-author-${X}`)).toHaveTextContent("agent");

    // Step 4: Confirm writes the mark through the case status route, the
    // existing results writer, which stamps the operator as author.
    await user.click(within(caseX).getByRole("button", { name: `Confirm ${X}` }));
    await waitFor(() => expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, X, "passed"));
    await waitFor(() => expect(badgeX).toHaveTextContent("Met · confirmed"));
    expect(badgeX).toHaveClass("bg-success-surface", "text-success-text");
    await waitFor(() =>
      expect(within(caseX).getByTestId(`provisional-mark-author-${X}`)).toHaveTextContent(
        OPERATOR.name,
      ),
    );
    expect(within(caseX).queryByRole("button", { name: `Confirm ${X}` })).not.toBeInTheDocument();

    // Step 5: case Y, marked not met by the agent, is marked met through the
    // case's own status control: the mark is written as met by the operator,
    // and the badge reads changed.
    const caseY = await openCase(user, list, Y);
    const badgeY = within(caseY).getByTestId(`provisional-mark-badge-${Y}`);
    expect(badgeY).toHaveTextContent("Not met · provisional");
    await user.click(within(caseY).getByRole("button", { name: /Case status/ }));
    await user.click(await screen.findByRole("option", { name: "Passed" }));
    await waitFor(() => expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, Y, "passed"));
    await waitFor(() => expect(badgeY).toHaveTextContent("Met · changed"));
    expect(badgeY).toHaveClass("bg-success-surface", "text-success-text");
    expect(within(caseY).getByTestId(`provisional-mark-author-${Y}`)).toHaveTextContent(
      OPERATOR.name,
    );
  });

  // A sitting on the gate after B, with the case results the results writer
  // holds.
  function renderSitting(snapshot: DeliverySnapshotResponse) {
    vi.mocked(api.fetchDelivery).mockResolvedValue({
      ...snapshot,
      sitting: { gateId: GATE, state: "open" },
    });
    renderWithProviders(<SpecBenchTestBench bench={bench} />);
  }

  function operatorResult(status: CaseStatus, timestamp: string): CaseResult {
    return {
      observationMarks: {},
      derivedStatus: "not_started",
      statusOverride: { status, author: OPERATOR, timestamp },
      notes: [],
    };
  }

  it("SB-TC-094 the operator's confirm and change still read confirmed and changed after a record rewrite re-dates the provisional gate", async () => {
    // The record, rewritten at noon, carries the gate as provisional with the
    // agent's marks, and the operator marked both cases at ten.
    const record = autoRecord([X, Y]);
    record.updated_at = "2026-10-16T12:00:00Z";
    record.stack.gates[0] = {
      ...record.stack.gates[0],
      status: "provisional",
      provisionalCases: [
        { case: X, mark: "met", evidence: `Evidence of ${X}.`, confirmed: false },
        { case: Y, mark: "not_met", evidence: `Evidence of ${Y}.`, confirmed: false },
      ],
    };
    const snapshot = foldDelivery({ record, events: [] });
    const provisionalAt = snapshot.gatesById[GATE].provisionalAt;
    expect(provisionalAt).toBe("2026-10-16T12:00:00Z");
    const markedAt = "2026-10-16T10:00:00Z";
    expect(Date.parse(markedAt)).toBeLessThan(Date.parse(provisionalAt ?? ""));
    results[X] = operatorResult("passed", markedAt);
    results[Y] = operatorResult("passed", markedAt);
    renderSitting(snapshot);
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: `Escalated cases of gate ${GATE}` });
    const caseX = await openCase(user, list, X);

    const badgeX = within(caseX).getByTestId(`provisional-mark-badge-${X}`);
    expect(badgeX).toHaveTextContent("Met · confirmed");
    expect(badgeX).toHaveClass("bg-success-surface");
    expect(within(caseX).getByTestId(`provisional-mark-author-${X}`)).toHaveTextContent(
      OPERATOR.name,
    );
    // No Confirm comes back, so it cannot overwrite the operator's mark.
    expect(within(caseX).queryByRole("button", { name: `Confirm ${X}` })).not.toBeInTheDocument();
    const caseY = await openCase(user, list, Y);
    const badgeY = within(caseY).getByTestId(`provisional-mark-badge-${Y}`);
    expect(badgeY).toHaveTextContent("Met · changed");
    expect(within(caseY).queryByRole("button", { name: `Confirm ${Y}` })).not.toBeInTheDocument();
  });

  it("SB-TC-094 an operator status that is no mark reads changed with the status the case holds, on the neutral badge", async () => {
    const snapshot = foldDelivery({
      record: autoRecord([X, Y]),
      events: [
        provisional(8, [
          [X, "met"],
          [Y, "not_met"],
        ]),
      ],
    });
    results[X] = operatorResult("blocked", "2026-10-16T10:00:00Z");
    results[Y] = operatorResult("in_progress", "2026-10-16T10:00:00Z");
    renderSitting(snapshot);
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: `Escalated cases of gate ${GATE}` });

    for (const [id, words] of [
      [X, "Blocked · changed"],
      [Y, "In progress · changed"],
    ] as const) {
      const testCase = await openCase(user, list, id);
      const badge = within(testCase).getByTestId(`provisional-mark-badge-${id}`);
      expect(badge).toHaveTextContent(words);
      expect(badge).not.toHaveTextContent(/Met/);
      expect(badge).not.toHaveAttribute("data-mark");
      expect(badge).toHaveClass("bg-bg-hover", "text-text-secondary");
      expect(badge).not.toHaveClass("bg-success-surface");
      expect(badge).not.toHaveClass("bg-danger-surface");
      expect(within(testCase).getByTestId(`provisional-mark-author-${id}`)).toHaveTextContent(
        OPERATOR.name,
      );
    }
  });

  it("SB-TC-094 Confirm on a not met mark reads confirmed in the danger set", async () => {
    const user = userEvent.setup();
    const snapshot = foldDelivery({
      record: autoRecord([X, Y]),
      events: [
        provisional(8, [
          [X, "met"],
          [Y, "not_met"],
        ]),
      ],
    });
    renderSitting(snapshot);
    const list = await screen.findByRole("list", { name: `Escalated cases of gate ${GATE}` });
    const caseY = await openCase(user, list, Y);
    const badgeY = within(caseY).getByTestId(`provisional-mark-badge-${Y}`);
    expect(badgeY).toHaveClass("bg-bg-hover");

    await user.click(within(caseY).getByRole("button", { name: `Confirm ${Y}` }));
    await waitFor(() => expect(api.setStatusOverride).toHaveBeenCalledWith("demo", 3, Y, "failed"));
    await waitFor(() => expect(badgeY).toHaveTextContent("Not met · confirmed"));
    expect(badgeY).toHaveClass("bg-danger-surface", "text-danger-text");
    expect(badgeY).not.toHaveClass("bg-bg-hover");
  });

  it("SB-TC-094 gate.confirmed for both cases takes the gate out of the provisional state on the map and removes its card", async () => {
    const record = autoRecord([X, Y]);
    const marked = provisional(8, [
      [X, "met"],
      [Y, "not_met"],
    ]);
    vi.mocked(api.fetchDelivery).mockResolvedValue(foldDelivery({ record, events: [marked] }));
    renderWithProviders(<Harness />);
    const marker = await screen.findByTestId(`gate-marker-${GATE}`);
    expect(marker).toHaveAttribute("data-gate-kind", "provisional");
    expect(await screen.findByTestId(`review-card-${GATE}`)).toBeInTheDocument();
    expect(screen.getByTestId("unit-pr-C")).toBeInTheDocument();

    // Step 6: gate.confirmed events for both cases.
    post(record, [marked, confirmed(9, [X]), confirmed(10, [Y])]);
    await waitFor(() =>
      expect(screen.getByTestId(`gate-marker-${GATE}`)).not.toHaveAttribute(
        "data-gate-kind",
        "provisional",
      ),
    );
    expect(screen.getByTestId(`gate-marker-${GATE}`)).not.toHaveTextContent("provisional");
    expect(screen.queryByTestId(`review-card-${GATE}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId("unit-pr-C")).not.toBeInTheDocument();
  });
});
