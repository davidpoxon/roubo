// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DELIVERY_CONTROL_SCHEMA_ID,
  DELIVERY_CONTROL_SCHEMA_VERSION,
  type DeliveryControl,
} from "@roubo/shared/delivery-control-contract";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import type { DeliveryOutboxControl } from "@roubo/shared";
import { fourUnitRecord, unitChanged, unitEvent } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    acceptDeliveryDecision: vi.fn(),
    overturnDeliveryDecision: vi.fn(),
    fetchDelivery: vi.fn(),
  };
});
import * as api from "../../lib/api";
import ReviewPile, { REVIEW_THREAD_UNAVAILABLE } from "./ReviewPile";
import { timelineTime } from "./delivery-timeline-model";

const OPTIONS = ["one file per unit", "one file per stack"];

function autoRecord() {
  return { ...fourUnitRecord(), mode: { value: "auto" as const, pending: null } };
}

function decided(seq: number, id: string, index: number, rationale?: string): DeliveryEvent {
  return unitEvent(
    seq,
    "B",
    "decision.decided",
    {
      decision_id: id,
      question: `Which layout for ${id}?`,
      options: OPTIONS,
      default: OPTIONS[0],
      chosen: OPTIONS[1],
      rationale: rationale ?? `Rationale of ${id}.`,
      affected_units: ["B", "C"],
      decided_at: new Date(Date.UTC(2026, 9, 16, 10, 0, index)).toISOString(),
    },
    "2026-10-16T10:30:00Z",
  );
}

function other(seq: number, type: string, payload: Record<string, unknown>): DeliveryEvent {
  return unitEvent(seq, "B", type, payload, "2026-10-16T10:31:00Z");
}

// An operator's review action on the decision in the outbox, as the snapshot
// carries it.
function reviewControl(
  decisionId: string,
  status = "pending",
  kind: "review_accept" | "overturn" = "review_accept",
  option?: string,
): DeliveryControl {
  return {
    $schema: DELIVERY_CONTROL_SCHEMA_ID,
    schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    control_seq: 1,
    kind,
    target_id: decisionId,
    body: option === undefined ? {} : { option },
    durability: "durable",
    issued_at: "2026-10-16T10:20:00Z",
    status,
  } as DeliveryControl;
}

function acceptControl(decisionId: string, status = "pending"): DeliveryControl {
  return reviewControl(decisionId, status);
}

function pileOf(events: DeliveryEvent[], controls: DeliveryControl[] = []) {
  return (
    <ReviewPile
      projectId="demo"
      benchId={1}
      snapshot={foldDelivery({ record: autoRecord(), events, controls })}
    />
  );
}

beforeEach(() => {
  vi.mocked(api.acceptDeliveryDecision).mockReset();
  vi.mocked(api.overturnDeliveryDecision).mockReset();
  vi.mocked(api.acceptDeliveryDecision).mockImplementation(
    async (_p, _b, id) =>
      ({
        ...reviewControl(id),
        author: { name: "Ada", email: "ada@example.test" },
      }) as DeliveryOutboxControl,
  );
  vi.mocked(api.overturnDeliveryDecision).mockImplementation(
    async (_p, _b, id, option) =>
      ({
        ...reviewControl(id, "pending", "overturn", option),
        author: { name: "Ada", email: "ada@example.test" },
      }) as DeliveryOutboxControl,
  );
});

const card = (id: string) => screen.getByTestId(`review-card-${id}`);

// The Overturn actions of a card: one for each other option (#1622).
function overturnsOf(element: HTMLElement): HTMLElement[] {
  const overturns = within(element).getAllByRole("button", { name: /^Overturn: / });
  expect(overturns.length).toBeGreaterThan(0);
  return overturns;
}

afterEach(() => {
  cleanup();
});

describe("ReviewPile", () => {
  it("SB-TC-080: an agent decision shows as a card with its choice, rationale and affected units", () => {
    renderWithProviders(pileOf([decided(8, "D-1", 1, "The fixtures carry none.")]));
    const top = card("D-1");
    expect(top).toHaveAttribute("data-position", "top");
    expect(within(top).getByText("Which layout for D-1?")).toBeInTheDocument();
    expect(within(top).getByTestId("review-choice")).toHaveTextContent(`chose${OPTIONS[1]}`);
    expect(within(top).getByTestId("review-rationale")).toHaveTextContent(
      "The fixtures carry none.",
    );
    expect(within(top).getByTestId("review-origin")).toHaveTextContent(
      "agent decided at B · affects B, C",
    );
    // During a run, with no review open, the badge reads decided.
    expect(within(top).getByTestId("review-badge")).toHaveTextContent("D-1 · decided");
  });

  it("SB-TC-081: at a review the oldest card is on top reading to review, and the next oldest rises after its outcome", () => {
    const events = [
      decided(8, "D-2", 2),
      decided(9, "D-1", 1),
      decided(10, "D-3", 3),
      other(11, "review.opened", { trigger: "boundary", unreviewed: ["D-1", "D-2", "D-3"] }),
    ];
    const { rerender } = renderWithProviders(pileOf(events));
    expect(card("D-1")).toHaveAttribute("data-position", "top");
    expect(within(card("D-1")).getByTestId("review-badge")).toHaveTextContent("D-1 · to review");
    expect(card("D-2")).toHaveAttribute("data-position", "lower");
    expect(card("D-3")).toHaveAttribute("data-position", "lower");

    // At an open review the card offers Accept, Overturn and its thread.
    expect(within(card("D-1")).getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(within(card("D-1")).getByRole("button", { name: "Discuss" })).toBeEnabled();

    rerender(
      pileOf([...events, other(12, "review.outcome", { decision_id: "D-1", status: "accepted" })]),
    );
    expect(screen.queryByTestId("review-card-D-1")).not.toBeInTheDocument();
    expect(card("D-2")).toHaveAttribute("data-position", "top");
    expect(within(card("D-2")).getByTestId("review-badge")).toHaveTextContent("D-2 · to review");
  });

  it("SB-TC-083: a rationale, a reply and a summary that hold markup render as literal text", async () => {
    const pwned = window as unknown as { __sbPwned?: number };
    delete pwned.__sbPwned;
    const rationale =
      '<script>window.__sbPwned = 1</script><img src="x" onerror="window.__sbPwned = 2">';
    const reply =
      '<a href="javascript:window.__sbPwned = 3">open</a> [docs](javascript:window.__sbPwned=4) https://example.test';
    const summary = "<script>window.__sbPwned = 5</script>";
    const events = [
      decided(8, "D-1", 1, rationale),
      decided(9, "D-2", 2),
      other(10, "review.opened", { unreviewed: ["D-1", "D-2"] }),
      other(11, "review.reply", { decision_id: "D-1", text: reply, in_reply_to: "1" }),
    ];
    const { container, rerender } = renderWithProviders(pileOf(events));
    expect(within(card("D-1")).getByTestId("review-rationale").textContent).toBe(rationale);

    const user = userEvent.setup();
    await user.click(within(card("D-1")).getByRole("button", { name: "Discuss" }));
    const thread = screen.getByTestId("review-thread-D-1");
    expect(thread).toHaveTextContent(reply);
    expect(thread.querySelector("a")).toBeNull();

    rerender(
      pileOf([
        ...events,
        other(12, "review.outcome", { decision_id: "D-1", status: "accepted", summary }),
      ]),
    );
    await waitFor(() => expect(screen.getByTestId("review-summary-D-1")).toBeInTheDocument());
    expect(screen.getByTestId("review-summary-D-1").textContent).toBe(summary);
    // The reviewed row dims its head line only: the summary keeps full contrast
    // (#1622).
    const row = screen.getByTestId("review-reviewed-D-1");
    expect(row.firstElementChild).toHaveClass("opacity-40");
    expect(screen.getByTestId("review-summary-D-1").closest(".opacity-40")).toBeNull();
    expect(container.querySelector("script, img, a, iframe")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(pwned.__sbPwned).toBeUndefined();
  });

  it("SB-FR-034: a pile of 100 renders one full body and 99 title bars, and Enter raises the last card", async () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      decided(8 + index, `D-${index + 1}`, index),
    );
    renderWithProviders(pileOf(events));
    const pile = screen.getByRole("list", { name: "Review pile" });
    expect(card("D-1")).toHaveAttribute("data-position", "top");
    expect(within(pile).getAllByTestId("review-rationale")).toHaveLength(1);
    expect(pile.querySelectorAll('[data-position="lower"]')).toHaveLength(99);

    const user = userEvent.setup();
    card("D-100").focus();
    await user.keyboard("{Enter}");
    expect(card("D-100")).toHaveAttribute("data-position", "top");
    expect(within(card("D-100")).getByTestId("review-rationale")).toHaveTextContent(
      "Rationale of D-100.",
    );
    expect(card("D-1")).toHaveAttribute("data-position", "lower");
    expect(
      within(screen.getByRole("list", { name: "Review pile" })).getAllByTestId("review-rationale"),
    ).toHaveLength(1);
  });

  it("reads queued while an operator's review control on the card waits in the outbox", () => {
    const events = [
      decided(8, "D-1", 1),
      other(9, "review.opened", { trigger: "boundary", unreviewed: ["D-1"] }),
    ];
    renderWithProviders(pileOf(events, [acceptControl("D-1")]));
    expect(within(card("D-1")).getByTestId("review-badge")).toHaveTextContent("D-1 · queued");
    expect(within(card("D-1")).getByTestId("review-queued")).toHaveTextContent(
      "accept queued · next boundary: A finishes",
    );
  });

  it("SB-TC-085: the operator accepts and overturns cards at an open review", async () => {
    const events = [
      decided(8, "D-2", 2),
      decided(9, "D-1", 1),
      other(10, "review.opened", { trigger: "boundary", unreviewed: ["D-1", "D-2"] }),
    ];
    const { rerender } = renderWithProviders(pileOf(events));
    const user = userEvent.setup();

    // Step 1: Accept on D-1 sends the accept, then the card reads queued.
    await user.click(within(card("D-1")).getByRole("button", { name: "Accept" }));
    expect(api.acceptDeliveryDecision).toHaveBeenCalledWith("demo", 1, "D-1");
    rerender(pileOf(events, [acceptControl("D-1")]));
    expect(within(card("D-1")).getByTestId("review-badge")).toHaveTextContent("D-1 · queued");
    expect(within(card("D-1")).getByTestId("review-queued")).toHaveTextContent("accept queued");
    expect(within(card("D-1")).getByTestId("review-actions")).toHaveAttribute(
      "data-dimmed",
      "true",
    );

    // Step 2: the review.outcome removes D-1 from the pile.
    const outcome = [
      ...events,
      other(11, "review.outcome", { decision_id: "D-1", status: "accepted" }),
    ];
    rerender(pileOf(outcome, [acceptControl("D-1", "applied")]));
    expect(screen.queryByTestId("review-card-D-1")).not.toBeInTheDocument();
    expect(card("D-2")).toHaveAttribute("data-position", "top");

    // Step 3: D-2's Overturn for its other option, named by it, sends it.
    const choices = within(card("D-2")).getByRole("group", { name: "Overturn D-2 with" });
    await user.click(within(choices).getByRole("button", { name: `Overturn: ${OPTIONS[0]}` }));
    expect(api.overturnDeliveryDecision).toHaveBeenCalledWith("demo", 1, "D-2", OPTIONS[0]);
  });

  it("puts the day in front of the time of a thread message from an earlier day", async () => {
    // Two days after the reply: its time names its weekday, in local time.
    const ts = "2026-10-16T10:31:00Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(ts) + 2 * 86_400_000);
    try {
      renderWithProviders(
        pileOf([
          decided(8, "D-1", 1),
          other(9, "review.opened", { unreviewed: ["D-1"] }),
          other(10, "review.reply", { decision_id: "D-1", text: "Kept.", in_reply_to: "1" }),
        ]),
      );
      await userEvent.click(within(card("D-1")).getByRole("button", { name: "Discuss" }));
      const time = within(screen.getByTestId("review-thread-D-1")).getByTestId(
        "review-thread-time",
      );
      expect(time).toHaveTextContent(/^[A-Z][a-z]{2} \d{2}:\d{2}$/);
      expect(time).toHaveTextContent(timelineTime(ts, new Date(), false));
      expect(time).toHaveAttribute("datetime", ts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SB-TC-086: during a run the card reads decided, Accept and Overturn are enabled, and the thread says why it is unavailable", async () => {
    const events = [
      decided(8, "D-1", 1),
      unitChanged(9, "A", "done"),
      unitChanged(10, "D", "running"),
    ];
    const { rerender } = renderWithProviders(pileOf(events));
    const top = card("D-1");

    // Step 1: the top card during a run.
    expect(within(top).getByTestId("review-badge")).toHaveTextContent("D-1 · decided");
    expect(within(top).getByRole("button", { name: "Accept" })).toBeEnabled();
    for (const overturn of overturnsOf(top)) expect(overturn).toBeEnabled();
    expect(within(top).getByRole("button", { name: "Discuss" })).toBeDisabled();
    expect(within(top).getByTestId("review-thread-unavailable")).toHaveTextContent(
      REVIEW_THREAD_UNAVAILABLE,
    );

    // Step 2: Accept queues the action until the next boundary, unit D.
    const user = userEvent.setup();
    await user.click(within(top).getByRole("button", { name: "Accept" }));
    expect(api.acceptDeliveryDecision).toHaveBeenCalledWith("demo", 1, "D-1");
    rerender(pileOf(events, [acceptControl("D-1")]));
    expect(within(card("D-1")).getByTestId("review-queued")).toHaveTextContent(
      "accept queued · next boundary: D finishes",
    );

    // Step 3: the boundary, then the outcome.
    rerender(
      pileOf(
        [
          ...events,
          unitChanged(11, "D", "done"),
          other(12, "review.outcome", { decision_id: "D-1", status: "accepted" }),
        ],
        [acceptControl("D-1", "applied")],
      ),
    );
    expect(screen.queryByTestId("review-card-D-1")).not.toBeInTheDocument();
  });

  it("SB-FR-035: a queued action stays replaceable until the session reads it, then its actions are disabled", () => {
    const events = [
      decided(8, "D-1", 1),
      other(9, "review.opened", { trigger: "boundary", unreviewed: ["D-1"] }),
    ];
    const { rerender } = renderWithProviders(pileOf(events, [acceptControl("D-1")]));
    for (const overturn of overturnsOf(card("D-1"))) expect(overturn).toBeEnabled();

    rerender(pileOf(events, [acceptControl("D-1", "delivered")]));
    expect(within(card("D-1")).getByRole("button", { name: "Accept" })).toBeDisabled();
    for (const overturn of overturnsOf(card("D-1"))) expect(overturn).toBeDisabled();
    expect(within(card("D-1")).getByTestId("review-queued")).toHaveTextContent(
      "accept read by the session",
    );

    // A superseded action no longer queues the card.
    rerender(pileOf(events, [acceptControl("D-1", "superseded")]));
    expect(within(card("D-1")).getByTestId("review-badge")).toHaveTextContent("D-1 · to review");
  });

  it("names no review region once every agent decision is reviewed, and still announces the review", async () => {
    const events = [decided(8, "D-1", 1), other(9, "review.opened", { unreviewed: ["D-1"] })];
    const { rerender } = renderWithProviders(pileOf(events));
    expect(screen.getByRole("region", { name: "Agent decisions to review" })).toBeInTheDocument();
    rerender(
      pileOf([
        ...events,
        other(10, "review.outcome", { decision_id: "D-1", status: "accepted", summary: "Kept." }),
      ]),
    );
    expect(await screen.findByTestId("review-reviewed-D-1")).toBeInTheDocument();
    expect(screen.getByTestId("review-announcer")).toHaveTextContent("D-1 reviewed.");
    // The reviewed card drops away, and then no region claims a decision waits.
    await waitFor(() => expect(screen.queryByTestId("review-leaving-D-1")).not.toBeInTheDocument());
    expect(
      screen.queryByRole("region", { name: "Agent decisions to review" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("review-announcer")).toHaveTextContent("D-1 reviewed.");
  });

  it("shows no Overturn group on a card whose decision has no other option, and keeps Accept", () => {
    // The contract asks for two options but not two distinct ones, so a
    // decision can offer nothing besides its choice.
    const single = unitEvent(
      8,
      "B",
      "decision.decided",
      {
        decision_id: "D-1",
        question: "Which layout for D-1?",
        options: [OPTIONS[0], OPTIONS[0]],
        default: OPTIONS[0],
        chosen: OPTIONS[0],
        rationale: "Only one layout fits.",
        affected_units: ["B"],
        decided_at: "2026-10-16T10:00:01Z",
      },
      "2026-10-16T10:30:00Z",
    );
    renderWithProviders(pileOf([single]));
    expect(within(card("D-1")).getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(within(card("D-1")).queryByRole("group", { name: "Overturn D-1 with" })).toBeNull();
    expect(within(card("D-1")).queryByRole("button", { name: /^Overturn: / })).toBeNull();
  });

  it("raises nothing for a request naming a reviewed decision, so the raised card stays on top", () => {
    const events = [
      decided(8, "D-1", 1),
      decided(9, "D-2", 2),
      decided(10, "D-3", 3),
      other(11, "review.opened", { unreviewed: ["D-1", "D-2", "D-3"] }),
    ];
    const pile = (all: DeliveryEvent[], raiseRequest: { decisionId: string; nonce: number }) => (
      <ReviewPile
        projectId="demo"
        benchId={1}
        snapshot={foldDelivery({ record: autoRecord(), events: all, controls: [] })}
        raiseRequest={raiseRequest}
      />
    );
    const { rerender } = renderWithProviders(pile(events, { decisionId: "D-3", nonce: 1 }));
    expect(card("D-3")).toHaveAttribute("data-position", "top");

    // D-2 is reviewed, so it leaves the stack. A request that names it raises
    // nothing: D-3 stays on top, not the oldest card.
    rerender(
      pile([...events, other(12, "review.outcome", { decision_id: "D-2", status: "accepted" })], {
        decisionId: "D-2",
        nonce: 2,
      }),
    );
    expect(card("D-3")).toHaveAttribute("data-position", "top");
    expect(card("D-1")).toHaveAttribute("data-position", "lower");
    expect(screen.queryByTestId("review-card-D-2")).not.toBeInTheDocument();
  });

  it("renders nothing when no agent decision waits or was reviewed", () => {
    const { container } = renderWithProviders(pileOf([]));
    expect(container).toBeEmptyDOMElement();
  });
});
