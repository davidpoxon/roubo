// The delivery-decision notification raised from accepted events (SB-FR-014).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";

vi.mock("./notification.js", () => ({
  createNotification: vi.fn(),
  dismissByKey: vi.fn(() => false),
}));

import * as notification from "./notification.js";
import { makeBench } from "../test/fixtures.js";
import { applyDeliveryDecisionNotifications } from "./delivery-decision.js";

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unitId?: string,
): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts: "2026-10-16T10:00:00Z",
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

function raised(seq: number, decisionId: string, unitId?: string): DeliveryEvent {
  return event(
    seq,
    "decision.raised",
    {
      decision_id: decisionId,
      question: `Question of ${decisionId}?`,
      options: ["one", "two"],
      default: "one",
    },
    unitId,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyDeliveryDecisionNotifications", () => {
  it("SB-TC-036: raises a delivery-decision keyed by the decision id for each raised decision", () => {
    const bench = makeBench();
    applyDeliveryDecisionNotifications(bench, [
      raised(8, "decision-1", "A"),
      raised(9, "decision-2"),
    ]);
    expect(vi.mocked(notification.createNotification).mock.calls).toEqual([
      [
        bench,
        "delivery-decision",
        undefined,
        { decisionId: "decision-1", question: "Question of decision-1?", unitId: "A" },
        undefined,
        undefined,
        "decision-1",
      ],
      [
        bench,
        "delivery-decision",
        undefined,
        { decisionId: "decision-2", question: "Question of decision-2?" },
        undefined,
        undefined,
        "decision-2",
      ],
    ]);
    expect(notification.dismissByKey).not.toHaveBeenCalled();
  });

  it("dismisses the decision's notification on an answer or an overturn, and keeps it on a default", () => {
    const bench = makeBench();
    applyDeliveryDecisionNotifications(bench, [
      event(10, "decision.answered", { decision_id: "decision-1", answer: "one" }),
      event(11, "decision.overturned", { id: "decision-2", option: "two" }),
      event(12, "decision.defaulted", { decision_id: "decision-3" }),
    ]);
    expect(vi.mocked(notification.dismissByKey).mock.calls).toEqual([
      [bench, "delivery-decision", "decision-1"],
      [bench, "delivery-decision", "decision-2"],
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
  });

  it("takes only the last event a batch gives a decision", () => {
    const bench = makeBench();
    applyDeliveryDecisionNotifications(bench, [
      raised(8, "decision-1"),
      event(9, "decision.answered", { decision_id: "decision-1", answer: "one" }),
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
    expect(notification.dismissByKey).toHaveBeenCalledTimes(1);
  });

  it("ignores a raise with no decision id or no question, and other event types", () => {
    const bench = makeBench();
    applyDeliveryDecisionNotifications(bench, [
      event(8, "decision.raised", { question: "No id?" }),
      event(9, "decision.raised", { decision_id: "decision-1" }),
      event(10, "decision.answered", {}),
      event(11, "unit.changed", { status: "running" }, "A"),
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
    expect(notification.dismissByKey).not.toHaveBeenCalled();
  });
});
