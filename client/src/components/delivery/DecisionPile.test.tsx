// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeliveryOutboxControl } from "@roubo/shared";
import {
  DELIVERY_CONTROL_SCHEMA_ID,
  DELIVERY_CONTROL_SCHEMA_VERSION,
  type DeliveryControl,
} from "@roubo/shared/delivery-control-contract";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    answerDeliveryDecision: vi.fn(),
    overturnDeliveryDecision: vi.fn(),
    fetchDelivery: vi.fn(),
  };
});
import * as api from "../../lib/api";
import DecisionPile, { DECISION_DROP_AWAY_MS } from "./DecisionPile";

const OPTIONS = ["one file per unit", "one file per stack"];

function raised(seq: number, id: string, ts: string, unitId = "B"): DeliveryEvent {
  return unitEvent(
    seq,
    unitId,
    "decision.raised",
    {
      decision_id: id,
      question: `Layout question of ${id}?`,
      options: OPTIONS,
      default: OPTIONS[0],
    },
    ts,
  );
}

function decisionEvent(seq: number, type: string, payload: Record<string, unknown>): DeliveryEvent {
  return unitEvent(seq, "B", type, payload, "2026-10-16T10:30:00Z");
}

function control(
  kind: "decision-answer" | "overturn",
  targetId: string,
  option: string,
  status = "pending",
): DeliveryControl {
  return {
    $schema: DELIVERY_CONTROL_SCHEMA_ID,
    schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    control_seq: 1,
    kind,
    target_id: targetId,
    body: { option },
    durability: "durable",
    issued_at: "2026-10-16T10:20:00Z",
    status,
  } as DeliveryControl;
}

function snapshotOf(events: DeliveryEvent[], controls: DeliveryControl[] = []) {
  return foldDelivery({ record: fourUnitRecord(), events, controls });
}

const FIRST = raised(8, "decision-a", "2026-10-16T10:00:00Z");
const SECOND = raised(9, "decision-b", "2026-10-16T10:05:00Z");

function renderPile(events: DeliveryEvent[], controls: DeliveryControl[] = []) {
  return renderWithProviders(
    <DecisionPile projectId="demo" benchId={3} snapshot={snapshotOf(events, controls)} />,
  );
}

function issued(kind: "decision-answer" | "overturn", id: string, option: string) {
  return {
    ...control(kind, id, option),
    author: { name: "Ada", email: "ada@example.test" },
  } as DeliveryOutboxControl;
}

beforeEach(() => {
  vi.mocked(api.answerDeliveryDecision).mockImplementation(async (_p, _b, id, option) =>
    issued("decision-answer", id, option),
  );
  vi.mocked(api.overturnDeliveryDecision).mockImplementation(async (_p, _b, id, option) =>
    issued("overturn", id, option),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DecisionPile", () => {
  it("sits in the Decisions panel, whose meta counts the cards to review, the pending questions and the defaults in force (#1622)", () => {
    renderPile([
      FIRST,
      SECOND,
      decisionEvent(10, "decision.defaulted", { decision_id: "decision-a" }),
    ]);
    const panel = screen.getByRole("region", { name: "Decisions" });
    expect(within(panel).getByRole("heading", { name: "Decisions" })).toBeInTheDocument();
    expect(panel.querySelector("header")).toHaveTextContent(
      "0 to review · 1 pending · 1 default in force",
    );
    expect(within(panel).getByRole("list", { name: "Decision pile" })).toBeInTheDocument();
  });

  it("counts the agent decisions to review and leaves an overturned decision out of the counts (#1622)", () => {
    const agentDecided = (seq: number, id: string) =>
      decisionEvent(seq, "decision.decided", {
        decision_id: id,
        question: `Which layout for ${id}?`,
        options: OPTIONS,
        default: OPTIONS[0],
        chosen: OPTIONS[1],
        rationale: `Rationale of ${id}.`,
        affected_units: ["B"],
        decided_at: "2026-10-16T10:10:00Z",
      });
    renderPile([
      FIRST,
      SECOND,
      decisionEvent(10, "decision.defaulted", { decision_id: "decision-b" }),
      decisionEvent(11, "decision.overturned", { decision_id: "decision-b", option: OPTIONS[1] }),
      agentDecided(12, "decision-x"),
      agentDecided(13, "decision-y"),
    ]);
    const panel = screen.getByRole("region", { name: "Decisions" });
    expect(panel.querySelector("header")).toHaveTextContent(
      "2 to review · 1 pending · 0 defaults in force",
    );
    // The overturned decision is a row, not a card, so the open one is on top.
    expect(screen.getByTestId("decision-card-decision-a")).toHaveAttribute("data-position", "top");
    expect(screen.queryByTestId("decision-card-decision-b")).not.toBeInTheDocument();
    expect(screen.getByTestId("decision-applied-decision-b")).toBeInTheDocument();
  });

  it("SB-TC-036 puts the newest raised decision on top with its options and default, and the earlier one beneath", () => {
    const { rerender } = renderPile([FIRST]);
    const top = screen.getByTestId("decision-card-decision-a");
    expect(top).toHaveAttribute("data-position", "top");
    expect(within(top).getByText("Layout question of decision-a?")).toBeInTheDocument();
    expect(within(top).getByTestId("decision-badge")).toHaveTextContent("Open");
    expect(
      within(top).getByRole("button", { name: "one file per unit (default)" }),
    ).toBeInTheDocument();
    expect(within(top).getByRole("button", { name: "one file per stack" })).toBeInTheDocument();
    expect(top).toHaveTextContent("default one file per unit");

    rerender(<DecisionPile projectId="demo" benchId={3} snapshot={snapshotOf([FIRST, SECOND])} />);
    expect(screen.getByTestId("decision-card-decision-b")).toHaveAttribute("data-position", "top");
    const lower = screen.getByTestId("decision-card-decision-a");
    expect(lower).toHaveAttribute("data-position", "lower");
    expect(lower).toHaveTextContent("decision-a · unit B · 2 options · default one file per unit");
    const items = within(screen.getByRole("list", { name: "Decision pile" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Layout question of decision-b?")).toBeInTheDocument();
  });

  it("raises a lower card to the top when it is pressed", async () => {
    const user = userEvent.setup();
    renderPile([FIRST, SECOND]);
    await user.click(screen.getByRole("button", { name: /Raise decision/ }));
    expect(screen.getByTestId("decision-card-decision-a")).toHaveAttribute("data-position", "top");
    expect(screen.getByTestId("decision-card-decision-b")).toHaveAttribute(
      "data-position",
      "lower",
    );
  });

  it("shows no open decisions for an empty pile", () => {
    renderPile([]);
    expect(screen.getByText("No open decisions")).toBeInTheDocument();
  });

  it("SB-TC-043 each option is reached by Tab and arrow keys, named with whether it is the default, and Enter answers and announces it", async () => {
    const user = userEvent.setup();
    const { rerender } = renderPile([FIRST]);

    await user.tab();
    const byDefault = screen.getByRole("button", { name: "one file per unit (default)" });
    const other = screen.getByRole("button", { name: "one file per stack" });
    expect(byDefault).toHaveFocus();
    await user.tab();
    expect(other).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(byDefault).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(other).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(byDefault).toHaveFocus();
    await user.keyboard("{End}");
    expect(other).toHaveFocus();
    await user.keyboard("{Home}");
    expect(byDefault).toHaveFocus();
    expect(screen.getByRole("group", { name: "Options of decision-a" })).toBeInTheDocument();

    // Enter answers with the focused option.
    await user.keyboard("{ArrowRight}{Enter}");
    expect(api.answerDeliveryDecision).toHaveBeenCalledWith(
      "demo",
      3,
      "decision-a",
      "one file per stack",
    );
    const announcer = screen.getByTestId("decision-announcer");
    expect(announcer).toHaveAttribute("role", "status");
    expect(announcer).toHaveAttribute("aria-live", "polite");
    await waitFor(() =>
      expect(announcer).toHaveTextContent(
        "Answered decision-a with one file per stack, pending until the session reads it back.",
      ),
    );

    // The answer waits in the outbox: the options are disabled until it lands.
    rerender(
      <DecisionPile
        projectId="demo"
        benchId={3}
        snapshot={snapshotOf([FIRST], [control("decision-answer", "decision-a", OPTIONS[1])])}
      />,
    );
    expect(screen.getByTestId("decision-badge")).toHaveTextContent("Answer pending");
    expect(screen.getByRole("button", { name: "one file per stack" })).toBeDisabled();

    // Its read-back applies it: the card drops away and the change is announced.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rerender(
      <DecisionPile
        projectId="demo"
        benchId={3}
        snapshot={snapshotOf(
          [
            FIRST,
            decisionEvent(9, "decision.answered", {
              decision_id: "decision-a",
              answer: OPTIONS[1],
            }),
          ],
          [control("decision-answer", "decision-a", OPTIONS[1], "applied")],
        )}
      />,
    );
    expect(announcer).toHaveTextContent("decision-a answered with one file per stack: applied.");
    const leaving = screen.getByTestId("decision-leaving-decision-a");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(leaving.className).toContain("animate-drop-away");
    act(() => {
      vi.advanceTimersByTime(DECISION_DROP_AWAY_MS);
    });
    expect(screen.queryByTestId("decision-leaving-decision-a")).not.toBeInTheDocument();
    expect(screen.getByText("No open decisions")).toBeInTheDocument();
  });

  it("SB-TC-038 a defaulted decision shows its default applied and pending overturn, overturns it, and shows the new option once overturned", async () => {
    const user = userEvent.setup();
    const defaulted = [
      FIRST,
      decisionEvent(9, "decision.defaulted", { decision_id: "decision-a" }),
    ];
    const { rerender } = renderPile([FIRST]);
    rerender(<DecisionPile projectId="demo" benchId={3} snapshot={snapshotOf(defaulted)} />);

    const announcer = screen.getByTestId("decision-announcer");
    expect(announcer).toHaveTextContent(
      "decision-a: the default one file per unit is applied, pending overturn.",
    );
    expect(screen.getByTestId("decision-badge")).toHaveTextContent("Default applied");
    expect(screen.getByTestId("decision-applied")).toHaveTextContent(
      "Applied: one file per unit (the default), pending overturn.",
    );

    // One Overturn for each other option, named by it (#1622).
    const overturns = within(
      screen.getByRole("group", { name: "Overturn decision-a with" }),
    ).getAllByRole("button");
    expect(overturns.map((button) => button.textContent)).toEqual(["Overturn: one file per stack"]);
    await user.click(screen.getByRole("button", { name: "Overturn: one file per stack" }));
    expect(api.overturnDeliveryDecision).toHaveBeenCalledWith(
      "demo",
      3,
      "decision-a",
      "one file per stack",
    );
    await waitFor(() =>
      expect(announcer).toHaveTextContent(
        "Overturned decision-a to one file per stack, pending until the session reads it back.",
      ),
    );

    rerender(
      <DecisionPile
        projectId="demo"
        benchId={3}
        snapshot={snapshotOf(defaulted, [control("overturn", "decision-a", OPTIONS[1])])}
      />,
    );
    expect(screen.getByTestId("decision-badge")).toHaveTextContent("Overturn pending");
    expect(
      screen.getByText(
        "Overturned to one file per stack, pending until the session reads it back.",
      ),
    ).toBeInTheDocument();

    rerender(
      <DecisionPile
        projectId="demo"
        benchId={3}
        snapshot={snapshotOf(
          [
            ...defaulted,
            decisionEvent(10, "decision.overturned", {
              decision_id: "decision-a",
              option: OPTIONS[1],
            }),
          ],
          [control("overturn", "decision-a", OPTIONS[1], "applied")],
        )}
      />,
    );
    // Applied, the overturned decision leaves the cards for a dimmed row at the
    // bottom of the panel (#1622).
    expect(screen.queryByRole("article", { name: "Decision decision-a" })).not.toBeInTheDocument();
    expect(screen.getByTestId("decision-leaving-decision-a")).toHaveClass("animate-drop-away");
    const row = within(screen.getByRole("list", { name: "Applied decisions" })).getByTestId(
      "decision-applied-decision-a",
    );
    expect(row).toHaveTextContent(
      "decision-a · overturned · applied one file per stack · default one file per unit",
    );
    expect(row).toHaveClass("opacity-40");
    expect(announcer).toHaveTextContent("decision-a overturned: one file per stack is applied.");
  });

  it("raises nothing for a request naming an overturned decision, so the open card stays on top", () => {
    const events = [
      FIRST,
      SECOND,
      decisionEvent(10, "decision.defaulted", { decision_id: "decision-b" }),
      decisionEvent(11, "decision.overturned", { decision_id: "decision-b", option: OPTIONS[1] }),
    ];
    renderWithProviders(
      <DecisionPile
        projectId="demo"
        benchId={3}
        snapshot={snapshotOf(events)}
        raiseRequest={{ decisionId: "decision-b", nonce: 1 }}
      />,
    );
    expect(screen.getByTestId("decision-card-decision-a")).toHaveAttribute("data-position", "top");
    expect(screen.queryByTestId("decision-card-decision-b")).not.toBeInTheDocument();
    expect(screen.getByTestId("decision-applied-decision-b")).toBeInTheDocument();
  });

  it("closes the panel with the applied decisions after the reviewed agent decisions, in one wrapper", () => {
    renderPile([
      FIRST,
      SECOND,
      decisionEvent(10, "decision.defaulted", { decision_id: "decision-b" }),
      decisionEvent(11, "decision.overturned", { decision_id: "decision-b", option: OPTIONS[1] }),
      decisionEvent(12, "decision.decided", {
        decision_id: "decision-x",
        question: "Which layout for decision-x?",
        options: OPTIONS,
        default: OPTIONS[0],
        chosen: OPTIONS[1],
        rationale: "Rationale of decision-x.",
        affected_units: ["B"],
        decided_at: "2026-10-16T10:10:00Z",
      }),
      decisionEvent(13, "review.outcome", { decision_id: "decision-x", status: "accepted" }),
    ]);
    const reviewed = screen.getByRole("list", { name: "Reviewed agent decisions" });
    const applied = screen.getByRole("list", { name: "Applied decisions" });
    expect(within(reviewed).getByTestId("review-reviewed-decision-x")).toBeInTheDocument();
    expect(within(applied).getByTestId("decision-applied-decision-b")).toBeInTheDocument();
    expect(reviewed.compareDocumentPosition(applied)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(applied.parentElement).toBe(reviewed.parentElement);
  });

  it("shows the error when a decision control is refused", async () => {
    const user = userEvent.setup();
    vi.mocked(api.answerDeliveryDecision).mockRejectedValueOnce(
      new api.ApiError("option must be one of the options of decision-a", 400, "INVALID_BODY"),
    );
    renderPile([FIRST]);
    await user.click(screen.getByRole("button", { name: "one file per unit (default)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "option must be one of the options of decision-a",
    );
  });
});
