import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveDeliveryDigest } from "./delivery-digest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
  type DeliveryRecord,
} from "./delivery-observation-contract";

const FIXTURE_RECORD = fileURLToPath(
  new URL("./__fixtures__/delivery-record.json", import.meta.url),
);

function record(): DeliveryRecord {
  return JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
}

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unitId?: string,
): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: record().delivery_id,
    type,
    seq,
    ts: "2026-10-16T10:00:00Z",
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

function keys(entries: readonly { kind: string; id: string }[]): string[] {
  return entries.map((entry) => `${entry.kind}:${entry.id}`);
}

describe("deriveDeliveryDigest", () => {
  const base = record().last_event_seq;

  it("SB-TC-023 lists nothing before the first view, or at the current seq", () => {
    const events = [event(base + 1, "unit.changed", { status: "done" }, "B")];
    expect(deriveDeliveryDigest({ record: record(), events, lastViewedSeq: null })).toEqual({
      lastViewedSeq: null,
      seq: base + 1,
      source: "events",
      entries: [],
    });
    expect(
      deriveDeliveryDigest({ record: record(), events, lastViewedSeq: base + 1 }).entries,
    ).toEqual([]);
  });

  it("SB-TC-023 lists only the changes above the last viewed seq, grouped by unit, decision, gate and drift", () => {
    const events = [
      event(base + 1, "unit.changed", { status: "done" }, "C"),
      event(base + 2, "drift.detected", {
        kind: "spec",
        detail: "prd.md changed",
        summary: "A requirement was reworded",
        detected_at: "2026-10-16T10:00:00Z",
      }),
      event(base + 3, "gate.changed", { gate_id: "gate-after-b", status: "passed" }),
      event(base + 4, "decision.answered", { decision_id: "decision-1", option: "a" }),
      event(base + 5, "unit.changed", { status: "done" }, "B"),
      event(base + 6, "seam.ran", { seam: "plan", status: "ok" }),
    ];
    const digest = deriveDeliveryDigest({ record: record(), events, lastViewedSeq: base + 1 });
    expect(digest.source).toBe("events");
    expect(digest.seq).toBe(base + 6);
    // C changed at or below the last view, so it is not listed.
    expect(keys(digest.entries)).toEqual([
      "unit:B",
      "decision:decision-1",
      "gate:gate-after-b",
      "drift:drift-1",
    ]);
    expect(digest.entries[2]).toMatchObject({
      label: "Gate after B",
      status: "passed",
      previousStatus: "pending",
      events: ["gate.changed"],
    });
    expect(digest.entries[3]).toMatchObject({
      label: "A requirement was reworded",
      status: "spec",
    });
  });

  it("SB-TC-023 lists a gate that an event the fold skips names", () => {
    const events = [event(base + 1, "gate.reached", { gate_id: "gate-after-c" })];
    const digest = deriveDeliveryDigest({ record: record(), events, lastViewedSeq: base });
    expect(keys(digest.entries)).toEqual(["gate:gate-after-c"]);
    expect(digest.entries[0]).toMatchObject({ status: "provisional", events: ["gate.reached"] });
  });

  it("SB-TC-023 reads the record when the log has rolled past the last view", () => {
    const events = [event(base + 1, "unit.changed", { status: "running" }, "D")];
    const digest = deriveDeliveryDigest({ record: record(), events, lastViewedSeq: base - 3 });
    expect(digest.source).toBe("record");
    // The record's units past pending, its open decision and its unreviewed
    // agent decision, its gate past pending and its drift, with D from the log.
    expect(keys(digest.entries)).toEqual([
      "unit:A",
      "unit:B",
      "unit:D",
      "decision:decision-1",
      "decision:decision-2",
      "gate:gate-after-c",
      "drift:drift-0",
    ]);
    expect(digest.entries.every((entry) => entry.previousStatus === null)).toBe(true);
  });
});
