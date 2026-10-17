import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import {
  foldDeliveryJson,
  foldDeliverySnapshot,
  forgetDelivery,
  summarizeDelivery,
} from "./delivery-snapshot.js";

const rawRecord = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;

function rawEvent(
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

describe("foldDeliveryJson", () => {
  it("rejects an invalid record with field-named errors", () => {
    const raw = rawRecord();
    delete raw.budget;
    const result = foldDeliveryJson(raw, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.startsWith("record: budget"))).toBe(true);
    }
  });

  it("rejects an invalid event and names its index", () => {
    const result = foldDeliveryJson(rawRecord(), [
      rawEvent(8, "unit.changed", {}, "B"),
      { seq: 9 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.every((error) => error.startsWith("events.1:"))).toBe(true);
    }
  });

  it("folds a valid record and events, passing the optional inputs through", () => {
    const now = Date.parse("2026-10-16T09:40:00Z");
    const result = foldDeliveryJson(
      rawRecord(),
      [rawEvent(8, "unit.changed", { status: "done" }, "B")],
      { now },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.seq).toBe(8);
      expect(result.snapshot.unitsById.B.status).toBe("done");
      expect(result.snapshot.staleness.ageMs).toBe(10 * 60 * 1000);
    }
  });
});

describe("foldDeliverySnapshot", () => {
  it("returns what foldDelivery returns, through the module's memoised reducer", () => {
    const parsed = validateDeliveryRecord(rawRecord());
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const record = parsed.data;
    const events = [rawEvent(8, "unit.changed", { status: "done" }, "B")];
    const one = foldDeliverySnapshot({ record, events });
    expect(one).toEqual(foldDelivery({ record, events }));
    const more = [...events, rawEvent(9, "budget.changed", { spent_usd: 3 })];
    const two = foldDeliverySnapshot({ record, events: more });
    expect(two.unitsById).toBe(one.unitsById);
    expect(two).toEqual(foldDelivery({ record, events: more }));
    forgetDelivery(record.delivery_id);
    const three = foldDeliverySnapshot({ record, events: more });
    expect(three.unitsById).not.toBe(two.unitsById);
    expect(three).toEqual(two);
  });
});

describe("summarizeDelivery", () => {
  it("condenses a snapshot into counts and the next boundary", () => {
    const result = foldDeliveryJson(rawRecord(), [
      rawEvent(8, "unit.changed", { status: "jammed" }, "D"),
      rawEvent(9, "gate.changed", { gate_id: "gate-after-b", status: "provisional" }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizeDelivery(result.snapshot)).toEqual({
      deliveryId: "demo-delivery-1",
      seq: 9,
      gap: null,
      lifecycle: "running",
      health: "ok",
      units: { total: 4, byStatus: { done: 1, running: 1, pending: 1, jammed: 1 } },
      jams: ["D"],
      gates: {
        "gate-after-b": { status: "provisional", evaluated: "stale" },
        "gate-after-c": { status: "pending", evaluated: "stale" },
      },
      openDecisions: 1,
      nextBoundary: { unitId: "B", kind: "finish" },
      progress: { cases: { met: 0, total: 0 }, requirements: { met: 0, total: 0 } },
      ageMs: null,
    });
  });

  it("counts a status word that names an Object.prototype member as its own key", () => {
    const result = foldDeliveryJson(rawRecord(), [
      rawEvent(8, "unit.changed", { status: "toString" }, "B"),
      rawEvent(9, "unit.changed", { status: "__proto__" }, "C"),
      rawEvent(10, "unit.changed", { status: "constructor" }, "D"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { byStatus, total } = summarizeDelivery(result.snapshot).units;
    expect(total).toBe(4);
    expect(Object.getPrototypeOf(byStatus)).toBe(Object.prototype);
    expect(Object.keys(byStatus).sort()).toEqual(["__proto__", "constructor", "done", "toString"]);
    expect(Object.getOwnPropertyDescriptor(byStatus, "toString")?.value).toBe(1);
    expect(Object.getOwnPropertyDescriptor(byStatus, "__proto__")?.value).toBe(1);
    expect(Object.getOwnPropertyDescriptor(byStatus, "constructor")?.value).toBe(1);
    expect(byStatus.done).toBe(1);
  });

  it("folds an event typed after an Object.prototype member as an unknown type", () => {
    const result = foldDeliveryJson(rawRecord(), [
      rawEvent(8, "toString", { status: "done" }, "B"),
      rawEvent(9, "__proto__", {}),
      rawEvent(10, "hasOwnProperty", {}),
      rawEvent(11, "unit.changed", { status: "done" }, "B"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = summarizeDelivery(result.snapshot);
    expect(summary.seq).toBe(11);
    expect(summary.gap).toBeNull();
    expect(summary.units.byStatus).toEqual({ done: 2, pending: 2 });
  });

  it("carries the gap through", () => {
    const result = foldDeliveryJson(rawRecord(), [
      rawEvent(10, "unit.changed", { status: "done" }, "B"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizeDelivery(result.snapshot).gap).toEqual({ expected: 8, got: 10 });
  });
});
