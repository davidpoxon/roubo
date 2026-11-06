// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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
  return { ...actual, acceptDeliveryDecision: vi.fn(), fetchDelivery: vi.fn() };
});
import * as api from "../../lib/api";
import ReviewPile from "./ReviewPile";

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

function acceptControl(decisionId: string, status = "pending"): DeliveryControl {
  return {
    $schema: DELIVERY_CONTROL_SCHEMA_ID,
    schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    control_seq: 1,
    kind: "review_accept",
    target_id: decisionId,
    body: {},
    durability: "durable",
    issued_at: "2026-10-16T10:20:00Z",
    status,
  } as DeliveryControl;
}

function pileOf(events: DeliveryEvent[], controls: DeliveryControl[] = []) {
  return (
    <ReviewPile
      projectId="demo"
      benchId={3}
      snapshot={foldDelivery({ record: autoRecord(), events, controls })}
    />
  );
}

const card = (id: string) => screen.getByTestId(`review-card-${id}`);

beforeEach(() => {
  vi.mocked(api.acceptDeliveryDecision).mockImplementation(
    async (_p, _b, id) =>
      ({
        ...acceptControl(id),
        author: { name: "Ada", email: "ada@example.test" },
      }) as DeliveryOutboxControl,
  );
});

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

  it("SB-TC-081: at a review the oldest card is on top reading to review, Accept queues it, and the next oldest rises after its outcome", async () => {
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

    const user = userEvent.setup();
    await user.click(within(card("D-1")).getByRole("button", { name: "Accept" }));
    expect(api.acceptDeliveryDecision).toHaveBeenCalledWith("demo", 3, "D-1");

    rerender(pileOf(events, [acceptControl("D-1")]));
    expect(within(card("D-1")).getByTestId("review-badge")).toHaveTextContent("D-1 · queued");
    expect(within(card("D-1")).getByTestId("review-queued")).toHaveTextContent(
      "accept queued · next boundary",
    );
    expect(within(card("D-1")).getByRole("button", { name: "Accept" })).toBeDisabled();

    rerender(
      pileOf(
        [...events, other(12, "review.outcome", { decision_id: "D-1", status: "accepted" })],
        [acceptControl("D-1", "applied")],
      ),
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
    expect(container.querySelector("script, img, a, iframe")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(pwned.__sbPwned).toBeUndefined();
  });

  it("SB-TC-103: a pile of 100 renders one full body and 99 title bars, and Enter raises the last card", async () => {
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

  it("renders nothing when no agent decision waits or was reviewed", () => {
    const { container } = renderWithProviders(pileOf([]));
    expect(container).toBeEmptyDOMElement();
  });
});
