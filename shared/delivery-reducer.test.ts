import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "./delivery-observation-contract.js";
import {
  classifyUnitStatus,
  createDeliveryReducer,
  foldDelivery,
  isDecisionOpen,
  type DeliveryFoldInputs,
  type DeliveryResults,
} from "./delivery-reducer.js";
import type { Case, CaseResult, CaseStatus, TestCasesPlan } from "./testbench-contracts.js";

// ── Fixtures ──

const fixtureRecord = (): DeliveryRecord => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./__fixtures__/delivery-record.json", import.meta.url), "utf8"),
  );
  const parsed = validateDeliveryRecord(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.data;
};

// The fixture's `last_event_seq` is 7, so its stream continues at 8.
let nextSeq = 8;

function event(
  type: string,
  payload: Record<string, unknown>,
  options: { seq?: number; unit_id?: string } = {},
): DeliveryEvent {
  const seq = options.seq ?? nextSeq;
  if (options.seq === undefined) nextSeq += 1;
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts: "2026-10-16T10:00:00Z",
    payload,
    ...(options.unit_id !== undefined ? { unit_id: options.unit_id } : {}),
  };
}

// Build a run of events with consecutive seqs from 8.
function stream(...specs: Array<[string, Record<string, unknown>, string?]>): DeliveryEvent[] {
  nextSeq = 8;
  return specs.map(([type, payload, unit_id]) => event(type, payload, { unit_id }));
}

function planCase(id: string, requirements: string[], level = 1): Case {
  return {
    id,
    title: id,
    area: "demo",
    level,
    type: "functional",
    steps: [],
    tags: [],
    linked_requirement_ids: requirements,
    linked_user_story_ids: [],
  };
}

const PLAN: TestCasesPlan = {
  $schema: "https://roubo.dev/schema/testbench/test-cases/v1.2.0.json",
  schemaVersion: "1.2.0",
  specSlug: "demo",
  cases: [
    planCase("DEMO-TC-001", ["DEMO-FR-001"]),
    planCase("DEMO-TC-002", ["DEMO-FR-001", "DEMO-FR-002"]),
    planCase("DEMO-TC-003", ["DEMO-FR-002"]),
  ],
};

const author = { name: "Ada", email: "ada@example.com" };

function caseResult(derived: CaseStatus, override?: CaseStatus): CaseResult {
  return {
    observationMarks: {},
    derivedStatus: derived,
    notes: [],
    ...(override
      ? { statusOverride: { status: override, author, timestamp: "2026-01-01T00:00:00Z" } }
      : {}),
  };
}

function results(planHash: string, caseResults: Record<string, CaseResult>): DeliveryResults {
  return { planHash, caseResults, updatedAt: "2026-10-16T09:30:00Z" };
}

// ── The fold ──

describe("foldDelivery", () => {
  it("projects the record alone when there are no events", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({ record, events: [] });
    expect(snapshot.deliveryId).toBe("demo-delivery-1");
    expect(snapshot.seq).toBe(7);
    expect(snapshot.gap).toBeUndefined();
    expect(Object.keys(snapshot.unitsById)).toEqual(["A", "B", "C", "D"]);
    expect(snapshot.stacks).toEqual({ A: ["A", "B", "C"], D: ["D"] });
    expect(snapshot.edges).toEqual([
      { from: "A", to: "B", kind: "depends_on" },
      { from: "B", to: "C", kind: "depends_on" },
      { from: "A", to: "B", kind: "stack" },
      { from: "B", to: "C", kind: "stack" },
    ]);
    expect(Object.keys(snapshot.gatesById)).toEqual(["gate-after-b", "gate-after-c"]);
    expect(snapshot.decisionsById["decision-1"]?.status).toBe("open");
    expect(snapshot.steeringById["steering-1"]?.note).toBe("Keep the fixture ids neutral.");
    expect(snapshot.budget).toEqual(record.budget);
    expect(snapshot.roles).toEqual(record.roles);
    expect(snapshot.health.status).toBe("ok");
    expect(snapshot.jams).toEqual([]);
    expect(snapshot.drift).toHaveLength(1);
    expect(snapshot.lifecycle.state).toBe("running");
    expect(Object.keys(snapshot.seams)).toEqual(["plan", "results-merge", "gate-status"]);
  });

  it("does not mutate the record or the events", () => {
    const record = fixtureRecord();
    const events = stream(
      ["unit.changed", { status: "done" }, "B"],
      ["budget.changed", { spent_usd: 1.5 }],
      ["drift.detected", { kind: "worktree", detail: "stray commit" }, "C"],
    );
    const recordBefore = JSON.stringify(record);
    const eventsBefore = JSON.stringify(events);
    foldDelivery({ record, events, plan: PLAN });
    expect(JSON.stringify(record)).toBe(recordBefore);
    expect(JSON.stringify(events)).toBe(eventsBefore);
  });

  it("ignores events at or below the record's last_event_seq", () => {
    const record = fixtureRecord();
    const events = [
      event("unit.changed", { status: "jammed" }, { seq: 3, unit_id: "A" }),
      event("unit.changed", { status: "jammed" }, { seq: 7, unit_id: "A" }),
      event("unit.changed", { status: "done" }, { seq: 8, unit_id: "B" }),
    ];
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.unitsById.A.status).toBe("done");
    expect(snapshot.unitsById.B.status).toBe("done");
    expect(snapshot.seq).toBe(8);
    expect(snapshot.gap).toBeUndefined();
  });

  it("sets gap and stops folding when the next seq is not accepted + 1", () => {
    const record = fixtureRecord();
    const events = [
      event("unit.changed", { status: "done" }, { seq: 8, unit_id: "B" }),
      event("unit.changed", { status: "running" }, { seq: 10, unit_id: "C" }),
      event("unit.changed", { status: "done" }, { seq: 11, unit_id: "C" }),
    ];
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.seq).toBe(8);
    expect(snapshot.gap).toEqual({ expected: 9, got: 10 });
    expect(snapshot.unitsById.B.status).toBe("done");
    expect(snapshot.unitsById.C.status).toBe("pending");
  });

  it("skips an event whose type it does not know and still accepts its seq", () => {
    const record = fixtureRecord();
    const events = stream(
      ["review.started", { stack: "A" }],
      ["unit.changed", { status: "done" }, "B"],
    );
    const before = foldDelivery({ record, events: [] });
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.seq).toBe(9);
    expect(snapshot.gap).toBeUndefined();
    expect(snapshot.unitsById.B.status).toBe("done");
    expect({ ...snapshot, seq: 7, unitsById: before.unitsById }).toEqual(before);
  });

  it("ignores a known event whose payload lacks the keys it needs", () => {
    const record = fixtureRecord();
    const events = stream(
      ["unit.changed", { status: "done" }], // no unit_id
      ["unit.changed", { status: "done" }, "ZZ"], // unknown unit
      ["gate.changed", { status: "passed" }], // no gate_id
      ["decision.raised", { decision_id: "d-2", question: "Q?" }], // no options
      ["steering.added", { steering_id: "s-2" }], // no note
      ["drift.detected", { kind: "spec" }], // no detail
      ["seam.ran", { status: "ok" }], // no seam
      ["health.changed", { detail: "x" }], // no status
    );
    const before = foldDelivery({ record, events: [] });
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.seq).toBe(15);
    expect({ ...snapshot, seq: 7 }).toEqual(before);
  });
});

describe("foldDelivery event handlers", () => {
  it("delivery.planned replaces the units, stacks, gates, budget and roles it carries", () => {
    const record = fixtureRecord();
    const events = stream([
      "delivery.planned",
      {
        units: [
          { id: "X", title: "X", status: "pending", stack: "X", layer: 0, depends_on: [] },
          { id: "Y", title: "Y", status: "pending", stack: "X", layer: 1, depends_on: ["X"] },
        ],
        stacks: { X: ["X", "Y"] },
        gates: [{ id: "gate-x", after: ["Y"], status: "pending", cases: ["DEMO-TC-001"] }],
        budget: { estimate_usd: 9 },
        roles: { main: { tier: "fast" } },
      },
    ]);
    const snapshot = foldDelivery({ record, events });
    expect(Object.keys(snapshot.unitsById)).toEqual(["X", "Y"]);
    expect(snapshot.stacks).toEqual({ X: ["X", "Y"] });
    expect(Object.keys(snapshot.gatesById)).toEqual(["gate-x"]);
    expect(snapshot.budget).toEqual({ estimate_usd: 9, soft_budget_usd: 5, spent_usd: 0.42 });
    expect(snapshot.roles.main).toEqual({ tier: "fast" });
    expect(snapshot.roles["unit-coder"]).toEqual({ tier: "fast" });
    expect(snapshot.edges).toEqual([
      { from: "X", to: "Y", kind: "depends_on" },
      { from: "X", to: "Y", kind: "stack" },
    ]);
  });

  it("lifecycle.changed merges the lifecycle fields", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream([
        "lifecycle.changed",
        { state: "ended", armed: false, ended_at: "2026-10-16T11:00:00Z" },
      ]),
    });
    expect(snapshot.lifecycle).toEqual({
      state: "ended",
      armed: false,
      started_at: "2026-10-16T09:00:00Z",
      ended_at: "2026-10-16T11:00:00Z",
    });
  });

  it("unit.changed addresses the unit by the envelope's unit_id and merges the payload", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream(["unit.changed", { status: "jammed", head: "abc123", cost_usd: 0.9 }, "B"]),
    });
    expect(snapshot.unitsById.B).toEqual({
      id: "B",
      title: "Second layer",
      status: "jammed",
      stack: "A",
      layer: 1,
      depends_on: ["A"],
      branch: "demo/1-second",
      head: "abc123",
      cost_usd: 0.9,
    });
    expect(snapshot.jams).toEqual(["B"]);
    expect(snapshot.unitsById.A).toBe(record.units[0]);
  });

  it("gate.changed addresses the gate by payload gate_id and keeps its status word", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream([
        "gate.changed",
        { gate_id: "gate-after-b", status: "provisional", cases: ["DEMO-TC-001"] },
      ]),
    });
    const view = snapshot.gatesById["gate-after-b"];
    expect(view.gate.status).toBe("provisional");
    expect(view.gate.cases).toEqual(["DEMO-TC-001"]);
    expect(view.state.status).toBe("stale");
    expect(view.state.gatingCaseIds).toEqual(["DEMO-TC-001"]);
    expect(snapshot.gatesById["gate-after-c"].gate).toBe(record.stack.gates[1]);
  });

  it("decision.raised adds a decision and decision.answered settles it", () => {
    const record = fixtureRecord();
    const events = stream(
      [
        "decision.raised",
        {
          decision_id: "decision-2",
          question: "One file or two?",
          options: ["one", "two"],
          default: "one",
        },
        "B",
      ],
      ["decision.answered", { decision_id: "decision-2", status: "answered", answer: "two" }],
      ["decision.answered", { decision_id: "decision-1" }],
    );
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.decisionsById["decision-2"]).toEqual({
      id: "decision-2",
      question: "One file or two?",
      options: ["one", "two"],
      default: "one",
      status: "answered",
      raised_at: "2026-10-16T10:00:00Z",
      unit_id: "B",
      answer: "two",
      answered_at: "2026-10-16T10:00:00Z",
    });
    expect(snapshot.decisionsById["decision-1"].status).toBe("answered");
    expect(isDecisionOpen(snapshot.decisionsById["decision-1"])).toBe(false);
  });

  it("steering.added adds a steering note by steering_id or id", () => {
    const record = fixtureRecord();
    const events = stream(
      [
        "steering.added",
        { steering_id: "steering-2", note: "Prefer small commits.", unit_ids: ["C"] },
      ],
      ["steering.added", { id: "steering-3", note: "Applies to all." }],
    );
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.steeringById["steering-2"]).toEqual({
      id: "steering-2",
      note: "Prefer small commits.",
      unit_ids: ["C"],
      created_at: "2026-10-16T10:00:00Z",
    });
    expect(snapshot.steeringById["steering-3"].unit_ids).toEqual([]);
  });

  it("budget.changed merges the numeric fields", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream(["budget.changed", { spent_usd: 2.1 }]),
    });
    expect(snapshot.budget).toEqual({ estimate_usd: 3.2, soft_budget_usd: 5, spent_usd: 2.1 });
  });

  it("health.changed replaces the health status, detail and checked_at", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream(["health.changed", { status: "degraded", detail: "tracker unreachable" }]),
    });
    expect(snapshot.health).toEqual({
      status: "degraded",
      detail: "tracker unreachable",
      checked_at: "2026-10-16T10:00:00Z",
    });
  });

  it("drift.detected appends a drift entry addressed by the envelope's unit_id", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream([
        "drift.detected",
        { kind: "worktree", detail: "a commit no unit made" },
        "C",
      ]),
    });
    expect(snapshot.drift).toHaveLength(2);
    expect(snapshot.drift[1]).toEqual({
      kind: "worktree",
      detail: "a commit no unit made",
      detected_at: "2026-10-16T10:00:00Z",
      unit_id: "C",
    });
    expect(record.drift).toHaveLength(1);
  });

  it("seam.ran sets the named seam's last outcome", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream(
        ["seam.ran", { seam: "results-merge", status: "ok" }],
        [
          "seam.ran",
          {
            seam: "gate-status",
            status: "failed",
            detail: "exit 1",
            last_run_at: "2026-10-16T10:05:00Z",
          },
        ],
      ),
    });
    expect(snapshot.seams["results-merge"]).toEqual({
      status: "ok",
      last_run_at: "2026-10-16T10:00:00Z",
    });
    expect(snapshot.seams["gate-status"]).toEqual({
      status: "failed",
      detail: "exit 1",
      last_run_at: "2026-10-16T10:05:00Z",
    });
    expect(snapshot.seams.plan).toBe(record.seams.plan);
  });
});

describe("foldDelivery gate state and progress (SB-FR-011)", () => {
  it("fails closed without a plan or results: gates stale, nothing met, no totals", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({ record, events: [] });
    expect(snapshot.gatesById["gate-after-b"].state.status).toBe("stale");
    expect(snapshot.gatesById["gate-after-b"].state.coveringUnitIds).toEqual(["B"]);
    expect(snapshot.progress).toEqual({
      cases: { met: 0, total: 0 },
      requirements: { met: 0, total: 0 },
    });
  });

  it("reports totals from the plan but nothing met when results are absent", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({ record, events: [], plan: PLAN });
    expect(snapshot.progress).toEqual({
      cases: { met: 0, total: 3 },
      requirements: { met: 0, total: 2 },
    });
  });

  it("counts cases met and requirements covered from current results, override winning", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: [],
      plan: PLAN,
      results: results(record.plan_hash, {
        "DEMO-TC-001": caseResult("passed"),
        "DEMO-TC-002": caseResult("failed", "passed"),
        "DEMO-TC-003": caseResult("passed", "failed"),
      }),
    });
    expect(snapshot.progress).toEqual({
      cases: { met: 2, total: 3 },
      requirements: { met: 1, total: 2 },
    });
    expect(snapshot.gatesById["gate-after-b"].state.status).toBe("passed");
    expect(snapshot.gatesById["gate-after-c"].state.status).toBe("failed");
  });

  it("reads stale results as nothing met and the gates as stale", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: [],
      plan: PLAN,
      results: results("another-hash", {
        "DEMO-TC-001": caseResult("passed"),
        "DEMO-TC-002": caseResult("passed"),
        "DEMO-TC-003": caseResult("passed"),
      }),
    });
    expect(snapshot.progress.cases).toEqual({ met: 0, total: 3 });
    expect(snapshot.gatesById["gate-after-b"].state.status).toBe("stale");
  });
});

describe("foldDelivery staleness", () => {
  it("reports a null age without now and the age in ms with it", () => {
    const record = fixtureRecord();
    expect(foldDelivery({ record, events: [] }).staleness).toEqual({
      updatedAt: "2026-10-16T09:30:00Z",
      ageMs: null,
    });
    const now = Date.parse("2026-10-16T09:35:00Z");
    expect(foldDelivery({ record, events: [], now }).staleness.ageMs).toBe(5 * 60 * 1000);
    expect(foldDelivery({ record, events: [], now: now - 10 * 60 * 1000 }).staleness.ageMs).toBe(0);
  });
});

describe("classifyUnitStatus", () => {
  it("reads the known words and falls back to other", () => {
    expect(classifyUnitStatus("running")).toBe("running");
    expect(classifyUnitStatus("Done")).toBe("done");
    expect(classifyUnitStatus("jammed")).toBe("jammed");
    expect(classifyUnitStatus("blocked")).toBe("jammed");
    expect(classifyUnitStatus("skipped")).toBe("skipped");
    expect(classifyUnitStatus("pending")).toBe("pending");
    expect(classifyUnitStatus("reviewing")).toBe("other");
  });
});

// ── The memoised reducer ──

describe("createDeliveryReducer", () => {
  const inputs = (record: DeliveryRecord, events: DeliveryEvent[]): DeliveryFoldInputs => ({
    record,
    events,
    plan: PLAN,
  });

  it("folds only the pending events when the list extends the one it folded", () => {
    const record = fixtureRecord();
    const reducer = createDeliveryReducer();
    const first = stream(["unit.changed", { status: "done" }, "B"]);
    const second = [
      ...first,
      event("unit.changed", { status: "running" }, { seq: 9, unit_id: "C" }),
    ];
    const one = reducer.fold(inputs(record, first));
    const two = reducer.fold(inputs(record, second));
    expect(one.seq).toBe(8);
    expect(two.seq).toBe(9);
    expect(two.unitsById.C.status).toBe("running");
    // The untouched groups are reused by reference: no refold from the record.
    expect(two.unitsById.B).toBe(one.unitsById.B);
    expect(two.decisionsById).toBe(one.decisionsById);
    expect(two).toEqual(foldDelivery(inputs(record, second)));
  });

  it("gives the same result as foldDelivery when the caller pushes onto the same array", () => {
    const record = fixtureRecord();
    const reducer = createDeliveryReducer();
    const events = stream(["unit.changed", { status: "done" }, "B"]);
    const one = reducer.fold(inputs(record, events));
    expect(one.seq).toBe(8);
    events.push(event("unit.changed", { status: "running" }, { seq: 9, unit_id: "C" }));
    const two = reducer.fold(inputs(record, events));
    expect(two.seq).toBe(9);
    expect(two.unitsById.C.status).toBe("running");
    expect(two).toEqual(foldDelivery(inputs(record, events)));
    events.push(event("budget.changed", { spent_usd: 4 }, { seq: 10 }));
    const three = reducer.fold(inputs(record, events));
    expect(three.seq).toBe(10);
    expect(three.budget.spent_usd).toBe(4);
    expect(three).toEqual(foldDelivery(inputs(record, events)));
  });

  it("hits the memo for a rebuilt list whose events are equal by seq and content", () => {
    const record = fixtureRecord();
    const reducer = createDeliveryReducer();
    const build = () =>
      stream(["unit.changed", { status: "done" }, "B"], ["budget.changed", { spent_usd: 2 }]);
    const one = reducer.fold(inputs(record, build()));
    const rebuilt = [
      ...build(),
      event("unit.changed", { status: "running" }, { seq: 10, unit_id: "C" }),
    ];
    const two = reducer.fold(inputs(record, rebuilt));
    expect(two.unitsById.B).toBe(one.unitsById.B);
    expect(two.seq).toBe(10);
    expect(two).toEqual(foldDelivery(inputs(record, rebuilt)));
  });

  it("misses the memo and refolds from the record when the prefix changed", () => {
    const record = fixtureRecord();
    const reducer = createDeliveryReducer();
    const first = stream(["unit.changed", { status: "done" }, "B"]);
    const one = reducer.fold(inputs(record, first));
    expect(one.unitsById.B.status).toBe("done");
    const changed = stream(["unit.changed", { status: "jammed" }, "B"]);
    const two = reducer.fold(inputs(record, changed));
    expect(two.unitsById.B.status).toBe("jammed");
    expect(two.jams).toEqual(["B"]);
    expect(two).toEqual(foldDelivery(inputs(record, changed)));
  });

  it("refolds from the record when the record itself moved", () => {
    const record = fixtureRecord();
    const reducer = createDeliveryReducer();
    const events = stream(["unit.changed", { status: "done" }, "B"]);
    reducer.fold(inputs(record, events));
    const moved: DeliveryRecord = {
      ...record,
      last_event_seq: 8,
      updated_at: "2026-10-16T10:00:00Z",
      units: record.units.map((unit) => (unit.id === "B" ? { ...unit, status: "done" } : unit)),
    };
    const later = [event("unit.changed", { status: "running" }, { seq: 9, unit_id: "C" })];
    const snapshot = reducer.fold(inputs(moved, later));
    expect(snapshot.seq).toBe(9);
    expect(snapshot.unitsById.B.status).toBe("done");
    expect(snapshot.unitsById.C.status).toBe("running");
    expect(snapshot).toEqual(foldDelivery(inputs(moved, later)));
  });

  it("does not remember a fold that ended in a gap", () => {
    const record = fixtureRecord();
    const reducer = createDeliveryReducer();
    const withGap = [
      event("unit.changed", { status: "done" }, { seq: 8, unit_id: "B" }),
      event("unit.changed", { status: "running" }, { seq: 10, unit_id: "C" }),
    ];
    expect(reducer.fold(inputs(record, withGap)).gap).toEqual({ expected: 9, got: 10 });
    const healed = [
      withGap[0],
      event("unit.changed", { status: "running" }, { seq: 9, unit_id: "C" }),
      withGap[1],
    ];
    const snapshot = reducer.fold(inputs(record, healed));
    expect(snapshot.gap).toBeUndefined();
    expect(snapshot.seq).toBe(10);
    expect(snapshot).toEqual(foldDelivery(inputs(record, healed)));
  });

  it("keeps one memo per delivery id and forgets on request", () => {
    const record = fixtureRecord();
    const other: DeliveryRecord = { ...record, delivery_id: "demo-delivery-2" };
    const reducer = createDeliveryReducer();
    const events = stream(["unit.changed", { status: "done" }, "B"]);
    const one = reducer.fold(inputs(record, events));
    reducer.fold(inputs(other, events));
    const two = reducer.fold(inputs(record, events));
    expect(two.unitsById).toBe(one.unitsById);
    reducer.forget("demo-delivery-1");
    const three = reducer.fold(inputs(record, events));
    expect(three.unitsById).not.toBe(one.unitsById);
    expect(three).toEqual(one);
  });
});

// ── Performance ──

describe("foldDelivery performance", () => {
  it("folds a 50-unit record with 1,000 events in under 100 ms", () => {
    const base = fixtureRecord();
    const unitIds = Array.from({ length: 50 }, (_, index) => `U${String(index).padStart(2, "0")}`);
    const record: DeliveryRecord = {
      ...base,
      units: unitIds.map((id, index) => ({
        id,
        title: `Unit ${id}`,
        status: "pending",
        stack: `S${index % 5}`,
        layer: Math.floor(index / 5),
        depends_on: index >= 5 ? [unitIds[index - 5]] : [],
      })),
      stack: {
        stacks: Object.fromEntries(
          Array.from({ length: 5 }, (_, stack) => [
            `S${stack}`,
            unitIds.filter((_, index) => index % 5 === stack),
          ]),
        ),
        gates: Array.from({ length: 5 }, (_, stack) => ({
          id: `gate-${stack}`,
          after: [unitIds[45 + stack]],
          status: "pending",
          cases: PLAN.cases.map((planCase) => planCase.id),
        })),
      },
      last_event_seq: 0,
    };
    const types = [
      (seq: number) =>
        event(
          "unit.changed",
          { status: seq % 3 === 0 ? "done" : "running" },
          { seq, unit_id: unitIds[seq % 50] },
        ),
      (seq: number) => event("budget.changed", { spent_usd: seq / 100 }, { seq }),
      (seq: number) => event("seam.ran", { seam: "plan", status: "ok" }, { seq }),
      (seq: number) =>
        event(
          "decision.raised",
          { decision_id: `d-${seq}`, question: "Q?", options: ["a", "b"], default: "a" },
          { seq, unit_id: unitIds[seq % 50] },
        ),
      (seq: number) => event("drift.detected", { kind: "spec", detail: `change ${seq}` }, { seq }),
      (seq: number) =>
        event("gate.changed", { gate_id: `gate-${seq % 5}`, status: "provisional" }, { seq }),
      (seq: number) => event("unknown.event", { any: seq }, { seq }),
    ];
    const events = Array.from({ length: 1000 }, (_, index) =>
      types[index % types.length](index + 1),
    );
    const started = performance.now();
    const snapshot = foldDelivery({
      record,
      events,
      plan: PLAN,
      results: results(record.plan_hash, {}),
    });
    const elapsed = performance.now() - started;
    expect(snapshot.seq).toBe(1000);
    expect(snapshot.gap).toBeUndefined();
    expect(Object.keys(snapshot.unitsById)).toHaveLength(50);
    expect(elapsed).toBeLessThan(100);
  });
});
