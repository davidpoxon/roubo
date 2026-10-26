// Delivery record fixtures for the Delivery tab suites (SB-FR-010). Each is a
// conformant record at contract version 1.0.0.
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";

type Units = DeliveryRecord["units"];
type Gates = DeliveryRecord["stack"]["gates"];

function baseRecord(units: Units, stacks: Record<string, string[]>, gates: Gates): DeliveryRecord {
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    spec_slug: "fixture-spec",
    plan_hash: "hash",
    mode: { value: "attended", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: { stacks, gates },
    units,
    decisions: [],
    steering: [],
    budget: { estimate_usd: 3.2, soft_budget_usd: 5, spent_usd: 0.42 },
    roles: { main: { tier: "balanced" } },
    health: { status: "ok", checked_at: "2026-10-16T09:30:00Z" },
    drift: [],
    seams: {},
    lifecycle: { state: "running", armed: true, started_at: "2026-10-16T09:00:00Z" },
    last_event_seq: 7,
    updated_at: "2026-10-16T09:30:00Z",
  };
}

/** Four units A, B, C and D; a stack of A, B and C; gates after B and after C. */
export function fourUnitRecord(): DeliveryRecord {
  return baseRecord(
    [
      {
        id: "A",
        title: "Base",
        status: "running",
        stack: "A",
        layer: 0,
        depends_on: [],
        cost_usd: 0.42,
      },
      { id: "B", title: "Second", status: "pending", stack: "A", layer: 1, depends_on: ["A"] },
      { id: "C", title: "Third", status: "pending", stack: "A", layer: 2, depends_on: ["B"] },
      { id: "D", title: "Own", status: "done", stack: "D", layer: 0, depends_on: [] },
    ],
    { A: ["A", "B", "C"], D: ["D"] },
    [
      { id: "gate-after-b", after: ["B"], status: "pending", cases: ["FX-TC-001"] },
      { id: "gate-after-c", after: ["C"], status: "passed", cases: ["FX-TC-002"] },
    ],
  );
}

/** A record where A depends on C and C depends on A. */
export function cycleRecord(): DeliveryRecord {
  return baseRecord(
    [
      { id: "A", title: "Base", status: "pending", stack: "A", layer: 0, depends_on: ["C"] },
      { id: "C", title: "Third", status: "pending", stack: "A", layer: 1, depends_on: ["A"] },
    ],
    { A: ["A", "C"] },
    [],
  );
}

export const FIFTY_UNIT_STACKS = 10;
export const FIFTY_UNIT_LAYERS = 5;

/**
 * Fifty units: ten stacks of five layers, each unit on its layer below, the
 * base of every stack after the second depending on the top of the stack two
 * before it, and a gate after each stack's top.
 */
export function fiftyUnitRecord(): DeliveryRecord {
  const units: Units = [];
  const stacks: Record<string, string[]> = {};
  const gates: Gates = [];
  for (let s = 0; s < FIFTY_UNIT_STACKS; s += 1) {
    const stack = `S${s}`;
    stacks[stack] = [];
    for (let layer = 0; layer < FIFTY_UNIT_LAYERS; layer += 1) {
      const id = `${stack}-U${layer}`;
      const depends_on =
        layer > 0
          ? [`${stack}-U${layer - 1}`]
          : s >= 2
            ? [`S${s - 2}-U${FIFTY_UNIT_LAYERS - 1}`]
            : [];
      units.push({
        id,
        title: `Unit ${layer} of stack ${s}`,
        status: "pending",
        stack,
        layer,
        depends_on,
        cost_usd: 0.1 * layer,
      });
      stacks[stack].push(id);
    }
    gates.push({
      id: `gate-${stack}`,
      after: [`${stack}-U${FIFTY_UNIT_LAYERS - 1}`],
      status: "pending",
      cases: [],
    });
  }
  return baseRecord(units, stacks, gates);
}

/** An event of one unit, of any type, at a given time. */
export function unitEvent(
  seq: number,
  unitId: string,
  type: string,
  payload: Record<string, unknown>,
  ts: string,
): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts,
    unit_id: unitId,
    payload,
  };
}

/** A `unit.changed` event that sets a unit's status. */
export function unitChanged(seq: number, unitId: string, status: string): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type: "unit.changed",
    seq,
    ts: "2026-10-16T10:00:00Z",
    unit_id: unitId,
    payload: { status },
  };
}
