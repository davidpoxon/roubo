// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";
import * as api from "../lib/api";
import { useDeliveryFeed } from "./useDeliveryFeed";
import { useNotificationStream } from "./useNotificationStream";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, fetchDelivery: vi.fn(), fetchDeliveryEvents: vi.fn() };
});

function snapshot(seq: number, gap?: DeliverySnapshot["gap"]): DeliverySnapshot {
  return { deliveryId: "d1", seq, ...(gap !== undefined && { gap }) } as DeliverySnapshot;
}

function event(seq: number, unitId = "C", deliveryId = "d1"): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: deliveryId,
    type: "unit.changed",
    seq,
    ts: "2026-10-16T09:40:00Z",
    unit_id: unitId,
    payload: { status: "running" },
  };
}

interface MockSource {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  readyState: number;
  close: () => void;
}

let source: MockSource;

beforeEach(() => {
  vi.stubGlobal(
    "EventSource",
    vi.fn(function MockEventSource() {
      source = { onmessage: null, onerror: null, onopen: null, readyState: 1, close: vi.fn() };
      return source;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(api.fetchDelivery).mockReset();
  vi.mocked(api.fetchDeliveryEvents).mockReset();
});

function fireFrame(seq: number): void {
  source.onmessage?.({
    data: JSON.stringify({ type: "delivery", projectId: "p1", benchId: 1, change: "snapshot", seq }),
  } as MessageEvent);
}

describe("useDeliveryFeed", () => {
  it("fetches the snapshot and the unit's events on mount", async () => {
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot(9));
    vi.mocked(api.fetchDeliveryEvents).mockResolvedValue({
      events: [event(8), event(9)],
      acceptedSeq: 9,
    });

    const { result } = renderHookWithProviders(() => useDeliveryFeed("p1", 1, { unit: "C" }));

    await waitFor(() => expect(result.current.snapshot.data?.seq).toBe(9));
    await waitFor(() => expect(result.current.events.data?.acceptedSeq).toBe(9));
    expect(api.fetchDelivery).toHaveBeenCalledTimes(1);
    expect(api.fetchDeliveryEvents).toHaveBeenCalledWith("p1", 1, { unit: "C" });
    expect(result.current.events.data?.events.map((e) => e.seq)).toEqual([8, 9]);
  });

  it("reads the snapshot again and the events whole on a stream gap", async () => {
    vi.mocked(api.fetchDelivery)
      .mockResolvedValueOnce(snapshot(9, { expected: 10, got: 12 }))
      .mockResolvedValue(snapshot(12));
    vi.mocked(api.fetchDeliveryEvents).mockResolvedValue({ events: [event(9)], acceptedSeq: 9 });

    const { result } = renderHookWithProviders(() => useDeliveryFeed("p1", 1));

    await waitFor(() => expect(result.current.snapshot.data?.seq).toBe(12));
    expect(api.fetchDelivery).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot.data?.gap).toBeUndefined();
    // After the reset the list is read with no `after`: none of it is kept.
    await waitFor(() => expect(api.fetchDeliveryEvents).toHaveBeenCalledTimes(2));
    for (const call of vi.mocked(api.fetchDeliveryEvents).mock.calls) {
      expect(call[2]).toEqual({ unit: undefined });
    }
  });

  it("applies a delivery frame: the snapshot is read again and the new events appended", async () => {
    const queryClient = makeQueryClient();
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot(9));
    vi.mocked(api.fetchDeliveryEvents).mockResolvedValue({
      events: [event(8), event(9)],
      acceptedSeq: 9,
    });

    const { result } = renderHookWithProviders(
      () => {
        useNotificationStream();
        return useDeliveryFeed("p1", 1, { unit: "C" });
      },
      { queryClient },
    );
    await waitFor(() => expect(result.current.events.data?.acceptedSeq).toBe(9));

    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot(11));
    vi.mocked(api.fetchDeliveryEvents).mockResolvedValue({ events: [event(11)], acceptedSeq: 11 });
    act(() => fireFrame(11));

    await waitFor(() => expect(result.current.snapshot.data?.seq).toBe(11));
    await waitFor(() => expect(result.current.events.data?.acceptedSeq).toBe(11));
    expect(api.fetchDeliveryEvents).toHaveBeenLastCalledWith("p1", 1, { after: 9, unit: "C" });
    expect(result.current.events.data?.events.map((e) => e.seq)).toEqual([8, 9, 11]);

    // A frame at the seq the client holds changes nothing.
    act(() => fireFrame(11));
    expect(api.fetchDelivery).toHaveBeenCalledTimes(2);
  });

  it("reads the events whole when the bench's log started again", async () => {
    const queryClient = makeQueryClient();
    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot(9));
    vi.mocked(api.fetchDeliveryEvents).mockResolvedValueOnce({
      events: [event(8), event(9)],
      acceptedSeq: 9,
    });

    const { result } = renderHookWithProviders(
      () => {
        useNotificationStream();
        return useDeliveryFeed("p1", 1);
      },
      { queryClient },
    );
    await waitFor(() => expect(result.current.events.data?.acceptedSeq).toBe(9));

    vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot(12));
    vi.mocked(api.fetchDeliveryEvents)
      .mockResolvedValueOnce({ events: [event(10, "C", "d2")], acceptedSeq: 10 })
      .mockResolvedValueOnce({ events: [event(1, "C", "d2"), event(2, "C", "d2")], acceptedSeq: 2 });
    act(() => fireFrame(12));

    await waitFor(() => expect(result.current.events.data?.acceptedSeq).toBe(2));
    expect(result.current.events.data?.events.map((e) => [e.delivery_id, e.seq])).toEqual([
      ["d2", 1],
      ["d2", 2],
    ]);
  });
});
