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
  selectHealth,
  selectLifecycleAction,
  selectRoleMatrix,
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
  it("SB-TC-051 reads the four lifecycle states case-insensitively, and any other word as other", () => {
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
  ] as const)("SB-TC-051 in the %s state the actions open are %o", (state, open) => {
    const snapshot = foldDelivery({ record: plainRecord(state), events: [] });
    for (const action of ["pause", "wind-down", "resume", "approve"] as const) {
      const availability = selectLifecycleAction(snapshot, action);
      expect(availability.available).toBe(open[action]);
      expect(availability.state).toBe(state);
      if (!open[action]) expect(availability.reason).toContain(state);
    }
  });

  it("SB-TC-051 a lifecycle.changed moves the state an action reads", () => {
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
  it("SB-TC-051 refuses with GATING_UNMET while a gate's cases are not all met, and approves once every gating case is met", () => {
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

  it("SB-TC-051 counts a gate with no plan or results as unmet", () => {
    const snapshot = foldDelivery({ record: plainRecord(), events: [] });
    expect(selectUnmetGates(snapshot)).toEqual(["gate-after-b", "gate-after-c"]);
  });

  it("SB-TC-051 checks the lifecycle state first, then an open review, then the gating cases", () => {
    const record = plainRecord("complete");
    const all = results(record, ["DEMO-TC-001", "DEMO-TC-002", "DEMO-TC-003"]);
    expect(
      selectApprovalRefusal(foldDelivery({ record, events: [], plan: PLAN, results: all })),
    ).toMatchObject({ code: "WRONG_LIFECYCLE_STATE", state: "complete" });

    const reviewing = foldDelivery({
      record: { ...fixtureRecord(), lifecycle: { ...record.lifecycle, state: "running" } },
      events: [event(8, "review.opened", { trigger: "gate", unreviewed: ["decision-2"] })],
    });
    expect(selectApprovalAvailability(reviewing).available).toBe(false);
    expect(selectApprovalRefusal(reviewing)).toMatchObject({
      code: "REVIEW_OPEN",
      unreviewed: ["decision-2"],
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
