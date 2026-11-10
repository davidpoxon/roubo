// The delivery outbox reader (#1659): the rows the delivery tooling appends to
// `delivery/outbox.jsonl`, read back as validated events of one delivery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import { forgetDeliveryOutboxCache, readDeliveryOutbox } from "./delivery-outbox.js";

function event(seq: number, deliveryId = "demo-delivery-1"): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: deliveryId,
    type: "unit.changed",
    seq,
    ts: "2026-10-16T09:40:00Z",
    unit_id: "A",
    payload: { status: "running" },
  };
}

function row(envelope: DeliveryEvent, posted = false): string {
  return `${JSON.stringify({ seq: envelope.seq, event: envelope.type, payload: envelope, posted })}\n`;
}

let tmp: string;
let outbox: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-outbox-"));
  outbox = path.join(tmp, "outbox.jsonl");
  forgetDeliveryOutboxCache();
});

afterEach(() => {
  forgetDeliveryOutboxCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readDeliveryOutbox", () => {
  it("answers no events while there is no outbox", () => {
    expect(readDeliveryOutbox(outbox, "demo-delivery-1")).toEqual([]);
  });

  it("reads posted and unposted rows of the delivery, one per seq, in seq order", () => {
    fs.writeFileSync(
      outbox,
      row(event(2), true) + row(event(1)) + row(event(3, "another")) + row(event(2)),
    );

    const events = readDeliveryOutbox(outbox, "demo-delivery-1");

    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("reads the file again once it changed", () => {
    fs.writeFileSync(outbox, row(event(1)));
    expect(readDeliveryOutbox(outbox, "demo-delivery-1")).toHaveLength(1);

    fs.appendFileSync(outbox, row(event(2)));

    expect(readDeliveryOutbox(outbox, "demo-delivery-1").map((e) => e.seq)).toEqual([1, 2]);
  });

  it("reads only the whole rows in the last maxBytes of a large outbox", () => {
    const [, , third, fourth] = [1, 2, 3, 4].map((seq) => row(event(seq)));
    fs.writeFileSync(outbox, [1, 2, 3, 4].map((seq) => row(event(seq))).join(""));
    // The window starts part way through row 3, so row 3 is left out.
    const window = (fourth ?? "").length + Math.floor((third ?? "").length / 2);

    const events = readDeliveryOutbox(outbox, "demo-delivery-1", window);

    expect(events.map((e) => e.seq)).toEqual([4]);
  });
});
