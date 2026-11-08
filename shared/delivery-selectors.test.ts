import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "./delivery-observation-contract.js";
import { foldDelivery } from "./delivery-reducer.js";
import {
  selectGateState,
  selectNextBoundary,
  selectOpenDecisions,
  selectProgress,
  selectStalenessAge,
  selectSteeringFor,
  selectUnitStack,
  selectUnitStatus,
  selectUnitsInStackOrder,
} from "./delivery-selectors.js";

const fixtureRecord = (): DeliveryRecord => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./__fixtures__/delivery-record.json", import.meta.url), "utf8"),
  );
  const parsed = validateDeliveryRecord(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.data;
};

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

describe("delivery selectors", () => {
  it("selectUnitStatus reads the status word and its kind, null for an unknown unit", () => {
    const snapshot = foldDelivery({ record: fixtureRecord(), events: [] });
    expect(selectUnitStatus(snapshot, "A")).toEqual({ status: "done", kind: "done" });
    expect(selectUnitStatus(snapshot, "B")).toEqual({ status: "running", kind: "running" });
    expect(selectUnitStatus(snapshot, "ZZ")).toEqual({ status: null, kind: null });
  });

  it("selectUnitStatus reads an unknown status word as other", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [event(8, "unit.changed", { status: "reviewing" }, "C")],
    });
    expect(selectUnitStatus(snapshot, "C")).toEqual({ status: "reviewing", kind: "other" });
  });

  it("selectUnitStack gives the stack, layer, members and position", () => {
    const snapshot = foldDelivery({ record: fixtureRecord(), events: [] });
    expect(selectUnitStack(snapshot, "C")).toEqual({
      stack: "A",
      layer: 2,
      members: ["A", "B", "C"],
      index: 2,
    });
    expect(selectUnitStack(snapshot, "D")).toEqual({
      stack: "D",
      layer: 0,
      members: ["D"],
      index: 0,
    });
    expect(selectUnitStack(snapshot, "ZZ")).toBeNull();
  });

  it("selectors read ids and stack names that are Object.prototype member names as absent", () => {
    const snapshot = foldDelivery({ record: fixtureRecord(), events: [] });
    expect(selectUnitStatus(snapshot, "toString")).toEqual({ status: null, kind: null });
    expect(selectUnitStatus(snapshot, "__proto__")).toEqual({ status: null, kind: null });
    expect(selectUnitStack(snapshot, "constructor")).toBeNull();
    expect(selectGateState(snapshot, "hasOwnProperty")).toBeNull();
    expect(selectGateState(snapshot, "valueOf")).toBeNull();
  });

  it("selectUnitStack gives no members for a stack named after an Object.prototype member", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [
        event(8, "unit.changed", { stack: "toString" }, "D"),
        event(9, "unit.changed", { stack: "constructor" }, "C"),
      ],
    });
    expect(selectUnitStack(snapshot, "D")).toEqual({
      stack: "toString",
      layer: 0,
      members: [],
      index: -1,
    });
    expect(selectUnitStack(snapshot, "C")).toEqual({
      stack: "constructor",
      layer: 2,
      members: [],
      index: -1,
    });
  });

  it("selectUnitsInStackOrder skips a listed id that only Object.prototype knows", () => {
    const record = fixtureRecord();
    record.stack.stacks = { A: ["A", "toString", "B", "constructor", "C"] };
    const snapshot = foldDelivery({ record, events: [] });
    expect(selectUnitsInStackOrder(snapshot).map((unit) => unit.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("selectGateState gives the record's gate and its evaluated state", () => {
    const snapshot = foldDelivery({ record: fixtureRecord(), events: [] });
    const view = selectGateState(snapshot, "gate-after-b");
    expect(view?.gate.status).toBe("pending");
    expect(view?.state.status).toBe("stale");
    expect(selectGateState(snapshot, "nope")).toBeNull();
  });

  it("selectProgress returns the cases met and requirements covered counts", () => {
    const snapshot = foldDelivery({ record: fixtureRecord(), events: [] });
    expect(selectProgress(snapshot)).toEqual({
      cases: { met: 0, total: 0 },
      requirements: { met: 0, total: 0 },
    });
  });

  it("selectUnitsInStackOrder walks the stacks base first, then unlisted units", () => {
    const record = fixtureRecord();
    record.stack.stacks = { D: ["D"], A: ["A", "B"] };
    const snapshot = foldDelivery({ record, events: [] });
    expect(selectUnitsInStackOrder(snapshot).map((unit) => unit.id)).toEqual(["D", "A", "B", "C"]);
  });

  it("selectNextBoundary picks the first running unit as a finish boundary with its queue", () => {
    const snapshot = foldDelivery({ record: fixtureRecord(), events: [] });
    const boundary = selectNextBoundary(snapshot);
    expect(boundary?.unitId).toBe("B");
    expect(boundary?.kind).toBe("finish");
    // decision-1 is open but raised by A, so B's queue holds no decision.
    expect(boundary?.decisions).toEqual([]);
    expect(boundary?.steering.map((note) => note.id)).toEqual(["steering-1"]);
  });

  it("selectNextBoundary falls back to the first pending unit as a start boundary", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [
        event(8, "unit.changed", { status: "done" }, "B"),
        event(
          9,
          "decision.raised",
          { decision_id: "d-c", question: "Q?", options: ["a", "b"], default: "a" },
          "C",
        ),
        event(
          10,
          "decision.raised",
          {
            decision_id: "d-c2",
            question: "Q2?",
            options: ["a", "b"],
            default: "a",
            status: "answered",
          },
          "C",
        ),
        event(11, "steering.added", { steering_id: "s-all", note: "Everyone." }),
      ],
    });
    const boundary = selectNextBoundary(snapshot);
    expect(boundary?.unitId).toBe("C");
    expect(boundary?.kind).toBe("start");
    expect(boundary?.decisions.map((decision) => decision.id)).toEqual(["d-c"]);
    expect(boundary?.steering.map((note) => note.id)).toEqual(["steering-1", "s-all"]);
  });

  it("selectNextBoundary is null when no unit is running or pending", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [
        event(8, "unit.changed", { status: "done" }, "B"),
        event(9, "unit.changed", { status: "skipped" }, "C"),
        event(10, "unit.changed", { status: "jammed" }, "D"),
      ],
    });
    expect(selectNextBoundary(snapshot)).toBeNull();
    expect(snapshot.jams).toEqual(["D"]);
  });

  it("selectOpenDecisions and selectSteeringFor filter by unit", () => {
    const snapshot = foldDelivery({ record: fixtureRecord(), events: [] });
    expect(selectOpenDecisions(snapshot).map((decision) => decision.id)).toEqual(["decision-1"]);
    expect(selectOpenDecisions(snapshot, "A").map((decision) => decision.id)).toEqual([
      "decision-1",
    ]);
    expect(selectOpenDecisions(snapshot, "B")).toEqual([]);
    expect(selectSteeringFor(snapshot, "A")).toEqual([]);
    expect(selectSteeringFor(snapshot, "C").map((note) => note.id)).toEqual(["steering-1"]);
  });

  it("selectStalenessAge reads the age the fold computed", () => {
    const record = fixtureRecord();
    expect(selectStalenessAge(foldDelivery({ record, events: [] }))).toBeNull();
    const now = Date.parse("2026-10-16T09:31:00Z");
    expect(selectStalenessAge(foldDelivery({ record, events: [], now }))).toBe(60_000);
  });
});
