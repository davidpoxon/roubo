// @vitest-environment jsdom
// The Time panel (#1671): the delivery's elapsed time, or one unit's, split
// into four states whose parts add up to the total, each value in words for
// the screen reader, with keyboard and axe checks in both themes (SB-NFR-004).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { axe } from "vitest-axe";
import type { DeliveryTimeSplit as DeliveryTimeSplitData } from "@roubo/shared/delivery-time-split";
import { DELIVERY_TIME_REFETCH_MS } from "../../hooks/useDelivery";
import { expectNoAxeFindings } from "../../test/axe";
import { makeQueryClient, renderWithProviders } from "../../test/renderWithProviders";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, fetchDeliveryTime: vi.fn() };
});
import * as api from "../../lib/api";
import DeliveryTimeSplit from "./DeliveryTimeSplit";

const MIN = 60_000;

function split(overrides: Partial<DeliveryTimeSplitData> = {}): DeliveryTimeSplitData {
  return {
    from: "2026-10-16T09:00:00.000Z",
    to: "2026-10-16T11:00:00.000Z",
    totalMs: 120 * MIN,
    parts: { agent: 65 * MIN, operator: 25 * MIN, gate: 20 * MIN, no_session: 10 * MIN },
    asOf: "2026-10-16T11:00:00.000Z",
    open: true,
    units: [
      {
        unitId: "B",
        from: "2026-10-16T09:20:00.000Z",
        to: "2026-10-16T10:00:00.000Z",
        totalMs: 40 * MIN,
        parts: { agent: 30 * MIN, operator: 10 * MIN, gate: 0, no_session: 0 },
      },
    ],
    notes: { historyTruncated: false, reviewCloseInferred: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(api.fetchDeliveryTime).mockReset();
  vi.mocked(api.fetchDeliveryTime).mockResolvedValue(split());
});

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("DeliveryTimeSplit", () => {
  it("lists the delivery's four parts, each with its share, and the total they add up to", async () => {
    renderWithProviders(<DeliveryTimeSplit projectId="demo" benchId={3} seq={9} />);
    const panel = screen.getByRole("region", { name: "Time of the delivery" });
    const agent = await within(panel).findByTestId("delivery-time-agent");
    expect(agent).toHaveTextContent("Agent working");
    expect(agent).toHaveTextContent("1h 05m");
    expect(agent).toHaveTextContent("1 hour 5 minutes, 54 percent");
    expect(within(panel).getByTestId("delivery-time-operator")).toHaveTextContent(
      "Waiting on you25m25 minutes, 21 percent",
    );
    expect(within(panel).getByTestId("delivery-time-gate")).toHaveTextContent(
      "At a gate20m20 minutes, 17 percent",
    );
    expect(within(panel).getByTestId("delivery-time-no_session")).toHaveTextContent(
      "No live session10m10 minutes, 8 percent",
    );
    expect(within(panel).getByTestId("delivery-time-total")).toHaveTextContent(
      "Total2h 00m2 hours",
    );
    expect(panel).toHaveTextContent("since 2026-10-16 09:00 UTC");
    // The bar is decorative, one segment per part with time in it.
    expect(within(panel).getByTestId("delivery-time-bar-agent").style.width).toBe(
      `${String((65 / 120) * 100)}%`,
    );
    // The record never dates a session's end, so that note always shows; the
    // others only when the split says so.
    const notes = within(panel).getByTestId("delivery-time-notes");
    expect(notes).toHaveTextContent("A session that ends without a pause counts as agent working");
    expect(notes).not.toHaveTextContent("does not reach back");
    expect(notes).not.toHaveTextContent("does not say when a review closed");
    expect(api.fetchDeliveryTime).toHaveBeenCalledWith("demo", 3);
  });

  it("names the range of an ended delivery and the parts the record cannot date", async () => {
    vi.mocked(api.fetchDeliveryTime).mockResolvedValue(
      split({ open: false, notes: { historyTruncated: true, reviewCloseInferred: true } }),
    );
    renderWithProviders(<DeliveryTimeSplit projectId="demo" benchId={3} seq={9} />);
    const notes = await screen.findByTestId("delivery-time-notes");
    expect(notes).toHaveTextContent("does not say when a review closed");
    expect(notes).toHaveTextContent("does not reach back to the start");
    expect(screen.getByRole("region", { name: "Time of the delivery" })).toHaveTextContent(
      "2026-10-16 09:00 UTC to 2026-10-16 11:00 UTC",
    );
  });

  it("shows one unit's split, or names a unit that has not started", async () => {
    renderWithProviders(
      <>
        <DeliveryTimeSplit projectId="demo" benchId={3} seq={9} unitId="B" />
        <DeliveryTimeSplit projectId="demo" benchId={3} seq={9} unitId="C" />
      </>,
    );
    const b = screen.getByRole("region", { name: "Time of unit B" });
    expect(await within(b).findByTestId("unit-time-operator")).toHaveTextContent(
      "10 minutes, 25 percent",
    );
    expect(b).toHaveTextContent("from 2026-10-16 09:20 UTC");
    const c = screen.getByRole("region", { name: "Time of unit C" });
    expect(within(c).getByText("Unit C has not started.")).toBeInTheDocument();
    // The delivery and its units share one read.
    expect(api.fetchDeliveryTime).toHaveBeenCalledTimes(1);
  });

  it("does not call a unit unstarted when the history is cut short", async () => {
    const zero = { agent: 0, operator: 0, gate: 0, no_session: 0 };
    const at = "2026-10-16T09:00:00.000Z";
    vi.mocked(api.fetchDeliveryTime).mockResolvedValue(
      split({
        notes: { historyTruncated: true, reviewCloseInferred: false },
        units: [{ unitId: "C", from: at, to: at, totalMs: 0, parts: zero }],
      }),
    );
    renderWithProviders(<DeliveryTimeSplit projectId="demo" benchId={3} seq={9} unitId="C" />);
    const c = screen.getByRole("region", { name: "Time of unit C" });
    expect(
      await within(c).findByText("Unit C has no time in the event history."),
    ).toBeInTheDocument();
    // A span with no time names no start.
    expect(c).not.toHaveTextContent("from 2026");
  });

  it("reads an open split again on a timer, and an ended one no more", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { unmount } = renderWithProviders(
        <DeliveryTimeSplit projectId="demo" benchId={3} seq={9} />,
      );
      await screen.findByTestId("delivery-time-agent");
      await vi.advanceTimersByTimeAsync(DELIVERY_TIME_REFETCH_MS + 1_000);
      expect(api.fetchDeliveryTime).toHaveBeenCalledTimes(2);
      unmount();

      vi.mocked(api.fetchDeliveryTime).mockClear();
      vi.mocked(api.fetchDeliveryTime).mockResolvedValue(split({ open: false }));
      renderWithProviders(<DeliveryTimeSplit projectId="demo" benchId={3} seq={9} />);
      await screen.findByTestId("delivery-time-agent");
      await vi.advanceTimersByTimeAsync(3 * DELIVERY_TIME_REFETCH_MS);
      expect(api.fetchDeliveryTime).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why when the split cannot be read", async () => {
    vi.mocked(api.fetchDeliveryTime).mockRejectedValue(new Error("record missing"));
    renderWithProviders(<DeliveryTimeSplit projectId="demo" benchId={3} seq={9} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The time split could not be read: record missing",
    );
  });

  it("adds no Tab stop", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <button type="button">before</button>
        <DeliveryTimeSplit projectId="demo" benchId={3} seq={9} />
        <button type="button">after</button>
      </>,
    );
    await screen.findByTestId("delivery-time-agent");
    await user.tab();
    expect(screen.getByRole("button", { name: "before" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  for (const theme of THEMES) {
    it(`has no axe findings in ${theme}`, async () => {
      vi.mocked(api.fetchDeliveryTime).mockResolvedValue(
        split({ notes: { historyTruncated: true, reviewCloseInferred: true } }),
      );
      const { container } = renderInTheme(
        <QueryClientProvider client={makeQueryClient()}>
          <DeliveryTimeSplit projectId="demo" benchId={3} seq={9} />
          <DeliveryTimeSplit projectId="demo" benchId={3} seq={9} unitId="B" />
        </QueryClientProvider>,
        theme,
      );
      await screen.findByTestId("delivery-time-notes");
      await screen.findByTestId("unit-time-agent");
      expectNoAxeFindings(await axe(container));
    });
  }
});
