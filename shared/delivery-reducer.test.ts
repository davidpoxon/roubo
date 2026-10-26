import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
  type DeliverySeam,
  type DeliveryUnit,
} from "./delivery-observation-contract.js";
import {
  classifyUnitStatus,
  createDeliveryReducer,
  foldDelivery,
  isDecisionOpen,
  isProvisionalGate,
  isUnconfirmedProvisionalGate,
  type DeliveryFoldInputs,
  type DeliveryGateView,
  type DeliveryResults,
} from "./delivery-reducer.js";
import { selectProvisionalMarks, selectReviewStack } from "./delivery-selectors.js";
import type { GateLifecycle } from "./gate-evaluator.js";
import type { Resolution } from "./lifecycle-resolver.js";
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

// A lifecycle resolution for one plan case, as `resolvePlan` would return it.
function resolution(
  caseId: string,
  status: Resolution["status"],
  resolvedTo: string | null = null,
): Resolution {
  const origin = { slug: "demo", caseId };
  const target = resolvedTo === null ? null : { slug: "demo", caseId: resolvedTo };
  return {
    origin,
    originState: status === "live" ? "live" : status === "retired" ? "retired" : "superseded",
    status,
    chain: target === null ? [origin] : [origin, target],
    resolvedTo: target,
    reason: status === "unresolved" ? "target missing" : null,
    targetCaseState: status === "resolved" ? "live" : status === "unresolved" ? null : "live",
    targetSpecState: "live",
    supersededBy: null,
  };
}

function lifecycleOf(...resolutions: Resolution[]): GateLifecycle {
  return { resolutions };
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
    expect(snapshot.decisionsById["decision-2"]?.review).toEqual({ status: "unreviewed" });
    expect(snapshot.mode).toEqual({ value: "auto", pending: null });
    expect(snapshot.review).toEqual({ status: "pending", unreviewed: ["decision-2"] });
    expect(snapshot.threadsByDecisionId).toEqual({});
    expect(snapshot.gatesById["gate-after-b"].provisionalAt).toBeNull();
    // A gate the record carries as provisional dates from the record itself.
    expect(snapshot.gatesById["gate-after-c"].provisionalAt).toBe("2026-10-16T09:30:00Z");
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

  it("skips an event whose type names an Object.prototype member and still accepts its seq", () => {
    const record = fixtureRecord();
    const events = stream(
      ["toString", { status: "done" }, "B"],
      ["__proto__", { status: "done" }, "B"],
      ["hasOwnProperty", { status: "done" }, "B"],
      ["valueOf", { status: "done" }, "B"],
      ["constructor", { status: "done" }, "B"],
      ["unit.changed", { status: "done" }, "B"],
    );
    const before = foldDelivery({ record, events: [] });
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.seq).toBe(13);
    expect(snapshot.gap).toBeUndefined();
    expect(snapshot.unitsById.B.status).toBe("done");
    expect({ ...snapshot, seq: 7, unitsById: before.unitsById }).toEqual(before);
  });

  it("ignores an event that addresses a unit, decision or seam by an Object.prototype name", () => {
    const record = fixtureRecord();
    const events = stream(
      ["unit.changed", { status: "done" }, "toString"],
      ["unit.changed", { status: "done" }, "__proto__"],
      ["decision.answered", { decision_id: "constructor", answer: "a" }],
      ["decision.answered", { decision_id: "hasOwnProperty" }],
    );
    const before = foldDelivery({ record, events: [] });
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.seq).toBe(11);
    expect(Object.keys(snapshot.unitsById)).toEqual(["A", "B", "C", "D"]);
    expect(Object.getPrototypeOf(snapshot.unitsById)).toBe(Object.prototype);
    expect({ ...snapshot, seq: 7 }).toEqual(before);
  });

  it("keeps an entity whose id is an Object.prototype name as an own key", () => {
    const record = fixtureRecord();
    const events = stream(
      [
        "delivery.planned",
        {
          units: [
            {
              id: "__proto__",
              title: "P",
              status: "pending",
              stack: "toString",
              layer: 0,
              depends_on: [],
            },
            {
              id: "constructor",
              title: "C",
              status: "running",
              stack: "toString",
              layer: 1,
              depends_on: ["__proto__"],
            },
          ],
          stacks: { toString: ["__proto__", "constructor"] },
          gates: [{ id: "hasOwnProperty", after: ["constructor"], status: "pending", cases: [] }],
          roles: { valueOf: { tier: "fast" } },
        },
      ],
      ["seam.ran", { seam: "toString", status: "ok" }],
      ["unit.changed", { status: "done" }, "constructor"],
    );
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.seq).toBe(10);
    expect(Object.keys(snapshot.unitsById)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(snapshot.unitsById)).toBe(Object.prototype);
    expect(Object.hasOwn(snapshot.unitsById, "constructor")).toBe(true);
    const own = (table: object, key: string): unknown =>
      Object.getOwnPropertyDescriptor(table, key)?.value;
    expect((own(snapshot.unitsById, "constructor") as DeliveryUnit).status).toBe("done");
    expect(Object.keys(snapshot.gatesById)).toEqual(["hasOwnProperty"]);
    expect((own(snapshot.gatesById, "hasOwnProperty") as DeliveryGateView).state.status).toBe(
      "no_gating_cases",
    );
    expect(Object.hasOwn(snapshot.roles, "valueOf")).toBe(true);
    expect((own(snapshot.seams, "toString") as DeliverySeam).status).toBe("ok");
    expect(snapshot.edges).toEqual([
      { from: "__proto__", to: "constructor", kind: "depends_on" },
      { from: "__proto__", to: "constructor", kind: "stack" },
    ]);
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
      ["mode.changed", { pending: "auto" }], // no value
      ["mode.changed", { value: "manual" }], // value outside the vocabulary
      ["decision.decided", { decision_id: "decision-1" }], // no chosen
      ["decision.decided", { decision_id: "decision-1", chosen: "a third option" }], // not an option
      ["decision.decided", { decision_id: "d-9", chosen: "a" }], // unknown and not whole
      ["review.outcome", { status: "accepted" }], // no decision id
      ["review.outcome", { decision_id: "decision-2", status: "seen" }], // outside the vocabulary
      ["review.outcome", { decision_id: "d-9", status: "accepted" }], // unknown decision
      ["review.reply", { decision_id: "decision-2", in_reply_to: "m" }], // no text
      ["gate.provisional", { cases: [] }], // no gate_id
      ["gate.provisional", { gate_id: "gate-after-b" }], // no cases
      [
        "gate.provisional",
        { gate_id: "gate-after-b", cases: [{ case: "DEMO-TC-001", mark: "passed" }] },
      ],
      ["gate.confirmed", { cases: ["DEMO-TC-001"] }], // no gate_id
      ["gate.confirmed", { gate_id: "gate-after-b" }], // not provisional
    );
    const before = foldDelivery({ record, events: [] });
    const snapshot = foldDelivery({ record, events });
    expect(snapshot.seq).toBe(29);
    expect({ ...snapshot, seq: 7 }).toEqual(before);
  });
});

describe("foldDelivery decision-mode handlers (SB-FR-040)", () => {
  it("mode.changed sets the mode in effect and clears or sets the pending mode", () => {
    const record = fixtureRecord();
    const asked = foldDelivery({
      record,
      events: stream(["mode.changed", { value: "auto", pending: "attended" }]),
    });
    expect(asked.mode).toEqual({ value: "auto", pending: "attended" });
    const landed = foldDelivery({
      record,
      events: stream(
        ["mode.changed", { value: "auto", pending: "attended" }],
        ["mode.changed", { value: "attended", control_seq: 3 }],
      ),
    });
    expect(landed.mode).toEqual({ value: "attended", pending: null });
    expect(record.mode).toEqual({ value: "auto", pending: null });
  });

  it("decision.decided settles a raised decision with the agent's choice and queues it for review", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream([
        "decision.decided",
        {
          decision_id: "decision-1",
          chosen: "one file per stack",
          rationale: "The cache is per stack.",
          affected_units: ["B", "C"],
        },
      ]),
    });
    expect(snapshot.decisionsById["decision-1"]).toEqual({
      ...record.decisions[0],
      status: "decided",
      author: "agent",
      chosen: "one file per stack",
      rationale: "The cache is per stack.",
      affected_units: ["B", "C"],
      review: { status: "unreviewed" },
      decided_at: "2026-10-16T10:00:00Z",
    });
    expect(isDecisionOpen(snapshot.decisionsById["decision-1"])).toBe(false);
    expect(snapshot.review).toEqual({
      status: "pending",
      unreviewed: ["decision-2", "decision-1"],
    });
    expect(record.decisions[0].status).toBe("open");
    expect(record.review.unreviewed).toEqual(["decision-2"]);
  });

  it("decision.decided by a named author is an answer, not a review item", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream([
        "decision.decided",
        {
          decision_id: "decision-1",
          chosen: "one file per unit",
          author: "Ada",
          status: "answered",
        },
      ]),
    });
    const decision = snapshot.decisionsById["decision-1"];
    expect(decision.author).toBe("Ada");
    expect(decision.status).toBe("answered");
    expect(decision.review).toBeUndefined();
    expect(snapshot.review.unreviewed).toEqual(["decision-2"]);
  });

  it("decision.decided adds a decision the stream never raised when it comes whole", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream([
        "decision.decided",
        {
          decision_id: "decision-3",
          question: "Tabs or spaces?",
          options: ["tabs", "spaces"],
          default: "spaces",
          chosen: "spaces",
          author: "agent",
        },
        "C",
      ]),
    });
    expect(snapshot.decisionsById["decision-3"]).toEqual({
      id: "decision-3",
      question: "Tabs or spaces?",
      options: ["tabs", "spaces"],
      default: "spaces",
      status: "decided",
      raised_at: "2026-10-16T10:00:00Z",
      unit_id: "C",
      author: "agent",
      chosen: "spaces",
      review: { status: "unreviewed" },
      decided_at: "2026-10-16T10:00:00Z",
    });
    expect(snapshot.review.unreviewed).toEqual(["decision-2", "decision-3"]);
  });

  it("decision.decided by a named author after the agent clears the agent's review state and leaves the stack", () => {
    const record = fixtureRecord();
    // The fixture's decision-2 was decided by the agent and waits unreviewed.
    expect(record.decisions[1].author).toBe("agent");
    const decided = foldDelivery({
      record,
      events: stream([
        "decision.decided",
        { decision_id: "decision-2", chosen: "accept it", author: "David" },
      ]),
    });
    const decision = decided.decisionsById["decision-2"];
    expect(decision.author).toBe("David");
    expect(decision.chosen).toBe("accept it");
    expect(decision.status).toBe("decided");
    expect(decision.review).toBeUndefined();
    expect(decision.rationale).toBeUndefined();
    expect(decision.affected_units).toEqual(["B", "C"]);
    // The list, the status and the stack agree: no decision waits, the fixture's
    // provisional gate still does.
    expect(decided.review).toEqual({ status: "pending", unreviewed: [] });
    expect(selectReviewStack(decided).map((card) => card.id)).toEqual(["gate-after-c"]);

    const settled = foldDelivery({
      record,
      events: stream(
        [
          "decision.decided",
          {
            decision_id: "decision-2",
            chosen: "accept it",
            author: "David",
            rationale: "The operator's files carry them.",
          },
        ],
        ["gate.confirmed", { gate_id: "gate-after-c" }],
      ),
    });
    expect(settled.decisionsById["decision-2"].rationale).toBe("The operator's files carry them.");
    expect(settled.decisionsById["decision-2"].review).toBeUndefined();
    expect(settled.review).toEqual({ status: "none", unreviewed: [] });
    expect(selectReviewStack(settled)).toEqual([]);
    expect(record.decisions[1].review).toEqual({ status: "unreviewed" });
    expect(record.review.unreviewed).toEqual(["decision-2"]);
  });

  it("decision.raised over an agent decision drops it from the unreviewed list and the stack together", () => {
    const record = fixtureRecord();
    expect(record.decisions[1].author).toBe("agent");
    const raised = foldDelivery({
      record,
      events: stream([
        "decision.raised",
        {
          decision_id: "decision-2",
          question: "Accept the change?",
          options: ["accept it", "reject it"],
          default: "accept it",
        },
      ]),
    });
    const decision = raised.decisionsById["decision-2"];
    expect(decision.author).toBeUndefined();
    expect(decision.chosen).toBeUndefined();
    expect(decision.review).toBeUndefined();
    // The list, the status and the stack agree: no decision waits, the fixture's
    // provisional gate still does.
    expect(raised.review.unreviewed).toEqual([]);
    expect(raised.review.status).toBe("pending");
    expect(selectReviewStack(raised).map((card) => card.id)).toEqual(["gate-after-c"]);

    const settled = foldDelivery({
      record,
      events: stream(
        [
          "decision.raised",
          {
            decision_id: "decision-2",
            question: "Accept the change?",
            options: ["accept it", "reject it"],
            default: "accept it",
          },
        ],
        ["gate.confirmed", { gate_id: "gate-after-c" }],
      ),
    });
    expect(settled.review).toEqual({ status: "none", unreviewed: [] });
    expect(selectReviewStack(settled)).toEqual([]);
    expect(record.review.unreviewed).toEqual(["decision-2"]);
  });

  it("decision.answered over an agent decision keeps it in the unreviewed list and the stack together", () => {
    const record = fixtureRecord();
    const answered = foldDelivery({
      record,
      events: stream(["decision.answered", { decision_id: "decision-2", answer: "accept it" }]),
    });
    const decision = answered.decisionsById["decision-2"];
    expect(decision.status).toBe("answered");
    expect(decision.author).toBe("agent");
    expect(decision.review).toEqual({ status: "unreviewed" });
    expect(answered.review.unreviewed).toEqual(["decision-2"]);
    expect(answered.review.status).toBe("pending");
    expect(
      selectReviewStack(answered)
        .filter((card) => card.kind === "decision")
        .map((card) => card.id),
    ).toEqual(["decision-2"]);
  });

  it("review.opened opens the review with its trigger and list", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream(["review.opened", { trigger: "boundary", unreviewed: ["decision-2"] }]),
    });
    expect(snapshot.review).toEqual({
      status: "open",
      trigger: "boundary",
      unreviewed: ["decision-2"],
    });
  });

  it("review.opened reconciles its list with the decisions so the list and the stack agree", () => {
    const record = fixtureRecord();
    // An empty list cannot hide the agent decision that still waits.
    const emptied = foldDelivery({
      record,
      events: stream(["review.opened", { trigger: "boundary", unreviewed: [] }]),
    });
    expect(emptied.review).toEqual({
      status: "open",
      trigger: "boundary",
      unreviewed: ["decision-2"],
    });
    expect(selectReviewStack(emptied).map((card) => card.id)).toEqual([
      "decision-2",
      "gate-after-c",
    ]);

    // An id that names no unreviewed agent decision is dropped, and a decision
    // the agent decided after the list was built joins it.
    const widened = foldDelivery({
      record,
      events: stream(
        ["decision.decided", { decision_id: "decision-1", chosen: "one file per stack" }],
        ["review.opened", { unreviewed: ["decision-1", "decision-9", "decision-1"] }],
      ),
    });
    expect(widened.review).toEqual({ status: "open", unreviewed: ["decision-1", "decision-2"] });
    expect(selectReviewStack(widened).map((card) => card.id)).toEqual([
      "decision-2",
      "gate-after-c",
      "decision-1",
    ]);

    // A review opened once nothing waits settles to none, and a later outcome
    // cannot leave a card behind.
    const nothing = foldDelivery({
      record,
      events: stream(
        ["review.outcome", { decision_id: "decision-2", status: "accepted" }],
        ["gate.confirmed", { gate_id: "gate-after-c" }],
        ["review.opened", { trigger: "manual", unreviewed: ["decision-2"] }],
      ),
    });
    expect(nothing.review).toEqual({ status: "none", trigger: "manual", unreviewed: [] });
    expect(selectReviewStack(nothing)).toEqual([]);
  });

  it("SB-TC-098: a record whose review says none while a card waits folds to a review that names the card", () => {
    const record = fixtureRecord();
    const stale: DeliveryRecord = { ...record, review: { status: "none", unreviewed: [] } };
    // The record is valid as written: the validator checks only that each listed id exists.
    expect(validateDeliveryRecord(stale).ok).toBe(true);
    const snapshot = foldDelivery({ record: stale, events: [] });
    const stack = selectReviewStack(snapshot);
    expect(stack.map((card) => card.id)).toEqual(["decision-2", "gate-after-c"]);
    expect(snapshot.review.unreviewed).toEqual(["decision-2"]);
    expect(snapshot.review.status).not.toBe("none");
    expect(snapshot.review.status).toBe("pending");
    // The list names exactly the decision cards of the stack.
    expect(snapshot.review.unreviewed).toEqual(
      stack.filter((card) => card.kind === "decision").map((card) => card.id),
    );
    expect(stale.review).toEqual({ status: "none", unreviewed: [] });
  });

  it("SB-TC-098: a record whose review lists an accepted decision folds to a list without it", () => {
    const record = fixtureRecord();
    const decisions = record.decisions.map((decision) =>
      decision.id === "decision-2"
        ? { ...decision, review: { status: "accepted" as const, reviewer: "David" } }
        : decision,
    );
    const stale: DeliveryRecord = {
      ...record,
      decisions,
      review: { status: "open", trigger: "boundary", unreviewed: ["decision-2"] },
    };
    expect(validateDeliveryRecord(stale).ok).toBe(true);
    const snapshot = foldDelivery({ record: stale, events: [] });
    expect(snapshot.review.unreviewed).toEqual([]);
    // The provisional gate still waits, so the open review stays open.
    expect(snapshot.review).toEqual({ status: "open", trigger: "boundary", unreviewed: [] });
    expect(selectReviewStack(snapshot).map((card) => card.id)).toEqual(["gate-after-c"]);

    // With the gate confirmed too, nothing waits and the review settles to none.
    const gates = stale.stack.gates.map((gate) =>
      gate.id === "gate-after-c"
        ? {
            ...gate,
            provisionalCases: (gate.provisionalCases ?? []).map((entry) => ({
              ...entry,
              confirmed: true,
            })),
          }
        : gate,
    );
    const settled = foldDelivery({
      record: { ...stale, stack: { ...stale.stack, gates } },
      events: [],
    });
    expect(settled.review).toEqual({ status: "none", trigger: "boundary", unreviewed: [] });
    expect(selectReviewStack(settled)).toEqual([]);
  });

  it("SB-TC-098: the committed record fixture's review section names what its review stack shows", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({ record, events: [] });
    expect(snapshot.review).toEqual(record.review);
    expect(record.review.unreviewed).toEqual(
      selectReviewStack(snapshot)
        .filter((card) => card.kind === "decision")
        .map((card) => card.id),
    );
  });

  it("review.outcome records the operator's verdict, applies an overturn's option and settles the review", () => {
    const record = fixtureRecord();
    const accepted = foldDelivery({
      record,
      events: stream(
        ["review.opened", { trigger: "boundary" }],
        [
          "review.outcome",
          {
            decision_id: "decision-2",
            status: "accepted",
            reviewer: "Ada",
            summary: "Strict is right.",
            control_seq: 4,
          },
        ],
      ),
    });
    expect(accepted.decisionsById["decision-2"].review).toEqual({
      status: "accepted",
      reviewer: "Ada",
      summary: "Strict is right.",
    });
    expect(accepted.decisionsById["decision-2"].chosen).toBe("reject it");
    // gate-after-c is still provisional, so the review stays open.
    expect(accepted.review).toEqual({ status: "open", trigger: "boundary", unreviewed: [] });

    const overturned = foldDelivery({
      record,
      events: stream(
        ["gate.confirmed", { gate_id: "gate-after-c" }],
        [
          "review.outcome",
          { decision_id: "decision-2", status: "overturned", chosen: "accept it" },
        ],
      ),
    });
    expect(overturned.decisionsById["decision-2"].review).toEqual({ status: "overturned" });
    expect(overturned.decisionsById["decision-2"].chosen).toBe("accept it");
    // Nothing waits any more: the review is none.
    expect(overturned.review).toEqual({ status: "none", unreviewed: [] });

    const badOption = foldDelivery({
      record,
      events: stream([
        "review.outcome",
        { decision_id: "decision-2", status: "overturned", chosen: "ignore it" },
      ]),
    });
    expect(badOption.decisionsById["decision-2"].chosen).toBe("reject it");
    expect(badOption.decisionsById["decision-2"].review?.status).toBe("overturned");
  });

  it("review.reply appends to the decision's thread in stream order, with the read-back keys", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream(
        [
          "review.reply",
          { decision_id: "decision-2", text: "Why?", author: "Ada", control_seq: 5 },
        ],
        ["review.reply", { decision_id: "decision-2", text: "Strict grammar.", in_reply_to: "5" }],
        ["review.reply", { decision_id: "decision-1", text: "Hm.", author: "Ada", control_seq: 6 }],
      ),
    });
    expect(snapshot.threadsByDecisionId["decision-2"]).toEqual([
      {
        seq: 8,
        decisionId: "decision-2",
        text: "Why?",
        author: "Ada",
        ts: "2026-10-16T10:00:00Z",
        controlSeq: 5,
      },
      {
        seq: 9,
        decisionId: "decision-2",
        text: "Strict grammar.",
        author: "agent",
        ts: "2026-10-16T10:00:00Z",
        inReplyTo: "5",
      },
    ]);
    expect(snapshot.threadsByDecisionId["decision-1"]).toHaveLength(1);
  });

  it("gate.provisional marks the gate provisional with its cases and dates it from the event", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: stream([
        "gate.provisional",
        {
          gate_id: "gate-after-b",
          cases: [
            { case: "DEMO-TC-001", mark: "met", evidence: "The suite row passed." },
            { case: "DEMO-TC-002", mark: "not_met" },
          ],
        },
      ]),
    });
    const view = snapshot.gatesById["gate-after-b"];
    expect(view.gate).toEqual({
      ...record.stack.gates[0],
      status: "provisional",
      provisionalCases: [
        { case: "DEMO-TC-001", mark: "met", evidence: "The suite row passed.", confirmed: false },
        { case: "DEMO-TC-002", mark: "not_met", evidence: "", confirmed: false },
      ],
    });
    expect(view.provisionalAt).toBe("2026-10-16T10:00:00Z");
    expect(record.stack.gates[0].status).toBe("pending");
    expect(record.stack.gates[0].provisionalCases).toBeUndefined();
  });

  it("a record gate whose status is provisional is provisional on that word alone: dated from the record, on the review stack, with its marks, and confirmable", () => {
    const record = fixtureRecord();
    const gate = record.stack.gates[1];
    expect(gate.status).toBe("provisional");
    expect(Object.keys(gate)).not.toContain("provisional");
    const snapshot = foldDelivery({ record, events: [] });
    const view = snapshot.gatesById["gate-after-c"];
    expect(isProvisionalGate(view.gate)).toBe(true);
    expect(isUnconfirmedProvisionalGate(view.gate)).toBe(true);
    expect(view.provisionalAt).toBe(record.updated_at);
    expect(selectProvisionalMarks(snapshot, "gate-after-c")).toEqual(gate.provisionalCases);
    expect(selectReviewStack(snapshot).map((card) => card.id)).toEqual([
      "decision-2",
      "gate-after-c",
    ]);

    const confirmed = foldDelivery({
      record,
      events: stream(["gate.confirmed", { gate_id: "gate-after-c", control_seq: 3 }]),
    });
    const after = confirmed.gatesById["gate-after-c"];
    expect(after.gate.status).toBe("confirmed");
    expect(after.gate.provisionalCases?.map((entry) => entry.confirmed)).toEqual([true]);
    expect(after.provisionalAt).toBeNull();
    expect(selectProvisionalMarks(confirmed, "gate-after-c")).toEqual([]);
    expect(selectReviewStack(confirmed).map((card) => card.id)).toEqual(["decision-2"]);
  });

  it("gate.changed moves a gate into and out of the provisional state by its status word", () => {
    const record = fixtureRecord();
    const entered = foldDelivery({
      record,
      events: stream(["gate.changed", { gate_id: "gate-after-b", status: "provisional" }]),
    });
    const view = entered.gatesById["gate-after-b"];
    expect(isUnconfirmedProvisionalGate(view.gate)).toBe(true);
    expect(view.provisionalAt).toBe("2026-10-16T10:00:00Z");
    expect(selectReviewStack(entered).map((card) => card.id)).toEqual([
      "decision-2",
      "gate-after-c",
      "gate-after-b",
    ]);

    const left = foldDelivery({
      record,
      events: stream(["gate.changed", { gate_id: "gate-after-c", status: "passed" }]),
    });
    expect(left.gatesById["gate-after-c"].provisionalAt).toBeNull();
    expect(selectProvisionalMarks(left, "gate-after-c")).toEqual([]);
    expect(selectReviewStack(left).map((card) => card.id)).toEqual(["decision-2"]);
    // A gate.confirmed on a gate that is not provisional is a no-op.
    const ignored = foldDelivery({
      record,
      events: stream(["gate.confirmed", { gate_id: "gate-after-b" }]),
    });
    expect(ignored.gatesById["gate-after-b"].gate).toBe(record.stack.gates[0]);
  });

  it("gate.confirmed confirms the named cases, and the gate leaves the provisional state once all are", () => {
    const record = fixtureRecord();
    const partial = foldDelivery({
      record,
      events: stream(
        [
          "gate.provisional",
          {
            gate_id: "gate-after-b",
            cases: [
              { case: "DEMO-TC-001", mark: "met" },
              { case: "DEMO-TC-002", mark: "met" },
            ],
          },
        ],
        ["gate.confirmed", { gate_id: "gate-after-b", cases: ["DEMO-TC-001"], control_seq: 9 }],
      ),
    });
    const partialGate = partial.gatesById["gate-after-b"].gate;
    expect(partialGate.status).toBe("provisional");
    expect(partialGate.provisionalCases?.map((entry) => entry.confirmed)).toEqual([true, false]);
    expect(partial.gatesById["gate-after-b"].provisionalAt).toBe("2026-10-16T10:00:00Z");

    const all = foldDelivery({
      record,
      events: stream(["gate.confirmed", { gate_id: "gate-after-c" }]),
    });
    const gate = all.gatesById["gate-after-c"].gate;
    expect(gate.status).toBe("confirmed");
    const [recordMark] = record.stack.gates[1].provisionalCases ?? [];
    expect(gate.provisionalCases).toEqual([{ ...recordMark, confirmed: true }]);
    expect(all.gatesById["gate-after-c"].provisionalAt).toBeNull();
    // decision-2 still waits, so the review stays pending.
    expect(all.review.status).toBe("pending");

    const withStatus = foldDelivery({
      record,
      events: stream(["gate.confirmed", { gate_id: "gate-after-c", status: "passed" }]),
    });
    expect(withStatus.gatesById["gate-after-c"].gate.status).toBe("passed");
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

  it("delivery.planned settles the review when the gates it replaces change what waits", () => {
    const record = fixtureRecord();
    const gates = [{ id: "gate-x", after: ["B"], status: "pending", cases: ["DEMO-TC-001"] }];
    // The fixture's unconfirmed provisional gate goes; decision-2 still waits.
    const decisionOnly = foldDelivery({
      record,
      events: stream(["delivery.planned", { gates }]),
    });
    expect(decisionOnly.review).toEqual({ status: "pending", unreviewed: ["decision-2"] });
    expect(selectReviewStack(decisionOnly).map((card) => card.id)).toEqual(["decision-2"]);

    // Once the decision is reviewed too, dropping the gate leaves nothing waiting.
    const nothing = foldDelivery({
      record,
      events: stream(
        ["review.outcome", { decision_id: "decision-2", status: "accepted" }],
        ["delivery.planned", { gates }],
      ),
    });
    expect(nothing.review).toEqual({ status: "none", unreviewed: [] });
    expect(selectReviewStack(nothing)).toEqual([]);

    // A new provisional gate in the list makes the review pending again.
    const provisional = foldDelivery({
      record,
      events: stream(
        ["review.outcome", { decision_id: "decision-2", status: "accepted" }],
        ["gate.confirmed", { gate_id: "gate-after-c" }],
        ["delivery.planned", { gates: [{ ...gates[0], status: "provisional" }] }],
      ),
    });
    expect(provisional.review).toEqual({ status: "pending", unreviewed: [] });
    expect(selectReviewStack(provisional).map((card) => card.id)).toEqual(["gate-x"]);
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
      caseList: [],
    });
  });

  it("fails closed to stale without a plan even when current results are present", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: [],
      results: results(record.plan_hash, {
        "DEMO-TC-001": caseResult("passed"),
        "DEMO-TC-002": caseResult("passed"),
        "DEMO-TC-003": caseResult("failed"),
      }),
    });
    expect(snapshot.gatesById["gate-after-b"].state.status).toBe("stale");
    expect(snapshot.gatesById["gate-after-c"].state.status).toBe("stale");
    expect(snapshot.progress).toMatchObject({
      cases: { met: 0, total: 0 },
      requirements: { met: 0, total: 0 },
    });
  });

  it("reports totals from the plan but nothing met when results are absent", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({ record, events: [], plan: PLAN });
    expect(snapshot.progress).toMatchObject({
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
    expect(snapshot.progress).toMatchObject({
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
    // A stale result is not the verify record a case is judged by.
    expect(snapshot.progress.caseList.map((entry) => entry.result)).toEqual([null, null, null]);
  });

  it("SB-TC-022 lists each counted case with its verify record and the unit that met it", () => {
    const record = fixtureRecord();
    const passed = caseResult("passed");
    const failedOverPassed = caseResult("failed", "passed");
    const snapshot = foldDelivery({
      record: {
        ...record,
        units: record.units.map((unit) =>
          unit.id === "B" ? { ...unit, pr_url: "https://github.com/demo/demo/pull/2" } : unit,
        ),
      },
      events: [],
      plan: PLAN,
      results: results(record.plan_hash, {
        "DEMO-TC-001": passed,
        "DEMO-TC-002": failedOverPassed,
        "DEMO-TC-003": caseResult("passed", "failed"),
      }),
    });
    // The counts are the same reading the list carries.
    expect(snapshot.progress.cases).toEqual({ met: 2, total: 3 });
    expect(snapshot.progress.caseList).toEqual([
      {
        id: "DEMO-TC-001",
        met: true,
        result: passed,
        metBy: "B",
        prUrl: "https://github.com/demo/demo/pull/2",
      },
      {
        id: "DEMO-TC-002",
        met: true,
        result: failedOverPassed,
        metBy: "B",
        prUrl: "https://github.com/demo/demo/pull/2",
      },
      {
        id: "DEMO-TC-003",
        met: false,
        result: caseResult("passed", "failed"),
        metBy: null,
        prUrl: null,
      },
    ]);
  });

  it("SB-TC-022 names the last unit in the gate's after list as the unit that met a case", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record: {
        ...record,
        stack: {
          ...record.stack,
          gates: [
            { id: "gate-after-c", after: ["A", "C"], status: "pending", cases: ["DEMO-TC-003"] },
          ],
        },
      },
      events: stream(["unit.changed", { pr_url: "https://github.com/demo/demo/pull/3" }, "C"]),
      plan: PLAN,
      results: results(record.plan_hash, {
        "DEMO-TC-001": caseResult("passed"),
        "DEMO-TC-003": caseResult("passed"),
      }),
    });
    expect(snapshot.unitsById.C.pr_url).toBe("https://github.com/demo/demo/pull/3");
    // Only the case a gate names is counted.
    expect(snapshot.progress.caseList).toEqual([
      {
        id: "DEMO-TC-003",
        met: true,
        result: caseResult("passed"),
        metBy: "C",
        prUrl: "https://github.com/demo/demo/pull/3",
      },
    ]);
  });

  it("SB-TC-022 leaves a passed case that no gate names out of both totals", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record: {
        ...record,
        stack: {
          ...record.stack,
          gates: [{ id: "gate-after-c", after: ["C"], status: "pending", cases: ["DEMO-TC-003"] }],
        },
      },
      events: [],
      plan: PLAN,
      results: results(record.plan_hash, {
        "DEMO-TC-001": caseResult("passed"),
        "DEMO-TC-002": caseResult("passed"),
        "DEMO-TC-003": caseResult("failed"),
      }),
    });
    // TC-001 and TC-002 passed, but no gate names them, so neither enters the
    // stat, and DEMO-FR-001, which only they link, is not counted either.
    expect(snapshot.progress.cases).toEqual({ met: 0, total: 1 });
    expect(snapshot.progress.requirements).toEqual({ met: 0, total: 1 });
    expect(snapshot.progress.caseList.map((entry) => entry.id)).toEqual(["DEMO-TC-003"]);
  });

  it("SB-TC-022 leaves a case its gate's level policy excludes out of both totals", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: [],
      plan: {
        ...PLAN,
        cases: PLAN.cases.map((testCase) =>
          testCase.id === "DEMO-TC-002" ? { ...testCase, level: 3 } : testCase,
        ),
      },
      results: results(record.plan_hash, {
        "DEMO-TC-001": caseResult("passed"),
        "DEMO-TC-002": caseResult("failed"),
        "DEMO-TC-003": caseResult("passed"),
      }),
    });
    // The L3 case is not gating, so its failure neither counts nor blocks a requirement.
    expect(snapshot.progress.cases).toEqual({ met: 2, total: 2 });
    expect(snapshot.progress.requirements).toEqual({ met: 2, total: 2 });
    expect(snapshot.progress.caseList.map((entry) => entry.id)).toEqual([
      "DEMO-TC-001",
      "DEMO-TC-003",
    ]);
    expect(snapshot.gatesById["gate-after-b"].state.status).toBe("passed");
  });

  it("SB-TC-022 counts a gating case the plan lacks as not met, after the plan's cases", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record: {
        ...record,
        stack: {
          ...record.stack,
          gates: [
            {
              id: "gate-after-b",
              after: ["B"],
              status: "pending",
              cases: ["DEMO-TC-404", "DEMO-TC-001"],
            },
          ],
        },
      },
      events: [],
      plan: PLAN,
      results: results(record.plan_hash, { "DEMO-TC-001": caseResult("passed") }),
    });
    expect(snapshot.progress.cases).toEqual({ met: 1, total: 2 });
    expect(snapshot.progress.caseList.map((entry) => [entry.id, entry.met])).toEqual([
      ["DEMO-TC-001", true],
      ["DEMO-TC-404", false],
    ]);
    expect(snapshot.gatesById["gate-after-b"].state.status).toBe("pending");
  });

  it("SB-TC-022 counts a met case's unit with no pull request as having none", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: [],
      plan: PLAN,
      results: results(record.plan_hash, { "DEMO-TC-001": caseResult("passed") }),
    });
    expect(snapshot.progress.caseList[0]).toMatchObject({
      id: "DEMO-TC-001",
      met: true,
      metBy: "B",
      prUrl: null,
    });
  });

  describe("with lifecycle resolutions", () => {
    it("SB-TC-022 drops a retired case from the totals as the gate drops it from its set", () => {
      const record = fixtureRecord();
      const snapshot = foldDelivery({
        record,
        events: [],
        plan: PLAN,
        results: results(record.plan_hash, {
          "DEMO-TC-001": caseResult("passed"),
          "DEMO-TC-003": caseResult("passed"),
        }),
        lifecycle: lifecycleOf(resolution("DEMO-TC-002", "retired")),
      });
      // DEMO-TC-002 leaves both totals: DEMO-FR-002 is then covered by TC-003 alone.
      expect(snapshot.progress).toMatchObject({
        cases: { met: 2, total: 2 },
        requirements: { met: 2, total: 2 },
      });
      expect(snapshot.progress.caseList.map((entry) => entry.id)).toEqual([
        "DEMO-TC-001",
        "DEMO-TC-003",
      ]);
      const gate = snapshot.gatesById["gate-after-b"].state;
      expect(gate.status).toBe("passed");
      expect(gate.gatingCaseIds).toEqual(["DEMO-TC-001"]);
      expect(gate.lifecycleExcludedCaseIds).toEqual(["DEMO-TC-002"]);
    });

    it("reads a superseded case from the case its chain resolved to, as the gate does", () => {
      const record = fixtureRecord();
      const inputs: DeliveryFoldInputs = {
        record,
        events: [],
        plan: PLAN,
        // TC-001 was superseded by TC-002; it has no result of its own.
        results: results(record.plan_hash, {
          "DEMO-TC-002": caseResult("passed"),
          "DEMO-TC-003": caseResult("not_started"),
        }),
        lifecycle: lifecycleOf(resolution("DEMO-TC-001", "resolved", "DEMO-TC-002")),
      };
      const snapshot = foldDelivery(inputs);
      expect(snapshot.progress).toMatchObject({
        cases: { met: 2, total: 3 },
        requirements: { met: 1, total: 2 },
      });
      expect(snapshot.gatesById["gate-after-b"].state.status).toBe("passed");
      expect(snapshot.gatesById["gate-after-c"].state.status).toBe("pending");

      // The landing's own reading decides: a failed landing fails both.
      const failedLanding = foldDelivery({
        ...inputs,
        results: results(record.plan_hash, {
          "DEMO-TC-002": caseResult("failed"),
          "DEMO-TC-003": caseResult("passed"),
        }),
      });
      expect(failedLanding.progress).toMatchObject({
        cases: { met: 1, total: 3 },
        requirements: { met: 0, total: 2 },
      });
      expect(failedLanding.gatesById["gate-after-b"].state.status).toBe("failed");
    });

    it("counts an unresolved case as not met even when its own stale result passed", () => {
      const record = fixtureRecord();
      const snapshot = foldDelivery({
        record,
        events: [],
        plan: PLAN,
        results: results(record.plan_hash, {
          "DEMO-TC-001": caseResult("passed"),
          "DEMO-TC-002": caseResult("passed"),
          "DEMO-TC-003": caseResult("passed"),
        }),
        lifecycle: lifecycleOf(resolution("DEMO-TC-001", "unresolved")),
      });
      expect(snapshot.progress).toMatchObject({
        cases: { met: 2, total: 3 },
        requirements: { met: 1, total: 2 },
      });
      const gate = snapshot.gatesById["gate-after-b"].state;
      expect(gate.status).toBe("pending");
      expect(gate.unresolvedCaseIds).toEqual(["DEMO-TC-001"]);
      expect(snapshot.gatesById["gate-after-c"].state.status).toBe("passed");
    });
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

  it("reads a word that names an Object.prototype member as other", () => {
    expect(classifyUnitStatus("constructor")).toBe("other");
    expect(classifyUnitStatus("toString")).toBe("other");
    expect(classifyUnitStatus("__proto__")).toBe("other");
    expect(classifyUnitStatus("hasOwnProperty")).toBe("other");
    expect(classifyUnitStatus("valueOf")).toBe("other");
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
