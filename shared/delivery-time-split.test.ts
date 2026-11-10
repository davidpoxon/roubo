// Where a delivery's elapsed time went (#1671): the split replays the event
// history and the record's decisions into four states whose parts add up to
// the window, for the delivery and for each started unit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryDecision,
  type DeliveryEvent,
  type DeliveryRecord,
} from "./delivery-observation-contract";
import {
  DELIVERY_TIME_STATES,
  deriveDeliveryTimeSplit,
  type DeliveryTimeSpan,
  type DeliveryTimeSplit,
} from "./delivery-time-split";

const START = Date.parse("2026-10-16T09:00:00Z");
const MIN = 60_000;
const iso = (minutes: number) => new Date(START + minutes * MIN).toISOString();

function fixtureRecord(): DeliveryRecord {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./__fixtures__/delivery-record.json", import.meta.url), "utf8"),
  );
  const parsed = validateDeliveryRecord(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.data;
}

const unitOf = (id: string, status: string) => ({
  id,
  title: id,
  status,
  stack: "S",
  layer: 0,
  depends_on: [],
});

// Units A and B on one stack, a gate after A, no decisions, a live delivery
// that started at minute 0 and has seen events up to `last_event_seq`.
function record(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const base = fixtureRecord();
  const unit = (id: string, status: string) => ({
    id,
    title: id,
    status,
    stack: "S",
    layer: id === "A" ? 0 : 1,
    depends_on: [],
  });
  return {
    ...base,
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { S: ["A", "B"] },
      gates: [{ id: "gate-a", after: ["A"], status: "passed", cases: [] }],
    },
    units: [unit("A", "done"), unit("B", "done")],
    decisions: [],
    lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: null },
    last_event_seq: 0,
    ...overrides,
  };
}

function decision(overrides: Partial<DeliveryDecision>): DeliveryDecision {
  return {
    id: "d1",
    question: "Which one?",
    options: ["this", "that"],
    default: "this",
    status: "answered",
    unit_id: "B",
    raised_at: iso(0),
    ...overrides,
  };
}

// Builds a history whose seq numbers start at `firstSeq`.
function history(
  rows: Array<[minute: number, type: string, payload?: Record<string, unknown>, unit?: string]>,
  firstSeq = 1,
): DeliveryEvent[] {
  return rows.map(([minute, type, payload = {}, unit], index) => ({
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq: firstSeq + index,
    ts: iso(minute),
    payload,
    ...(unit !== undefined ? { unit_id: unit } : {}),
  }));
}

const unitTo = (minute: number, unit: string, status: string) =>
  [minute, "unit.changed", { status }, unit] as [number, string, Record<string, unknown>, string];
const lifecycleTo = (minute: number, state: string) =>
  [minute, "lifecycle.changed", { state }] as [number, string, Record<string, unknown>];
const gateTo = (minute: number, status: string, gate = "gate-a") =>
  [minute, "gate.changed", { gate_id: gate, status }] as [number, string, Record<string, unknown>];

function minutes(span: DeliveryTimeSpan | undefined) {
  if (!span) throw new Error("no span");
  return {
    total: span.totalMs / MIN,
    agent: span.parts.agent / MIN,
    operator: span.parts.operator / MIN,
    gate: span.parts.gate / MIN,
    no_session: span.parts.no_session / MIN,
  };
}

function expectSums(split: DeliveryTimeSplit) {
  for (const span of [split, ...split.units]) {
    const sum = DELIVERY_TIME_STATES.reduce((total, state) => total + span.parts[state], 0);
    expect(sum).toBe(span.totalMs);
  }
  expect(split.totalMs).toBe(Date.parse(split.to) - Date.parse(split.from));
}

// By default the record has taken in every event of the history, as the
// tooling's record does once it catches up; `behind` keeps the record's own
// `last_event_seq`, so the events above it are folded on.
function derive(
  rec: DeliveryRecord,
  events: DeliveryEvent[],
  nowMinute = 1_000,
  { behind = false } = {},
) {
  const lastSeq = Math.max(rec.last_event_seq, ...events.map((event) => event.seq));
  const split = deriveDeliveryTimeSplit({
    record: behind ? rec : { ...rec, last_event_seq: lastSeq },
    events,
    now: START + nowMinute * MIN,
  });
  expectSums(split);
  return split;
}

const unitSpan = (split: DeliveryTimeSplit, id: string) =>
  split.units.find((span) => span.unitId === id);

describe("deriveDeliveryTimeSplit", () => {
  it("splits agent work and a gate sitting, for the delivery and each unit", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(60) },
      }),
      history([
        lifecycleTo(0, "running"),
        unitTo(0, "A", "running"),
        unitTo(30, "A", "done"),
        gateTo(45, "passed"),
        unitTo(45, "B", "running"),
        unitTo(60, "B", "done"),
        lifecycleTo(60, "complete"),
      ]),
    );
    expect(split.open).toBe(false);
    expect(minutes(split)).toEqual({ total: 60, agent: 45, operator: 0, gate: 15, no_session: 0 });
    // A's span runs until the gate after it passed.
    expect(minutes(unitSpan(split, "A"))).toEqual({
      total: 45,
      agent: 30,
      operator: 0,
      gate: 15,
      no_session: 0,
    });
    expect(unitSpan(split, "A")?.to).toBe(iso(45));
    expect(minutes(unitSpan(split, "B"))).toMatchObject({ total: 15, agent: 15 });
    expect(split.notes).toEqual({ historyTruncated: false, reviewCloseInferred: false });
  });

  it("counts the time from a wind-down to its resume as no live session", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(60) },
      }),
      history([
        lifecycleTo(0, "running"),
        unitTo(0, "A", "running"),
        lifecycleTo(20, "wound_down"),
        lifecycleTo(35, "paused"),
        lifecycleTo(50, "running"),
        unitTo(60, "A", "done"),
        gateTo(60, "passed"),
        lifecycleTo(60, "complete"),
      ]),
    );
    expect(minutes(split)).toMatchObject({ total: 60, agent: 30, no_session: 30 });
    expect(minutes(unitSpan(split, "A"))).toMatchObject({ total: 60, agent: 30, no_session: 30 });
  });

  it("counts an open decision as waiting only while no agent works", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(50) },
        decisions: [decision({ raised_at: iso(10), decided_at: iso(30) })],
      }),
      history([
        unitTo(0, "A", "running"),
        unitTo(10, "B", "blocked"),
        unitTo(30, "B", "running"),
        unitTo(40, "A", "done"),
        gateTo(40, "passed"),
        unitTo(50, "B", "done"),
      ]),
    );
    // A agent kept working while B waited, so the delivery never stalled.
    expect(minutes(split)).toMatchObject({ total: 50, agent: 50, operator: 0 });
    // B, held by the decision from minute 10 to 30, waited on the operator.
    expect(minutes(unitSpan(split, "B"))).toEqual({
      total: 40,
      agent: 20,
      operator: 20,
      gate: 0,
      no_session: 0,
    });
  });

  it("counts an open decision as waiting when nothing else moves", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(30) },
        decisions: [decision({ unit_id: "A", raised_at: iso(0), decided_at: iso(20) })],
      }),
      history([unitTo(20, "A", "running"), unitTo(30, "A", "done"), gateTo(30, "passed")]),
    );
    expect(minutes(split)).toMatchObject({ total: 30, operator: 20, agent: 10 });
  });

  it("counts a reached gate before an open decision", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(30) },
        decisions: [decision({ unit_id: "A", raised_at: iso(10), decided_at: iso(30) })],
      }),
      history([
        unitTo(0, "A", "running"),
        unitTo(10, "A", "done"),
        gateTo(10, "escalated"),
        gateTo(30, "passed"),
      ]),
    );
    expect(minutes(split)).toMatchObject({ total: 30, agent: 10, gate: 20, operator: 0 });
  });

  it("keeps a failed gate's units at the gate while fix units run elsewhere", () => {
    const rec = record({
      lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(40) },
      units: [...record().units, unitOf("F", "done")],
    });
    const split = derive(
      rec,
      history([
        unitTo(0, "A", "running"),
        unitTo(10, "A", "done"),
        gateTo(20, "failed"),
        unitTo(25, "F", "running"),
        unitTo(35, "F", "done"),
        gateTo(40, "passed"),
      ]),
    );
    expect(minutes(split)).toMatchObject({ total: 40, agent: 20, gate: 20 });
    expect(minutes(unitSpan(split, "A"))).toMatchObject({ total: 40, agent: 10, gate: 30 });
    expect(minutes(unitSpan(split, "F"))).toMatchObject({ total: 10, agent: 10 });
  });

  it("settles a defaulted decision when its default applied, not at a later overturn", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(30) },
        decisions: [
          decision({ status: "overturned", unit_id: "A", raised_at: iso(0), decided_at: iso(25) }),
        ],
      }),
      history([
        [5, "decision.defaulted", { decision_id: "d1" }],
        unitTo(5, "A", "running"),
        [25, "decision.overturned", { decision_id: "d1" }],
        unitTo(30, "A", "done"),
        gateTo(30, "passed"),
      ]),
    );
    expect(minutes(split)).toMatchObject({ operator: 5, agent: 25 });
  });

  it("runs a still open decision and the open window to now", () => {
    const split = derive(
      record({
        units: record().units.map((unit) => ({ ...unit, status: "pending" })),
        stack: { stacks: {}, gates: [] },
        lifecycle: { state: "running", armed: true, started_at: iso(0), ended_at: null },
        decisions: [decision({ status: "open", unit_id: "A", raised_at: iso(5) })],
      }),
      history([lifecycleTo(0, "running")]),
      25,
    );
    expect(split.open).toBe(true);
    expect(split.to).toBe(iso(25));
    expect(minutes(split)).toMatchObject({ total: 25, agent: 5, operator: 20 });
    expect(split.units).toEqual([]);
  });

  describe("reviews", () => {
    const agentDecision = decision({
      id: "d2",
      status: "decided",
      author: "agent",
      chosen: "this",
      unit_id: "A",
      raised_at: iso(5),
      decided_at: iso(5),
    });
    const rows = (withOutcome: boolean) =>
      history([
        unitTo(0, "A", "running"),
        unitTo(10, "A", "done"),
        gateTo(10, "passed"),
        [10, "review.opened", { unreviewed: ["d2"] }],
        ...(withOutcome
          ? [
              [25, "review.outcome", { decision_id: "d2", status: "accepted" }] as [
                number,
                string,
                Record<string, unknown>,
              ],
            ]
          : []),
      ]);

    it("counts an open review as waiting until its last outcome", () => {
      const split = derive(
        record({
          lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(30) },
          decisions: [agentDecision],
        }),
        rows(true),
      );
      expect(minutes(split)).toMatchObject({ total: 30, agent: 15, operator: 15 });
      expect(split.notes.reviewCloseInferred).toBe(false);
    });

    it("runs a review the record still shows open to now", () => {
      const split = derive(
        record({
          review: { status: "open", unreviewed: ["d2"] },
          lifecycle: { state: "running", armed: true, started_at: iso(0), ended_at: null },
          decisions: [agentDecision],
        }),
        rows(false),
        40,
      );
      expect(minutes(split)).toMatchObject({ total: 40, agent: 10, operator: 30 });
    });

    it("says so when a closed review's close time had to be inferred", () => {
      const split = derive(
        record({
          lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(30) },
          decisions: [agentDecision],
        }),
        rows(false),
      );
      expect(minutes(split)).toMatchObject({ operator: 0 });
      expect(split.notes.reviewCloseInferred).toBe(true);
    });
  });

  it("ends a complete delivery whose record dropped ended_at at its completion event", () => {
    const split = derive(
      record(),
      history([unitTo(0, "A", "running"), unitTo(20, "A", "done"), lifecycleTo(20, "complete")]),
    );
    expect(split.to).toBe(iso(20));
    expect(split.open).toBe(false);
  });

  it("reads the record for the state before a truncated history", () => {
    const split = derive(
      record({
        units: [unitOf("A", "running"), unitOf("B", "pending")],
        stack: { stacks: {}, gates: [] },
        lifecycle: { state: "running", armed: true, started_at: iso(0), ended_at: null },
        last_event_seq: 9,
      }),
      history([unitTo(10, "B", "running")], 9),
      20,
    );
    expect(split.notes.historyTruncated).toBe(true);
    // A, which no event of the history moved, held its record status.
    expect(minutes(unitSpan(split, "A"))).toMatchObject({ total: 20, agent: 20 });
    expect(minutes(unitSpan(split, "B"))).toMatchObject({ total: 10, agent: 10 });
  });

  it("keeps a unit that finished before a truncated history, with no time", () => {
    const split = derive(
      record({
        units: [unitOf("A", "done"), unitOf("B", "pending")],
        stack: { stacks: {}, gates: [] },
        lifecycle: { state: "running", armed: true, started_at: iso(0), ended_at: null },
        last_event_seq: 9,
      }),
      history([unitTo(10, "B", "running")], 9),
      20,
    );
    expect(minutes(unitSpan(split, "A"))).toMatchObject({ total: 0 });
    expect(unitSpan(split, "A")?.from).toBe(iso(0));
  });

  it("never lets an event time run backwards", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(20) },
      }),
      history([unitTo(10, "A", "running"), unitTo(5, "A", "done"), gateTo(20, "passed")]),
    );
    expect(minutes(split)).toMatchObject({ total: 20 });
  });

  it("counts a done unit that waits on its gate's other units as at a gate", () => {
    const split = derive(
      record({
        stack: {
          stacks: { S: ["A", "B"] },
          gates: [{ id: "gate-a", after: ["A", "B"], status: "passed", cases: [] }],
        },
      }),
      history([
        unitTo(0, "A", "running"),
        unitTo(0, "B", "running"),
        unitTo(10, "A", "done"),
        unitTo(50, "B", "done"),
        gateTo(50, "passed"),
        lifecycleTo(50, "complete"),
      ]),
    );
    expect(minutes(unitSpan(split, "A"))).toMatchObject({ total: 50, agent: 10, gate: 40 });
    expect(minutes(unitSpan(split, "B"))).toMatchObject({ total: 50, agent: 50 });
  });

  it("confirms only a provisional gate, as the reducer does", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(30) },
      }),
      history([
        unitTo(0, "A", "running"),
        unitTo(10, "A", "done"),
        [20, "gate.confirmed", { gate_id: "gate-a", status: "passed" }],
        [25, "gate.provisional", { gate_id: "gate-a", cases: [{ case: "TC-1", mark: "met" }] }],
        [28, "gate.confirmed", { gate_id: "gate-a", status: "passed" }],
        unitTo(28, "B", "running"),
        unitTo(30, "B", "done"),
      ]),
    );
    // The confirmation at 20 finds no provisional gate; the one at 28 passes it.
    expect(minutes(unitSpan(split, "A"))).toMatchObject({ total: 28, agent: 10, gate: 18 });
  });

  it("passes a gate the truncated history first confirms, as it was provisional before", () => {
    const split = derive(
      record({
        units: [unitOf("A", "done"), unitOf("B", "pending")],
        stack: {
          stacks: {},
          gates: [{ id: "gate-a", after: ["A"], status: "provisional", cases: [] }],
        },
        lifecycle: { state: "running", armed: true, started_at: iso(0), ended_at: null },
        last_event_seq: 9,
      }),
      history(
        [
          [10, "gate.confirmed", { gate_id: "gate-a", status: "passed" }],
          unitTo(10, "B", "running"),
        ],
        10,
      ),
      30,
      { behind: true },
    );
    expect(minutes(unitSpan(split, "A"))).toMatchObject({ total: 10, gate: 10 });
    expect(minutes(split)).toMatchObject({ total: 30, gate: 10, agent: 20 });
  });

  it("ignores a provisional judgement whose marks the reducer would reject", () => {
    const split = derive(
      record({
        lifecycle: { state: "complete", armed: false, started_at: iso(0), ended_at: iso(30) },
      }),
      history([
        unitTo(0, "A", "running"),
        unitTo(10, "A", "done"),
        [15, "gate.provisional", { gate_id: "gate-a", cases: [{ case: "TC-1", mark: "bogus" }] }],
        [20, "gate.confirmed", { gate_id: "gate-a", status: "passed" }],
        gateTo(25, "passed"),
        unitTo(25, "B", "running"),
        unitTo(30, "B", "done"),
      ]),
    );
    // The judgement at 15 is dropped, so the confirmation at 20 finds no
    // provisional gate and A waits until the gate passes at 25.
    expect(minutes(unitSpan(split, "A"))).toMatchObject({ total: 25, agent: 10, gate: 15 });
  });

  describe("with a record behind the event log", () => {
    // Every unit done and the gate passed, so only the decisions, the review
    // and the lifecycle move the split; the record has seen no event yet.
    const quiet = (overrides: Partial<DeliveryRecord> = {}) =>
      record({
        lifecycle: { state: "running", armed: true, started_at: iso(0), ended_at: null },
        ...overrides,
      });

    it("closes a decision the record still shows open at its answer in the log", () => {
      const split = derive(
        quiet({ decisions: [decision({ status: "open" })] }),
        history([[10, "decision.answered", { decision_id: "d1", answer: "this" }]]),
        60,
        { behind: true },
      );
      expect(minutes(split)).toMatchObject({ total: 60, operator: 10, agent: 50 });
    });

    it("counts a decision raised only in the log", () => {
      const split = derive(
        quiet(),
        history([
          [
            0,
            "decision.raised",
            { decision_id: "d9", question: "Q?", options: ["a", "b"], default: "a" },
            "B",
          ],
        ]),
        60,
        { behind: true },
      );
      expect(minutes(split)).toMatchObject({ total: 60, operator: 60, agent: 0 });
    });

    it("ends the window at a completion only the log holds", () => {
      const split = derive(quiet(), history([lifecycleTo(20, "complete")]), 60, {
        behind: true,
      });
      expect(split.open).toBe(false);
      expect(split.to).toBe(iso(20));
      expect(minutes(split)).toMatchObject({ total: 20 });
    });

    it("runs a review opened only in the log to now, with no inferred close", () => {
      const agentDecision = decision({
        id: "d2",
        status: "decided",
        author: "agent",
        chosen: "this",
        unit_id: "A",
        raised_at: iso(5),
        decided_at: iso(5),
      });
      const split = derive(
        quiet({ decisions: [agentDecision] }),
        history([[10, "review.opened", { unreviewed: ["d2"] }]]),
        40,
        { behind: true },
      );
      expect(minutes(split)).toMatchObject({ total: 40, agent: 10, operator: 30 });
      expect(split.notes.reviewCloseInferred).toBe(false);
    });
  });
});
