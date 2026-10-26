// The delivery-jam notification raised from accepted events (SB-FR-019).
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
import { applyDeliveryJamNotifications } from "./delivery-jam.js";

function event(
  seq: number,
  type: string,
  unitId: string | undefined,
  payload: Record<string, unknown>,
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyDeliveryJamNotifications", () => {
  it("SB-TC-047: raises a delivery-jam keyed by the unit for each status word that reads as jammed", () => {
    const bench = makeBench();
    applyDeliveryJamNotifications(bench, [
      event(8, "unit.changed", "B", { status: "jammed" }),
      event(9, "unit.changed", "C", { status: "blocked" }),
    ]);
    expect(vi.mocked(notification.createNotification).mock.calls).toEqual([
      [bench, "delivery-jam", undefined, { unitId: "B", status: "jammed" }, undefined, undefined, "B"],
      [
        bench,
        "delivery-jam",
        undefined,
        { unitId: "C", status: "blocked" },
        undefined,
        undefined,
        "C",
      ],
    ]);
    expect(notification.dismissByKey).not.toHaveBeenCalled();
  });

  it("SB-TC-047: dismisses the unit's delivery-jam when its status no longer reads as jammed", () => {
    const bench = makeBench();
    applyDeliveryJamNotifications(bench, [event(10, "unit.changed", "B", { status: "running" })]);
    expect(notification.dismissByKey).toHaveBeenCalledWith(bench, "delivery-jam", "B");
    expect(notification.createNotification).not.toHaveBeenCalled();
  });

  it("takes only the last status a batch gives a unit", () => {
    const bench = makeBench();
    applyDeliveryJamNotifications(bench, [
      event(8, "unit.changed", "B", { status: "jammed" }),
      event(9, "unit.changed", "B", { status: "running" }),
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
    expect(notification.dismissByKey).toHaveBeenCalledTimes(1);
  });

  it("ignores other event types, a unit.changed with no unit or no status, and the unknown unit.jammed", () => {
    const bench = makeBench();
    applyDeliveryJamNotifications(bench, [
      event(8, "unit.jammed", "B", { status: "jammed" }),
      event(9, "unit.changed", undefined, { status: "jammed" }),
      event(10, "unit.changed", "B", { title: "Second" }),
      event(11, "health.changed", undefined, { status: "blocked" }),
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
    expect(notification.dismissByKey).not.toHaveBeenCalled();
  });
});
