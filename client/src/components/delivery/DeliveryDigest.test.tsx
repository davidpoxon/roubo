// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench } from "@roubo/shared";
import { deriveDeliveryDigest, type DeliveryDigest } from "@roubo/shared/delivery-digest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { makeQueryClient, renderWithProviders } from "../../test/renderWithProviders";
import { fourUnitRecord } from "../../test/delivery-fixtures";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchDeliveryCrossCheck: vi.fn(),
    fetchDeliveryDigest: vi.fn(),
    markDeliveryDigestSeen: vi.fn(),
    fetchTerminals: vi.fn(),
    fetchDeliveryEvents: vi.fn(),
    fetchDeliveryUnitDiff: vi.fn(),
    fetchDeliveryUnitTranscript: vi.fn(),
  };
});
import * as api from "../../lib/api";
import DeliveryTabPanel from "./DeliveryTabPanel";

const bench = {
  id: 3,
  projectId: "demo",
  variant: "specbench",
  status: "active",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "launch",
} as unknown as Bench;

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unitId?: string,
): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts: "2026-10-16T10:00:00Z",
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

// The record at seq 7, the operator's last view, and a unit done, a decision
// raised and a gate reached since.
const EVENTS = [
  event(8, "unit.changed", { status: "done" }, "A"),
  event(9, "decision.raised", {
    decision_id: "decision-3",
    question: "Keep the cache per unit or per stack?",
    options: ["per unit", "per stack"],
    default: "per unit",
  }),
  event(10, "decision.raised", {
    decision_id: "decision-4",
    question: "Name the flag --fast or --quick?",
    options: ["--fast", "--quick"],
    default: "--fast",
  }),
  event(11, "gate.reached", { gate_id: "gate-after-b" }),
];

function digestAt(lastViewedSeq: number | null, events = EVENTS): DeliveryDigest {
  return deriveDeliveryDigest({ record: fourUnitRecord(), events, lastViewedSeq });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.fetchDelivery).mockResolvedValue(
    foldDelivery({ record: fourUnitRecord(), events: EVENTS }),
  );
  vi.mocked(api.fetchDeliveryCrossCheck).mockResolvedValue({
    disagreements: [],
    refreshedAt: null,
    sourceError: null,
  });
  vi.mocked(api.fetchDeliveryDigest).mockReset();
  vi.mocked(api.markDeliveryDigestSeen).mockReset();
  vi.mocked(api.markDeliveryDigestSeen).mockResolvedValue(undefined);
  vi.mocked(api.fetchTerminals).mockResolvedValue([]);
  vi.mocked(api.fetchDeliveryEvents).mockResolvedValue({ events: [], acceptedSeq: 11 });
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
});

describe("Since-you-left digest", () => {
  it("SB-TC-023 lists the changes since the last view grouped by unit, decision and gate, each linking to its target", async () => {
    vi.mocked(api.fetchDeliveryDigest).mockResolvedValue(digestAt(7));
    const user = userEvent.setup();
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    // Step 2: on reopen the digest lists the three kinds of change.
    const digest = await screen.findByTestId("delivery-digest");
    expect(within(digest).getByTestId("delivery-digest-unit")).toHaveTextContent("Base");
    expect(within(digest).getByTestId("delivery-digest-unit")).toHaveTextContent("running to done");
    expect(within(digest).getByTestId("delivery-digest-decision")).toHaveTextContent(
      "Keep the cache per unit or per stack?",
    );
    expect(within(digest).getByTestId("delivery-digest-gate")).toHaveTextContent("gate-after-b");
    expect(within(digest).queryByTestId("delivery-digest-drift")).not.toBeInTheDocument();
    // A digest with entries is not marked seen until it is dismissed.
    expect(api.markDeliveryDigestSeen).not.toHaveBeenCalled();

    // A unit entry opens the unit's drill-in.
    await user.click(within(digest).getByRole("button", { name: "Open unit A" }));
    expect(await screen.findByRole("region", { name: "Unit A" })).toBeInTheDocument();

    // A gate entry opens the gate's drill-in.
    await user.click(within(digest).getByRole("button", { name: "Open gate gate-after-b" }));
    expect(await screen.findByRole("region", { name: "Gate gate-after-b" })).toBeInTheDocument();

    // A decision entry raises its card to the top of the pile and focuses it.
    await user.click(within(digest).getByRole("button", { name: "Show decision decision-4" }));
    await waitFor(() =>
      expect(screen.getByTestId("decision-card-decision-4")).toHaveAttribute(
        "data-position",
        "top",
      ),
    );
    expect(screen.getByTestId("delivery-decision-pile-target")).toHaveFocus();
  });

  it("SB-TC-023 a dismissed digest does not reappear until new events arrive", async () => {
    vi.mocked(api.fetchDeliveryDigest).mockResolvedValueOnce(digestAt(7));
    vi.mocked(api.fetchDeliveryDigest).mockResolvedValue(digestAt(11));
    const user = userEvent.setup();
    const queryClient = makeQueryClient();
    const first = renderWithProviders(<DeliveryTabPanel bench={bench} />, { queryClient });

    // Step 3: dismiss the digest; it is marked seen at the seq it was read at.
    const digest = await screen.findByTestId("delivery-digest");
    await user.click(within(digest).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.markDeliveryDigestSeen).toHaveBeenCalledWith("demo", 3, 11));
    await waitFor(() => expect(screen.queryByTestId("delivery-digest")).not.toBeInTheDocument());

    // Reopened with no new event, it stays away.
    first.unmount();
    renderWithProviders(<DeliveryTabPanel bench={bench} />, { queryClient });
    await screen.findByTestId("delivery-snapshot");
    await waitFor(() => expect(api.fetchDeliveryDigest).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId("delivery-digest")).not.toBeInTheDocument();
    cleanup();

    // A new event arrives, and the next reopen shows it.
    const later = [...EVENTS, event(12, "unit.changed", { status: "running" }, "B")];
    vi.mocked(api.fetchDelivery).mockResolvedValue(
      foldDelivery({ record: fourUnitRecord(), events: later }),
    );
    vi.mocked(api.fetchDeliveryDigest).mockResolvedValue(digestAt(11, later));
    renderWithProviders(<DeliveryTabPanel bench={bench} />, { queryClient });
    const again = await screen.findByTestId("delivery-digest");
    expect(within(again).getByRole("button", { name: "Open unit B" })).toBeInTheDocument();
    expect(within(again).queryByRole("button", { name: "Open unit A" })).not.toBeInTheDocument();
  });

  it("SB-TC-023 the first view marks the delivery seen, so the next digest starts from it", async () => {
    vi.mocked(api.fetchDeliveryDigest).mockResolvedValue(digestAt(null));
    renderWithProviders(<DeliveryTabPanel bench={bench} />);

    await screen.findByTestId("delivery-snapshot");
    await waitFor(() => expect(api.markDeliveryDigestSeen).toHaveBeenCalledWith("demo", 3, 11));
    expect(api.markDeliveryDigestSeen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("delivery-digest")).not.toBeInTheDocument();
  });
});
