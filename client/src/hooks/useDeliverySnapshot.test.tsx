// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { useDeliverySnapshot } from "./useDeliverySnapshot";

function record(): DeliveryRecord {
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    spec_slug: "demo",
    plan_hash: "hash",
    mode: { value: "attended", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: { stacks: { A: ["A", "B"] }, gates: [] },
    units: [
      { id: "A", title: "A", status: "running", stack: "A", layer: 0, depends_on: [] },
      { id: "B", title: "B", status: "pending", stack: "A", layer: 1, depends_on: ["A"] },
    ],
    decisions: [],
    steering: [],
    budget: { estimate_usd: 1, soft_budget_usd: 2, spent_usd: 0 },
    roles: { main: { tier: "balanced" } },
    health: { status: "ok", checked_at: "2026-10-16T09:30:00Z" },
    drift: [],
    seams: {},
    lifecycle: { state: "running", armed: true, started_at: "2026-10-16T09:00:00Z" },
    last_event_seq: 7,
    updated_at: "2026-10-16T09:30:00Z",
  };
}

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unit_id?: string,
): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts: "2026-10-16T10:00:00Z",
    payload,
    ...(unit_id !== undefined ? { unit_id } : {}),
  };
}

describe("useDeliverySnapshot", () => {
  it("returns the fold of the record and events it is given, with the age from now", () => {
    const rec = record();
    const events = [event(8, "unit.changed", { status: "done" }, "A")];
    const now = Date.parse("2026-10-16T09:31:00Z");
    const { result } = renderHook(() => useDeliverySnapshot({ record: rec, events }, { now }));
    expect(result.current.seq).toBe(8);
    expect(result.current.unitsById.A.status).toBe("done");
    expect(result.current.staleness.ageMs).toBe(60_000);
    expect(result.current).toEqual(foldDelivery({ record: rec, events, now }));
  });

  it("calls onGap when the fold stops at a seq hole, and not otherwise", () => {
    const rec = record();
    const onGap = vi.fn();
    const { result, rerender } = renderHook(
      ({ events }: { events: DeliveryEvent[] }) =>
        useDeliverySnapshot({ record: rec, events }, { onGap }),
      { initialProps: { events: [event(8, "unit.changed", { status: "done" }, "A")] } },
    );
    expect(onGap).not.toHaveBeenCalled();
    rerender({
      events: [
        event(8, "unit.changed", { status: "done" }, "A"),
        event(10, "unit.changed", { status: "running" }, "B"),
      ],
    });
    expect(result.current.gap).toEqual({ expected: 9, got: 10 });
    expect(onGap).toHaveBeenCalledTimes(1);
    expect(onGap).toHaveBeenCalledWith({ expected: 9, got: 10 }, result.current);
  });

  it("re-folds one step when the event list grows, reusing the untouched groups", () => {
    const rec = record();
    const first = [event(8, "unit.changed", { status: "done" }, "A")];
    const { result, rerender } = renderHook(
      ({ events }: { events: DeliveryEvent[] }) => useDeliverySnapshot({ record: rec, events }),
      { initialProps: { events: first } },
    );
    const one = result.current;
    const second = [...first, event(9, "budget.changed", { spent_usd: 1 })];
    rerender({ events: second });
    expect(result.current.seq).toBe(9);
    expect(result.current.unitsById).toBe(one.unitsById);
    expect(result.current).toEqual(foldDelivery({ record: rec, events: second }));
  });
});
