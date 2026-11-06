// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { expectNoAxeFindings } from "../../test/axe";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";
import { QueryClientProvider } from "@tanstack/react-query";
import { makeQueryClient, renderWithProviders } from "../../test/renderWithProviders";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    answerDeliveryDecision: vi.fn(),
    overturnDeliveryDecision: vi.fn(),
  };
});
import DecisionPile from "./DecisionPile";

function raised(seq: number, id: string, ts: string): DeliveryEvent {
  return unitEvent(
    seq,
    "B",
    "decision.raised",
    {
      decision_id: id,
      question: `Layout question of ${id}?`,
      options: ["one file per unit", "one file per stack", "one file per repo"],
      default: "one file per unit",
    },
    ts,
  );
}

// An open decision on top, a defaulted one beneath.
function snapshot() {
  return foldDelivery({
    record: fourUnitRecord(),
    events: [
      raised(8, "decision-a", "2026-10-16T10:00:00Z"),
      unitEvent(9, "B", "decision.defaulted", { decision_id: "decision-a" }, "2026-10-16T10:01:00Z"),
      raised(10, "decision-b", "2026-10-16T10:05:00Z"),
    ],
  });
}

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("Decision pile accessibility", () => {
  it("SB-TC-043 the pile is operable by keyboard, names each option with whether it is the default, and has no axe findings", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <DecisionPile projectId="demo" benchId={3} snapshot={snapshot()} />,
    );
    const names = screen
      .getAllByRole("button")
      .filter((button) => button.closest("[role=group]") !== null)
      .map((button) => button.textContent);
    expect(names).toEqual(["one file per unit (default)", "one file per stack", "one file per repo"]);
    expectNoAxeFindings(await axe(container));

    // The lower card raises by keyboard, and its overturn options are reachable.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: /Raise decision/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("decision-card-decision-a")).toHaveAttribute("data-position", "top");
    await user.click(screen.getByRole("button", { name: "Overturn" }));
    expectNoAxeFindings(await axe(container));
  });

  for (const theme of THEMES) {
    it(`has no axe findings in ${theme}`, async () => {
      const { container } = renderInTheme(
        <QueryClientProvider client={makeQueryClient()}>
          <DecisionPile projectId="demo" benchId={3} snapshot={snapshot()} />
        </QueryClientProvider>,
        theme,
      );
      expect(screen.getByRole("list", { name: "Decision pile" })).toBeInTheDocument();
      expectNoAxeFindings(await axe(container));
    });
  }
});
