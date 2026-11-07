// The since-you-left digest of a Spec Bench's delivery (SB-FR-012, SB-US-012):
// what changed in the delivery since the operator last viewed it, grouped by
// unit, decision, gate and drift, each entry naming the thing it links to.
//
// The bench keeps the seq the operator last viewed (`deliveryLastViewedSeq`).
// The digest is the shared reducer's view of the events above that seq: the
// record and the events at or below it folded into a `before` snapshot, the
// record and every accepted event folded into the `after` one, and each unit,
// decision, gate and drift entry that differs between the two is listed. An
// event above the seq that names an entity but changes nothing the fold keeps
// (a `gate.reached`, which the fold skips) lists that entity too, so a gate the
// delivery reached shows even when its status word did not move. A unit is
// named by a `unit.*` event's unit_id, a gate by a payload `gate_id`, and a
// decision by a payload `decision_id` (or `id` on a `decision.*` event).
//
// The server keeps only the events above the record's `last_event_seq` (in
// memory and in the spill file). Once the record has moved past the last
// viewed seq, the events between the two have rolled out of the log, and no
// `before` snapshot can be rebuilt. The digest then falls back to the record:
// the events still in the log are compared with the record as above, and the
// record adds each entity that waits on the operator or has moved on from its
// first state (a unit or a gate past `pending`, an open, defaulted or
// unreviewed decision, every drift entry). `source` says which reading it is.
//
// Pure: no I/O and no clock, as the reducer.

import type {
  DeliveryDecision,
  DeliveryDrift,
  DeliveryEvent,
  DeliveryGate,
  DeliveryRecord,
  DeliveryUnit,
} from "./delivery-observation-contract";
import {
  classifyUnitStatus,
  deepEqual,
  foldDelivery,
  isDecisionDefaulted,
  isDecisionOpen,
  isUnreviewedAgentDecision,
  ownValue,
  type DeliverySnapshot,
} from "./delivery-reducer";

export type DeliveryDigestKind = "unit" | "decision" | "gate" | "drift";

// The order the digest groups its entries in.
export const DELIVERY_DIGEST_KINDS: readonly DeliveryDigestKind[] = [
  "unit",
  "decision",
  "gate",
  "drift",
];

export interface DeliveryDigestEntry {
  kind: DeliveryDigestKind;
  // The unit, decision or gate id; for a drift entry, `drift-<index>`, the
  // entry's place in the drift ledger.
  id: string;
  // A unit's title, a decision's question, the units a gate runs after, or a
  // drift entry's summary (its detail when it has none).
  label: string;
  // The status word now: a unit's, a decision's or a gate's status, or a drift
  // entry's kind.
  status: string;
  // The status word at the last view, or null when the entity is new since
  // then or the digest cannot tell (read from the record).
  previousStatus: string | null;
  // The type of each event above the last viewed seq that names the entity,
  // once each, in seq order; empty for an entry the record adds.
  events: string[];
  // The unit a decision or a drift entry is about, when it names one.
  unitId?: string;
}

// The body of GET <base>/digest.
export interface DeliveryDigest {
  // The seq the operator last viewed, or null before the first view.
  lastViewedSeq: number | null;
  // The delivery's current seq: the seq a POST <base>/digest/seen stores.
  seq: number;
  // `events` when the digest is read from the events above the last view,
  // `record` when the record has moved past it and stands in for them.
  source: "events" | "record";
  // Grouped by DELIVERY_DIGEST_KINDS, then in record order.
  entries: DeliveryDigestEntry[];
}

export interface DeliveryDigestInputs {
  record: DeliveryRecord;
  // The accepted events above the record's `last_event_seq`, in seq order.
  events: readonly DeliveryEvent[];
  lastViewedSeq: number | null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// The decision an event names: `decision_id`, or `id` on a decision event.
function decisionIdOf(event: DeliveryEvent): string | undefined {
  const payload = event.payload;
  if (isString(payload.decision_id)) return payload.decision_id;
  if (event.type.startsWith("decision.") && isString(payload.id)) return payload.id;
  return undefined;
}

// Per kind and id, the event types above `afterSeq` that name the entity.
function addressedTypes(events: readonly DeliveryEvent[], afterSeq: number): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  const add = (kind: DeliveryDigestKind, id: string, type: string) => {
    const key = `${kind}:${id}`;
    const types = byKey.get(key) ?? [];
    if (!types.includes(type)) types.push(type);
    byKey.set(key, types);
  };
  for (const event of events) {
    if (event.seq <= afterSeq) continue;
    // A unit event names its unit; another event that carries a unit_id (a
    // decision the unit raised) is about something else, which it names.
    if (isString(event.unit_id) && event.type.startsWith("unit.")) {
      add("unit", event.unit_id, event.type);
    }
    if (isString(event.payload.gate_id)) add("gate", event.payload.gate_id, event.type);
    const decisionId = decisionIdOf(event);
    if (decisionId !== undefined) add("decision", decisionId, event.type);
  }
  return byKey;
}

function unitEntry(unit: DeliveryUnit, before: DeliveryUnit | undefined): DeliveryDigestEntry {
  return {
    kind: "unit",
    id: unit.id,
    label: unit.title,
    status: unit.status,
    previousStatus: before?.status ?? null,
    events: [],
  };
}

function decisionEntry(
  decision: DeliveryDecision,
  before: DeliveryDecision | undefined,
): DeliveryDigestEntry {
  return {
    kind: "decision",
    id: decision.id,
    label: decision.question,
    status: decision.status,
    previousStatus: before?.status ?? null,
    events: [],
    ...(decision.unit_id !== undefined && { unitId: decision.unit_id }),
  };
}

function gateEntry(gate: DeliveryGate, before: DeliveryGate | undefined): DeliveryDigestEntry {
  return {
    kind: "gate",
    id: gate.id,
    label: `Gate after ${gate.after.join(", ")}`,
    status: gate.status,
    previousStatus: before?.status ?? null,
    events: [],
  };
}

function driftEntry(entry: DeliveryDrift, index: number): DeliveryDigestEntry {
  return {
    kind: "drift",
    id: `drift-${index}`,
    label: entry.summary ?? entry.detail,
    status: entry.kind,
    previousStatus: null,
    events: [],
    ...(entry.unit_id !== undefined && { unitId: entry.unit_id }),
  };
}

// Whether a status word still reads as its first state.
function isAtRest(status: string): boolean {
  return classifyUnitStatus(status) === "pending";
}

// The entries of `after` that differ from `before`, or that an event above
// `afterSeq` names; with `fromRecord`, also each entity of the record that
// waits on the operator or has moved on from its first state.
function diffEntries(
  before: DeliverySnapshot,
  after: DeliverySnapshot,
  addressed: Map<string, string[]>,
  fromRecord: DeliveryRecord | undefined,
): DeliveryDigestEntry[] {
  const recordUnits = new Set(
    (fromRecord?.units ?? []).filter((unit) => !isAtRest(unit.status)).map((unit) => unit.id),
  );
  const recordDecisions = new Set(
    (fromRecord?.decisions ?? [])
      .filter(
        (decision) =>
          isDecisionOpen(decision) ||
          isDecisionDefaulted(decision) ||
          isUnreviewedAgentDecision(decision),
      )
      .map((decision) => decision.id),
  );
  const recordGates = new Set(
    (fromRecord?.stack.gates ?? []).filter((gate) => !isAtRest(gate.status)).map((gate) => gate.id),
  );
  const entries: DeliveryDigestEntry[] = [];
  const withEvents = (entry: DeliveryDigestEntry): DeliveryDigestEntry => ({
    ...entry,
    events: addressed.get(`${entry.kind}:${entry.id}`) ?? [],
  });

  for (const unit of Object.values(after.unitsById)) {
    const was = ownValue(before.unitsById, unit.id);
    if (!deepEqual(was, unit) || addressed.has(`unit:${unit.id}`) || recordUnits.has(unit.id)) {
      entries.push(withEvents(unitEntry(unit, fromRecord === undefined ? was : undefined)));
    }
  }
  for (const decision of Object.values(after.decisionsById)) {
    const was = ownValue(before.decisionsById, decision.id);
    if (
      !deepEqual(was, decision) ||
      addressed.has(`decision:${decision.id}`) ||
      recordDecisions.has(decision.id)
    ) {
      entries.push(withEvents(decisionEntry(decision, fromRecord === undefined ? was : undefined)));
    }
  }
  for (const view of Object.values(after.gatesById)) {
    const gate = view.gate;
    const was = ownValue(before.gatesById, gate.id)?.gate;
    if (!deepEqual(was, gate) || addressed.has(`gate:${gate.id}`) || recordGates.has(gate.id)) {
      entries.push(withEvents(gateEntry(gate, fromRecord === undefined ? was : undefined)));
    }
  }
  after.drift.forEach((entry, index) => {
    const known = before.drift.some((seen) => deepEqual(seen, entry));
    if (!known || fromRecord !== undefined) entries.push(driftEntry(entry, index));
  });
  return entries;
}

/**
 * The digest of the changes above `lastViewedSeq`. Before the first view
 * (`null`), and once the operator has viewed the current seq or beyond it,
 * it lists nothing.
 */
export function deriveDeliveryDigest(inputs: DeliveryDigestInputs): DeliveryDigest {
  const { record, events, lastViewedSeq } = inputs;
  const after = foldDelivery({ record, events });
  const base = { lastViewedSeq, seq: after.seq };
  if (lastViewedSeq === null || lastViewedSeq >= after.seq) {
    return { ...base, source: "events", entries: [] };
  }
  if (lastViewedSeq >= record.last_event_seq) {
    const before = foldDelivery({
      record,
      events: events.filter((event) => event.seq <= lastViewedSeq),
    });
    return {
      ...base,
      source: "events",
      entries: diffEntries(before, after, addressedTypes(events, lastViewedSeq), undefined),
    };
  }
  // The log has rolled past the last view: the record stands in for the
  // events it already carries.
  const before = foldDelivery({ record, events: [] });
  return {
    ...base,
    source: "record",
    entries: diffEntries(before, after, addressedTypes(events, lastViewedSeq), record),
  };
}
