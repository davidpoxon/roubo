// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { QueryClientProvider } from "@tanstack/react-query";
import type { DeliveryEvent, ProvisionalCase } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { expectNoAxeFindings } from "../../test/axe";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";
import { makeQueryClient, renderWithProviders } from "../../test/renderWithProviders";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";
import ModeSwitch from "./ModeSwitch";
import ProvisionalMarkCard from "./ProvisionalMark";
import { readProvisionalMark } from "./provisional-mark-model";
import ReviewPile from "./ReviewPile";

// The keyboard and screen-reader paths of the four Spec Bench surfaces
// (SB-NFR-004, SB-US-013, SB-US-014): the mode switch, the review card on the
// decision pile, the discussion thread on the review card, and the provisional
// badge on a sitting case. Each runs under the shared axe check.

const OPTIONS = ["one file per unit", "one file per stack", "one file per repo"];

function autoRecord() {
  return { ...fourUnitRecord(), mode: { value: "auto" as const, pending: null } };
}

function decided(seq: number, id: string, index: number): DeliveryEvent {
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
      rationale: `Rationale of ${id}.`,
      affected_units: ["B", "C"],
      decided_at: new Date(Date.UTC(2026, 9, 16, 10, 0, index)).toISOString(),
    },
    "2026-10-16T10:30:00Z",
  );
}

function other(seq: number, type: string, payload: Record<string, unknown>): DeliveryEvent {
  return unitEvent(seq, "B", type, payload, "2026-10-16T10:31:00Z");
}

// An open review with D-1 and D-2 unreviewed, D-1 the older.
const OPEN_REVIEW: DeliveryEvent[] = [
  decided(8, "D-2", 2),
  decided(9, "D-1", 1),
  other(10, "review.opened", { trigger: "boundary", unreviewed: ["D-1", "D-2"] }),
];

function pileOf(events: DeliveryEvent[]) {
  return (
    <ReviewPile
      projectId="demo"
      benchId={1}
      sessionLive
      snapshot={foldDelivery({ record: autoRecord(), events })}
    />
  );
}

const PROVISIONAL: ProvisionalCase = {
  case: "TC-1",
  mark: "met",
  evidence: "The banner showed in the drive.",
  confirmed: false,
};

function provisionalInSitting() {
  return (
    <ProvisionalMarkCard
      entry={PROVISIONAL}
      reading={readProvisionalMark(PROVISIONAL, undefined)}
      onConfirm={vi.fn()}
    />
  );
}

function expectVisibleRing(element: Element) {
  expect(element).toHaveFocus();
  expect(element.className).toContain("focus-visible:ring-2");
  expect(element.className).toContain("focus-visible:ring-focus-ring");
}

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("Spec Bench surfaces: keyboard and screen reader", () => {
  it("SB-TC-102 the mode switch is a radio group whose arrow keys move between the segments with a visible ring", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = renderWithProviders(<ModeSwitch value="auto" onChange={onChange} />);

    const group = screen.getByRole("radiogroup", { name: "Decisions" });
    expect(within(group).getByRole("radio", { name: "Auto" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Attended" })).not.toBeChecked();

    await user.tab();
    const first = document.activeElement;
    expect(first).toHaveAttribute("role", "radio");
    expectVisibleRing(first as Element);

    await user.keyboard(first?.textContent === "Attended" ? "{ArrowRight}" : "{ArrowLeft}");
    const second = document.activeElement;
    expect(second).not.toBe(first);
    expect(second).toHaveAttribute("role", "radio");
    expectVisibleRing(second as Element);
    expect(second).toHaveAttribute("data-focus-visible", "true");

    expectNoAxeFindings(await axe(container));
  });

  it("SB-TC-102 Tab reaches Accept, each Overturn action and Discuss in order with a visible ring, and the badge names the decision", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(pileOf(OPEN_REVIEW));
    const top = screen.getByRole("article", { name: "Agent decision D-1" });
    expect(within(top).getByTestId("review-badge")).toHaveTextContent("D-1 · to review");

    await user.tab();
    expect(within(top).getByRole("button", { name: "Accept" })).toHaveFocus();
    expectVisibleRing(document.activeElement as Element);
    await user.tab();
    const overturn = within(top).getByRole("button", { name: "Overturn" });
    expectVisibleRing(overturn);

    // Overturn opens its options, and Tab reaches each before Discuss.
    await user.keyboard("{Enter}");
    expect(overturn).toHaveAttribute("aria-expanded", "true");
    const choices = within(top).getByRole("group", { name: "Overturn D-1 with" });
    for (const option of [OPTIONS[0], OPTIONS[2]]) {
      await user.tab();
      expectVisibleRing(within(choices).getByRole("button", { name: option }));
    }
    await user.tab();
    expectVisibleRing(within(top).getByRole("button", { name: "Discuss" }));

    expectNoAxeFindings(await axe(container));
  });

  it("SB-TC-102 Enter raises a lower card and the raised card takes focus", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(pileOf(OPEN_REVIEW));
    const lower = screen.getByTestId("review-card-D-2");
    expect(lower).toHaveAttribute("data-position", "lower");
    expect(lower).toHaveAccessibleName(/D-2 · to review/);

    lower.focus();
    await user.keyboard("{Enter}");
    const raised = screen.getByRole("article", { name: "Agent decision D-2" });
    expect(raised).toHaveAttribute("data-position", "top");
    expect(raised).toHaveFocus();
    expect(raised.className).toContain("focus-visible:ring-2");

    expectNoAxeFindings(await axe(container));
  });

  it("SB-TC-102 a review.reply is announced without moving focus, and the message field has an accessible name", async () => {
    const user = userEvent.setup();
    const { container, rerender } = renderWithProviders(pileOf(OPEN_REVIEW));
    const discuss = screen.getByRole("button", { name: "Discuss" });
    discuss.focus();
    await user.keyboard("{Enter}");
    expect(discuss).toHaveAttribute("aria-expanded", "true");
    expect(discuss).toHaveFocus();

    expect(screen.getByRole("textbox", { name: "Ask about this decision" })).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "Messages on D-1" });
    expect(log).toHaveAttribute("aria-live", "polite");

    rerender(
      pileOf([
        ...OPEN_REVIEW,
        other(11, "review.reply", {
          decision_id: "D-1",
          text: "The fixtures carry no repo key.",
          in_reply_to: "1",
        }),
      ]),
    );
    const live = screen.getByRole("log", { name: "Messages on D-1" });
    expect(live).toBe(log);
    expect(live).toHaveTextContent("The fixtures carry no repo key.");
    expect(discuss).toHaveFocus();

    expectNoAxeFindings(await axe(container));
  });

  it("SB-TC-102 a provisional badge in a sitting is announced with the mark and the word provisional", async () => {
    const { container } = renderWithProviders(provisionalInSitting());
    const badge = screen.getByTestId("provisional-mark-badge-TC-1");
    expect(badge).toHaveTextContent("Met · provisional");
    expect(badge).not.toHaveAttribute("aria-hidden");
    expect(screen.getByRole("button", { name: "Confirm TC-1" })).toBeEnabled();

    expectNoAxeFindings(await axe(container));
  });

  for (const theme of THEMES) {
    it(`SB-TC-102 the four surfaces have no WCAG 2.1 AA finding in ${theme}`, async () => {
      const user = userEvent.setup();
      const { container } = renderInTheme(
        <QueryClientProvider client={makeQueryClient()}>
          <main>
            <ModeSwitch value="auto" onChange={vi.fn()} pending="attended" />
            {pileOf([
              ...OPEN_REVIEW,
              other(11, "review.reply", {
                decision_id: "D-1",
                text: "The fixtures carry no repo key.",
                in_reply_to: "1",
              }),
            ])}
            {provisionalInSitting()}
          </main>
        </QueryClientProvider>,
        theme,
      );
      await user.click(screen.getByRole("button", { name: "Discuss" }));
      await user.click(screen.getByRole("button", { name: "Overturn" }));
      expect(screen.getByRole("log", { name: "Messages on D-1" })).toBeInTheDocument();
      expectNoAxeFindings(
        await axe(container, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        }),
      );
    });
  }
});
