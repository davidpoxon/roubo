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
  selectDecisionThread,
  selectGateState,
  selectMode,
  selectNextBoundary,
  selectOpenDecisions,
  selectProgress,
  selectProvisionalMarks,
  selectReview,
  selectReviewStack,
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

describe("delivery selectors: decision mode (SB-FR-040)", () => {
  it("selectMode and selectReview read the mode and the review section", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [event(8, "mode.changed", { value: "auto", pending: "attended" })],
    });
    expect(selectMode(snapshot)).toEqual({ value: "auto", pending: "attended" });
    expect(selectReview(snapshot)).toEqual({ status: "pending", unreviewed: ["decision-2"] });
  });

  it("selectReviewStack lists unreviewed agent cards and provisional gate cards, oldest first", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [
        // Decided at 10:00: younger than the record's provisional gate (09:30)
        // and than decision-2 (decided 09:15).
        event(8, "decision.decided", { decision_id: "decision-1", chosen: "one file per unit" }),
        {
          ...event(9, "gate.provisional", {
            gate_id: "gate-after-b",
            cases: [{ case: "DEMO-TC-001", mark: "met", evidence: "Passed." }],
          }),
          ts: "2026-10-16T09:45:00Z",
        },
      ],
    });
    const stack = selectReviewStack(snapshot);
    expect(stack.map((card) => [card.kind, card.id, card.at])).toEqual([
      ["decision", "decision-2", "2026-10-16T09:15:00Z"],
      ["gate", "gate-after-c", "2026-10-16T09:30:00Z"],
      ["gate", "gate-after-b", "2026-10-16T09:45:00Z"],
      ["decision", "decision-1", "2026-10-16T10:00:00Z"],
    ]);
    const first = stack[0];
    if (first.kind === "decision") expect(first.decision.chosen).toBe("reject it");
    const gate = stack[1];
    if (gate.kind === "gate") {
      expect(gate.gate.provisionalCases?.[0].case).toBe("DEMO-TC-003");
      expect(gate.view.state.status).toBe("stale");
    }
  });

  it("selectReviewStack drops a reviewed decision, a confirmed gate and an operator's answer", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [
        event(8, "review.outcome", { decision_id: "decision-2", status: "accepted" }),
        event(9, "gate.confirmed", { gate_id: "gate-after-c" }),
        event(10, "decision.decided", {
          decision_id: "decision-1",
          chosen: "one file per unit",
          author: "Ada",
        }),
      ],
    });
    expect(selectReviewStack(snapshot)).toEqual([]);
    expect(selectReview(snapshot).status).toBe("none");
  });

  it("selectReviewStack keeps a partly confirmed gate and orders an unparseable time first", () => {
    const record = fixtureRecord();
    record.decisions[1].decided_at = "sometime";
    const snapshot = foldDelivery({
      record,
      events: [
        event(8, "gate.provisional", {
          gate_id: "gate-after-b",
          cases: [
            { case: "DEMO-TC-001", mark: "met" },
            { case: "DEMO-TC-002", mark: "not_met" },
          ],
        }),
        event(9, "gate.confirmed", { gate_id: "gate-after-b", cases: ["DEMO-TC-001"] }),
      ],
    });
    expect(selectReviewStack(snapshot).map((card) => card.id)).toEqual([
      "decision-2",
      "gate-after-c",
      "gate-after-b",
    ]);
  });

  it("selectDecisionThread gives the thread in stream order, empty when there is none", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [
        event(8, "review.reply", { decision_id: "decision-2", text: "Why?", author: "Ada", control_seq: 2 }),
        event(9, "review.reply", { decision_id: "decision-2", text: "Strict.", in_reply_to: "2" }),
      ],
    });
    expect(selectDecisionThread(snapshot, "decision-2").map((m) => [m.author, m.text])).toEqual([
      ["Ada", "Why?"],
      ["agent", "Strict."],
    ]);
    expect(selectDecisionThread(snapshot, "decision-1")).toEqual([]);
    expect(selectDecisionThread(snapshot, "toString")).toEqual([]);
    expect(selectDecisionThread(snapshot, "__proto__")).toEqual([]);
  });

  it("selectProvisionalMarks gives a provisional gate's marks and nothing for any other gate", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({ record, events: [] });
    expect(selectProvisionalMarks(snapshot, "gate-after-c")).toEqual(
      record.stack.gates[1].provisionalCases,
    );
    expect(selectProvisionalMarks(snapshot, "gate-after-b")).toEqual([]);
    expect(selectProvisionalMarks(snapshot, "nope")).toEqual([]);
    expect(selectProvisionalMarks(snapshot, "constructor")).toEqual([]);
    const confirmed = foldDelivery({
      record,
      events: [event(8, "gate.confirmed", { gate_id: "gate-after-c" })],
    });
    // Once confirmed the gate is no longer provisional, so it has no marks to review.
    expect(selectProvisionalMarks(confirmed, "gate-after-c")).toEqual([]);
  });
});
