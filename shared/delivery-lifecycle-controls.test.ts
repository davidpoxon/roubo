// The role matrix and the lifecycle readings of a delivery (SB-FR-021,
// SB-FR-022): the reducer folds `roles.applied`, and the shared selectors give
// the routes and the controls one reading of the role matrix, of the states each
// lifecycle action is open in, of the approval's refusal and of the health
// chip's lifecycle word.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "./delivery-observation-contract.js";
import type { DeliveryControl } from "./delivery-control-contract.js";
import { foldDelivery, type DeliveryResults } from "./delivery-reducer.js";
import {
  classifyLifecycleState,
  selectApprovalAvailability,
  selectApprovalRefusal,
  selectCrossCheckBlock,
  selectHealth,
  selectLifecycleAction,
  selectRoleMatrix,
  selectSittingRefusal,
  selectUnmetGates,
} from "./delivery-selectors.js";
import type { CaseResult, TestCasesPlan } from "./testbench-contracts.js";

function fixtureRecord(): DeliveryRecord {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./__fixtures__/delivery-record.json", import.meta.url), "utf8"),
  );
  const parsed = validateDeliveryRecord(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.data;
}

// The fixture with no review waiting and no provisional gate.
function plainRecord(state = "running"): DeliveryRecord {
  const record = fixtureRecord();
  return {
    ...record,
    review: { status: "none", unreviewed: [] },
    decisions: [],
    stack: {
      ...record.stack,
      gates: record.stack.gates.map((gate) => ({
        id: gate.id,
        after: gate.after,
        status: "pending",
        cases: gate.cases,
      })),
    },
    lifecycle: { ...record.lifecycle, state },
  };
}

function event(seq: number, type: string, payload: Record<string, unknown>): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts: "2026-10-16T10:00:00Z",
    payload,
  };
}

function roleChange(controlSeq: number, role: string, tier: string, status = "pending") {
  return {
    $schema: "https://roubo.dev/schema/delivery-control/v1.0.0.json",
    schemaVersion: "1.0.0",
    delivery_id: "demo-delivery-1",
    control_seq: controlSeq,
    kind: "role-change",
    target_id: role,
    body: { tier },
    durability: "durable",
    issued_at: "2026-10-16T10:00:00Z",
    status,
  } as unknown as DeliveryControl;
}

const PLAN: TestCasesPlan = {
  $schema: "https://roubo.dev/schema/testbench/test-cases/v1.2.0.json",
  schemaVersion: "1.2.0",
  specSlug: "demo",
  cases: ["DEMO-TC-001", "DEMO-TC-002", "DEMO-TC-003"].map((id) => ({
    id,
    title: id,
    area: "demo",
    level: 1,
    type: "functional",
    steps: [],
    tags: [],
    linked_requirement_ids: ["DEMO-FR-001"],
    linked_user_story_ids: [],
  })),
};

const passed: CaseResult = { observationMarks: {}, derivedStatus: "passed", notes: [] };

function results(record: DeliveryRecord, met: readonly string[]): DeliveryResults {
  return {
    planHash: record.plan_hash,
    caseResults: Object.fromEntries(met.map((id) => [id, passed])),
    updatedAt: "2026-10-16T09:30:00Z",
  };
}

describe("roles.applied", () => {
  it("SB-TC-049 a roles.applied makes the payload's tier the role's current tier", () => {
    const record = fixtureRecord();
    const before = foldDelivery({ record, events: [] });
    expect(before.roles["unit-coder"]).toEqual({ tier: "fast" });

    const after = foldDelivery({
      record,
      events: [event(8, "roles.applied", { role: "unit-coder", tier: "large", control_seq: 1 })],
    });
    expect(after.roles["unit-coder"]).toEqual({ tier: "large" });
    expect(after.roles.main).toEqual({ tier: "balanced" });
    // The record the fold read is untouched.
    expect(record.roles["unit-coder"]).toEqual({ tier: "fast" });
  });

  it("SB-TC-049 a roles.applied without a role or a tier is skipped, and a role named __proto__ is a role", () => {
    const record = fixtureRecord();
    const skipped = foldDelivery({
      record,
      events: [
        event(8, "roles.applied", { tier: "large" }),
        event(9, "roles.applied", { role: "unit-coder", tier: "" }),
      ],
    });
    expect(skipped.seq).toBe(9);
    expect(skipped.roles).toEqual(record.roles);

    const odd = foldDelivery({
      record,
      events: [event(8, "roles.applied", { role: "__proto__", tier: "large" })],
    });
    expect(Object.hasOwn(odd.roles, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(odd.roles)).toBe(Object.prototype);
  });
});

describe("role matrix", () => {
  it("SB-TC-049 lists each role with its tier and spend, pending while its role-change control waits, current once read back", () => {
    const record = fixtureRecord();
    record.budget = { ...record.budget, by_role: { "unit-coder": 0.6 } };
    const pending = selectRoleMatrix(
      foldDelivery({ record, events: [], controls: [roleChange(1, "unit-coder", "large")] }),
    );
    expect(pending.map((row) => row.role)).toEqual([
      "main",
      "unit-manager",
      "unit-coder",
      "gate-verifier",
    ]);
    expect(pending[2]).toEqual({
      role: "unit-coder",
      tier: "fast",
      pendingTier: "large",
      pendingControlSeq: 1,
      spentUsd: 0.6,
    });
    expect(pending[0]).toMatchObject({ pendingTier: null, spentUsd: null });

    const applied = selectRoleMatrix(
      foldDelivery({
        record,
        events: [event(8, "roles.applied", { role: "unit-coder", tier: "large", control_seq: 1 })],
        controls: [roleChange(1, "unit-coder", "large", "applied")],
      }),
    );
    expect(applied[2]).toMatchObject({ tier: "large", pendingTier: null });
  });
});

describe("lifecycle actions", () => {
  it("SB-FR-022 reads the four lifecycle states case-insensitively, and any other word as other", () => {
    expect(classifyLifecycleState("running")).toBe("running");
    expect(classifyLifecycleState("PAUSED")).toBe("paused");
    expect(classifyLifecycleState("Wound_Down")).toBe("wound_down");
    expect(classifyLifecycleState("complete")).toBe("complete");
    expect(classifyLifecycleState("wound down")).toBe("other");
    expect(classifyLifecycleState("toString")).toBe("other");
  });

  it.each([
    ["running", { pause: true, "wind-down": true, resume: true, approve: true }],
    ["paused", { pause: false, "wind-down": true, resume: true, approve: true }],
    ["wound_down", { pause: false, "wind-down": false, resume: true, approve: true }],
    ["complete", { pause: false, "wind-down": false, resume: false, approve: false }],
    ["archived", { pause: false, "wind-down": false, resume: false, approve: false }],
  ] as const)("SB-FR-022 in the %s state the actions open are %o", (state, open) => {
    const snapshot = foldDelivery({ record: plainRecord(state), events: [] });
    for (const action of ["pause", "wind-down", "resume", "approve"] as const) {
      const availability = selectLifecycleAction(snapshot, action);
      expect(availability.available).toBe(open[action]);
      expect(availability.state).toBe(state);
      if (!open[action]) expect(availability.reason).toContain(state);
    }
  });

  it("SB-FR-022 a lifecycle.changed moves the state an action reads", () => {
    const snapshot = foldDelivery({
      record: plainRecord(),
      events: [event(8, "lifecycle.changed", { state: "wound_down" })],
    });
    expect(selectLifecycleAction(snapshot, "pause")).toEqual({
      available: false,
      state: "wound_down",
      reason: "The delivery is wound_down, so it cannot be paused",
    });
  });
});

describe("approval refusal", () => {
  it("SB-FR-022 refuses with GATING_UNMET while a gate's cases are not all met, and approves once every gating case is met", () => {
    const record = plainRecord();
    const unmet = foldDelivery({
      record,
      events: [],
      plan: PLAN,
      results: results(record, ["DEMO-TC-001", "DEMO-TC-002"]),
    });
    expect(selectUnmetGates(unmet)).toEqual(["gate-after-c"]);
    expect(selectApprovalRefusal(unmet)).toMatchObject({
      code: "GATING_UNMET",
      gates: ["gate-after-c"],
    });

    const met = foldDelivery({
      record,
      events: [],
      plan: PLAN,
      results: results(record, ["DEMO-TC-001", "DEMO-TC-002", "DEMO-TC-003"]),
    });
    expect(selectUnmetGates(met)).toEqual([]);
    expect(selectApprovalRefusal(met)).toBeNull();
  });

  it("SB-FR-022 counts a gate with no plan or results as unmet", () => {
    const snapshot = foldDelivery({ record: plainRecord(), events: [] });
    expect(selectUnmetGates(snapshot)).toEqual(["gate-after-b", "gate-after-c"]);
  });

  it("SB-FR-022 checks the lifecycle state first, then an open review, then the gating cases", () => {
    const record = plainRecord("complete");
    const all = results(record, ["DEMO-TC-001", "DEMO-TC-002", "DEMO-TC-003"]);
    expect(
      selectApprovalRefusal(foldDelivery({ record, events: [], plan: PLAN, results: all })),
    ).toMatchObject({ code: "WRONG_LIFECYCLE_STATE", state: "complete" });

    // The fixture's decisions, with no provisional gate to refuse first.
    const reviewing = foldDelivery({
      record: {
        ...fixtureRecord(),
        stack: plainRecord().stack,
        lifecycle: { ...record.lifecycle, state: "running" },
      },
      events: [event(8, "review.opened", { trigger: "gate", unreviewed: ["decision-2"] })],
    });
    expect(selectApprovalAvailability(reviewing).available).toBe(false);
    expect(selectApprovalRefusal(reviewing)).toMatchObject({
      code: "REVIEW_OPEN",
      unreviewed: ["decision-2"],
    });
  });

  it("SB-TC-082 refuses with PROVISIONAL_UNCONFIRMED naming each provisional gate, after the lifecycle state and the cross-check and before an open review", () => {
    // The fixture states the gate after C as provisional, with a review open.
    const record = { ...fixtureRecord(), lifecycle: { ...plainRecord().lifecycle } };
    const all = results(record, ["DEMO-TC-001", "DEMO-TC-002", "DEMO-TC-003"]);
    const provisional = foldDelivery({
      record,
      events: [event(8, "review.opened", { trigger: "gate", unreviewed: ["decision-2"] })],
      plan: PLAN,
      results: all,
    });
    expect(selectApprovalRefusal(provisional, [])).toEqual({
      code: "PROVISIONAL_UNCONFIRMED",
      reason: expect.stringContaining("gate-after-c") as unknown as string,
      gates: ["gate-after-c"],
    });
    expect(
      selectApprovalRefusal(provisional, [{ class: "head-commit-differs", blocking: true }]),
    ).toMatchObject({ code: "CROSSCHECK_BLOCKED" });
    const complete = foldDelivery({
      record: { ...record, lifecycle: { ...record.lifecycle, state: "complete" } },
      events: [],
    });
    expect(selectApprovalRefusal(complete)).toMatchObject({ code: "WRONG_LIFECYCLE_STATE" });

    // Once the gate is confirmed, the approval passes the check.
    const confirmed = foldDelivery({
      record: { ...record, review: { status: "none", unreviewed: [] }, decisions: [] },
      events: [event(8, "gate.confirmed", { gate_id: "gate-after-c", status: "passed" })],
      plan: PLAN,
      results: all,
    });
    expect(selectApprovalRefusal(confirmed, [])).toBeNull();
  });
});

describe("the cross-check's blocking policy", () => {
  const blocking = [
    { class: "head-commit-differs", blocking: true },
    { class: "record-stale", blocking: false },
    { class: "head-commit-differs", blocking: true },
    { class: "plan-hash-mismatch", blocking: true },
  ];

  it("names each blocking class present once, in list order, and nothing for display-only classes", () => {
    expect(selectCrossCheckBlock(blocking, "approve")).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
      classes: ["head-commit-differs", "plan-hash-mismatch"],
    });
    expect(selectCrossCheckBlock(blocking, "sit")?.reason).toContain("a gate sitting");
    expect(selectCrossCheckBlock([{ class: "record-stale", blocking: false }], "sit")).toBeNull();
    expect(selectCrossCheckBlock(undefined, "approve")).toBeNull();
  });

  it("refuses the approval after the lifecycle state and before an open review or an unmet gate", () => {
    const record = plainRecord();
    const unmet = foldDelivery({ record, events: [] });
    expect(selectApprovalRefusal(unmet, blocking)).toMatchObject({ code: "CROSSCHECK_BLOCKED" });
    expect(selectApprovalRefusal(unmet, [])).toMatchObject({ code: "GATING_UNMET" });
    const complete = foldDelivery({ record: plainRecord("complete"), events: [] });
    expect(selectApprovalRefusal(complete, blocking)).toMatchObject({
      code: "WRONG_LIFECYCLE_STATE",
    });
  });

  it("refuses a sitting for the lifecycle state first, then a blocking class", () => {
    expect(
      selectSittingRefusal(foldDelivery({ record: plainRecord("complete"), events: [] }), blocking),
    ).toMatchObject({ code: "WRONG_LIFECYCLE_STATE", state: "complete" });
    const running = foldDelivery({ record: plainRecord(), events: [] });
    expect(selectSittingRefusal(running, blocking)).toMatchObject({ code: "CROSSCHECK_BLOCKED" });
    expect(selectSittingRefusal(running, [])).toBeNull();
    expect(selectSittingRefusal(foldDelivery({ record: plainRecord("paused"), events: [] }))).toBe(
      null,
    );
  });

  it("SB-FR-039 passes over an entry exempt for the sitting's own gate, and blocks a sitting of another gate and the approval with it", () => {
    const overClaimed = [
      {
        class: "gate-state-differs",
        blocking: true,
        sittingExempt: "gate-after-b",
      },
    ];
    const running = foldDelivery({ record: plainRecord(), events: [] });
    expect(selectSittingRefusal(running, overClaimed, "gate-after-b")).toBeNull();
    expect(selectSittingRefusal(running, overClaimed, "gate-after-c")).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
      classes: ["gate-state-differs"],
    });
    // A sitting that names no gate takes no exemption.
    expect(selectSittingRefusal(running, overClaimed)).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
    });
    expect(selectCrossCheckBlock(overClaimed, "approve", "gate-after-b")).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
      classes: ["gate-state-differs"],
    });
    expect(selectApprovalRefusal(running, overClaimed)).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
      classes: ["gate-state-differs"],
    });

    // An exempt entry beside another blocking entry of the same class still
    // blocks the gate's own sitting through the other one.
    const both = [...overClaimed, { class: "gate-state-differs", blocking: true }];
    expect(selectSittingRefusal(running, both, "gate-after-b")).toMatchObject({
      code: "CROSSCHECK_BLOCKED",
      classes: ["gate-state-differs"],
    });
  });
});

describe("health chip lifecycle word", () => {
  it.each([
    ["paused", "paused"],
    ["WOUND_DOWN", "wound down"],
    ["complete", "complete"],
  ] as const)("SB-TC-050 the chip reads %s as %s, before stale", (state, word) => {
    const snapshot = foldDelivery({
      record: plainRecord(),
      events: [event(8, "lifecycle.changed", { state })],
    });
    const late = Date.parse("2026-10-16T12:00:00Z");
    expect(selectHealth(snapshot, late).word).toBe(word);
    expect(selectHealth(snapshot, late, { disconnected: true }).word).toBe("disconnected");
  });

  it("SB-TC-050 a jam still reads blocked whatever the lifecycle state", () => {
    const record = plainRecord("paused");
    record.units[1] = { ...record.units[1], status: "held" };
    expect(selectHealth(foldDelivery({ record, events: [] })).word).toBe("blocked");
  });

  it("SB-TC-050 a running delivery reads fresh, as before", () => {
    expect(selectHealth(foldDelivery({ record: plainRecord(), events: [] })).word).toBe("fresh");
  });
});
