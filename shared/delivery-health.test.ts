// The cost, health and drift readings of a delivery (SB-FR-018, SB-FR-019,
// SB-FR-020, SB-NFR-006): the reducer folds the events that move them, and the
// shared selectors give every view one reading of the burn, the jams, the drift
// ledger and the staleness.
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
  DELIVERY_STALE_AFTER_MS,
  computeStaleness,
  createDeliveryReducer,
  foldDelivery,
} from "./delivery-reducer.js";
import {
  isJammedUnit,
  selectBurn,
  selectDriftLedger,
  selectHealth,
  selectJammedUnits,
  selectStaleness,
} from "./delivery-selectors.js";

function fixtureRecord(): DeliveryRecord {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./__fixtures__/delivery-record.json", import.meta.url), "utf8"),
  );
  const parsed = validateDeliveryRecord(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.data;
}

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unitId?: string,
  ts = "2026-10-16T10:00:00Z",
): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts,
    payload,
    ...(unitId !== undefined ? { unit_id: unitId } : {}),
  };
}

const at = (iso: string) => Date.parse(iso);

describe("burn meter", () => {
  it("SB-TC-046: reads spend against the soft budget, cost per unit and cost per role", () => {
    const record = fixtureRecord();
    record.units[1] = { ...record.units[1], cost_usd: 0.3 };
    record.budget = { ...record.budget, by_role: { main: 0.12, "unit-coder": 0.6 } };
    const burn = selectBurn(foldDelivery({ record, events: [] }));
    expect(burn.spentUsd).toBe(0.42);
    expect(burn.softBudgetUsd).toBe(5);
    expect(burn.fill).toBeCloseTo(0.084);
    expect(burn.overBudget).toBe(false);
    expect(burn.byUnit).toEqual([
      { unitId: "A", title: "Base of the stack", costUsd: 0.42 },
      { unitId: "B", title: "Second layer", costUsd: 0.3 },
    ]);
    expect(burn.byRole).toEqual([
      { role: "main", costUsd: 0.12 },
      { role: "unit-coder", costUsd: 0.6 },
    ]);
  });

  it("SB-TC-046: a unit.changed moves the unit's cost and a budget.changed moves the spend and one role's cost", () => {
    const record = fixtureRecord();
    record.budget = { ...record.budget, by_role: { main: 0.12, "unit-coder": 0.6 } };
    const snapshot = foldDelivery({
      record,
      events: [
        event(8, "unit.changed", { cost_usd: 0.5 }, "B"),
        event(9, "budget.changed", { spent_usd: 0.92, by_role: { "unit-coder": 1.1 } }),
      ],
    });
    const burn = selectBurn(snapshot);
    expect(burn.spentUsd).toBe(0.92);
    expect(burn.byUnit.find((entry) => entry.unitId === "B")?.costUsd).toBe(0.5);
    expect(burn.byRole).toEqual([
      { role: "main", costUsd: 0.12 },
      { role: "unit-coder", costUsd: 1.1 },
    ]);
    // The record the fold was given is untouched.
    expect(record.budget.by_role).toEqual({ main: 0.12, "unit-coder": 0.6 });
  });

  it("ignores a role cost that is not a non-negative number, and fills the meter at most once", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({
      record,
      events: [
        event(8, "budget.changed", { by_role: { main: -1, coder: "a lot" } }),
        event(9, "budget.changed", { spent_usd: 7 }),
      ],
    });
    const burn = selectBurn(snapshot);
    expect(burn.byRole).toEqual([]);
    expect(burn.fill).toBe(1);
    expect(burn.overBudget).toBe(true);
  });
});

describe("jams", () => {
  it("SB-TC-047: a unit.changed whose status reads as jammed marks the unit, and the next status clears it", () => {
    const record = fixtureRecord();
    const reducer = createDeliveryReducer();
    const events = [event(8, "unit.changed", { status: "jammed" }, "B")];
    const jammed = reducer.fold({ record, events });
    expect(selectJammedUnits(jammed)).toEqual(["B"]);
    expect(isJammedUnit(jammed, "B")).toBe(true);
    expect(selectHealth(jammed).word).toBe("blocked");
    expect(selectHealth(jammed).reason).toBe("Unit B is jammed");

    events.push(event(9, "unit.changed", { status: "running" }, "B"));
    const resumed = reducer.fold({ record, events });
    expect(selectJammedUnits(resumed)).toEqual([]);
    expect(selectHealth(resumed).word).toBe("fresh");
  });

  it("skips the unit.jammed and unit.resumed names, which the contract does not define", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [event(8, "unit.jammed", { status: "jammed" }, "B")],
    });
    expect(snapshot.jams).toEqual([]);
    expect(snapshot.seq).toBe(8);
  });
});

describe("drift ledger", () => {
  it("SB-TC-048: lists every drift entry, and a drift.detected adds a row with file, summary, ids and pull request", () => {
    const record = fixtureRecord();
    record.drift = [
      ...record.drift,
      {
        kind: "spec",
        detail: "Amended the burn requirement",
        detected_at: "2026-10-16T09:21:00Z",
        file: "prd.md",
        summary: "Amended the burn requirement",
        ids: ["DEMO-FR-018"],
        pr_url: "https://github.com/demo/demo/pull/3",
      },
      {
        kind: "spec",
        detail: "Added a stale case",
        detected_at: "2026-10-16T09:22:00Z",
        file: "test-cases.json",
        summary: "Added a stale case",
        ids: ["DEMO-TC-053"],
        pr_url: "https://github.com/demo/demo/pull/3",
      },
    ];
    expect(selectDriftLedger(foldDelivery({ record, events: [] }))).toHaveLength(3);

    const snapshot = foldDelivery({
      record,
      events: [
        event(8, "drift.detected", {
          kind: "spec",
          file: "architecture.md",
          summary: "Named the jam notification",
          ids: ["DEMO-FR-019", "DEMO-TC-047"],
          pr_url: "https://github.com/demo/demo/pull/4",
        }),
      ],
    });
    const ledger = selectDriftLedger(snapshot);
    expect(ledger).toHaveLength(4);
    expect(ledger[3]).toEqual({
      kind: "spec",
      detail: "Named the jam notification",
      detected_at: "2026-10-16T10:00:00Z",
      file: "architecture.md",
      summary: "Named the jam notification",
      ids: ["DEMO-FR-019", "DEMO-TC-047"],
      pr_url: "https://github.com/demo/demo/pull/4",
    });
  });

  it("skips a drift.detected with neither a detail nor a summary, and the drift.added name", () => {
    const snapshot = foldDelivery({
      record: fixtureRecord(),
      events: [
        event(8, "drift.detected", { kind: "spec", file: "prd.md" }),
        event(9, "drift.added", { kind: "spec", detail: "x" }),
      ],
    });
    expect(selectDriftLedger(snapshot)).toHaveLength(1);
  });
});

describe("staleness", () => {
  it("SB-TC-053: is stale 2 minutes after the last event, shows the record's age, and the next event clears it", () => {
    const record = fixtureRecord();
    const lastEvent = "2026-10-16T10:00:00Z";
    const events = [event(8, "unit.changed", { status: "running" }, "C", lastEvent)];
    const snapshot = foldDelivery({ record, events, now: at(lastEvent) });
    expect(snapshot.staleness).toEqual({
      updatedAt: "2026-10-16T09:30:00Z",
      lastEventAt: lastEvent,
      ageMs: 30 * 60_000,
      quietMs: 0,
      stale: false,
    });

    // Step 1: the tooling stops and the clock moves on by 2 minutes.
    const later = at(lastEvent) + DELIVERY_STALE_AFTER_MS;
    expect(selectStaleness(snapshot, later - 1).stale).toBe(false);
    const stale = selectStaleness(snapshot, later);
    expect(stale.stale).toBe(true);
    expect(stale.ageMs).toBe(32 * 60_000);
    expect(selectHealth(snapshot, later)).toMatchObject({
      word: "stale",
      reason: "No event for 2 minutes",
    });

    // Step 2: one event, of any type, clears it.
    const next = event(
      9,
      "seam.ran",
      { seam: "plan", status: "ok" },
      undefined,
      "2026-10-16T10:02:00Z",
    );
    const cleared = foldDelivery({ record, events: [...events, next] });
    expect(selectStaleness(cleared, later).stale).toBe(false);
    expect(selectHealth(cleared, later).word).toBe("fresh");
  });

  it("reads the record's updated_at when no event came, and is never stale without a clock", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({ record, events: [] });
    expect(snapshot.staleness.stale).toBe(false);
    expect(snapshot.staleness.quietMs).toBeNull();
    expect(selectStaleness(snapshot, at(record.updated_at) + DELIVERY_STALE_AFTER_MS).stale).toBe(
      true,
    );
    expect(computeStaleness("not a time", null, 0)).toEqual({
      updatedAt: "not a time",
      lastEventAt: null,
      ageMs: null,
      quietMs: null,
      stale: false,
    });
  });

  it("a jam outranks staleness on the health chip, and a disconnected stream outranks staleness", () => {
    const record = fixtureRecord();
    const snapshot = foldDelivery({ record, events: [] });
    const late = at(record.updated_at) + DELIVERY_STALE_AFTER_MS;
    expect(selectHealth(snapshot, late, { disconnected: true }).word).toBe("disconnected");
    const jammed = foldDelivery({
      record,
      events: [event(8, "unit.changed", { status: "blocked" }, "B", record.updated_at)],
    });
    expect(selectHealth(jammed, late).word).toBe("blocked");
  });
});
