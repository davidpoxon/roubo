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
// The bench keeps the delivery's id with that seq. A last view of another
// delivery (the bench's workspace was provisioned again, or the record was
// replaced by one of another delivery), or of a seq above the delivery's
// current one (the record was rewritten and its seq went back), is no prior
// view: the digest lists nothing and reports `lastViewedSeq: null`, so the
// view marks the delivery seen from its current seq.
//
// The server reads the events above the record's `last_event_seq` (in memory
// and in the spill file). Once the record has moved past the last viewed seq,
// the events between the two are folded into the record, and no `before`
// snapshot can be rebuilt. The digest then falls back to the record: the
// events above the record are compared with it as above, each entity that a
// rolled event the spill file still holds names (`rolledEvents`) is listed,
// and, unless those rolled events cover every seq between the last view and
// the record, each entity that awaits the operator is listed too: an open,
// defaulted or unreviewed agent decision, a jammed unit and an unconfirmed
// provisional gate. An entity that moved on without awaiting the operator, and
// a drift entry the record already holds, cannot be told apart from what the
// operator saw, so they are not listed. `source` says which reading it is.
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
  deepEqual,
  foldDelivery,
  isDecisionDefaulted,
  isDecisionOpen,
  isUnconfirmedProvisionalGate,
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
  // The seq the operator last viewed, or null before the first view and for a
  // last view of another delivery or of a seq above the current one.
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
  // The delivery the last view was of, when the bench stored it.
  lastViewedDeliveryId?: string | null | undefined;
  // The events at or below the record's `last_event_seq` that the spill file
  // still holds, in seq order; the digest reads those above the last view.
  rolledEvents?: readonly DeliveryEvent[] | undefined;
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

// The keys (`<kind>:<id>`) of the entities of `snapshot` that await the
// operator: an open, defaulted or unreviewed agent decision, a jammed unit and
// an unconfirmed provisional gate.
function awaitingKeys(snapshot: DeliverySnapshot): Set<string> {
  const keys = new Set<string>();
  for (const unitId of snapshot.jams) keys.add(`unit:${unitId}`);
  for (const decision of Object.values(snapshot.decisionsById)) {
    if (
      isDecisionOpen(decision) ||
      isDecisionDefaulted(decision) ||
      isUnreviewedAgentDecision(decision)
    ) {
      keys.add(`decision:${decision.id}`);
    }
  }
  for (const view of Object.values(snapshot.gatesById)) {
    if (isUnconfirmedProvisionalGate(view.gate)) keys.add(`gate:${view.gate.id}`);
  }
  return keys;
}

// The entries of `after` that differ from `before`, or whose key is in
// `listed` (an event above the last view names it, or it awaits the operator
// on the record path). `knowsBefore` is false on the record path, where
// `before` is the record and not the delivery at the last view, so no entry
// has a previous status.
function diffEntries(
  before: DeliverySnapshot,
  after: DeliverySnapshot,
  addressed: Map<string, string[]>,
  listed: ReadonlySet<string>,
  knowsBefore: boolean,
): DeliveryDigestEntry[] {
  const entries: DeliveryDigestEntry[] = [];
  const withEvents = (entry: DeliveryDigestEntry): DeliveryDigestEntry => ({
    ...entry,
    events: addressed.get(`${entry.kind}:${entry.id}`) ?? [],
  });

  for (const unit of Object.values(after.unitsById)) {
    const was = ownValue(before.unitsById, unit.id);
    if (!deepEqual(was, unit) || listed.has(`unit:${unit.id}`)) {
      entries.push(withEvents(unitEntry(unit, knowsBefore ? was : undefined)));
    }
  }
  for (const decision of Object.values(after.decisionsById)) {
    const was = ownValue(before.decisionsById, decision.id);
    if (!deepEqual(was, decision) || listed.has(`decision:${decision.id}`)) {
      entries.push(withEvents(decisionEntry(decision, knowsBefore ? was : undefined)));
    }
  }
  for (const view of Object.values(after.gatesById)) {
    const gate = view.gate;
    const was = ownValue(before.gatesById, gate.id)?.gate;
    if (!deepEqual(was, gate) || listed.has(`gate:${gate.id}`)) {
      entries.push(withEvents(gateEntry(gate, knowsBefore ? was : undefined)));
    }
  }
  after.drift.forEach((entry, index) => {
    const known = before.drift.some((seen) => deepEqual(seen, entry));
    if (!known) entries.push(driftEntry(entry, index));
  });
  return entries;
}

// Whether `events` hold every seq above `afterSeq` up to `upToSeq`.
function coversSeqs(events: readonly DeliveryEvent[], afterSeq: number, upToSeq: number): boolean {
  const seqs = new Set(events.map((event) => event.seq));
  for (let seq = afterSeq + 1; seq <= upToSeq; seq += 1) {
    if (!seqs.has(seq)) return false;
  }
  return true;
}

// The last viewed seq that counts: none before the first view, for a view of
// another delivery, or for a seq above the delivery's current one.
function priorView(inputs: DeliveryDigestInputs, currentSeq: number): number | null {
  const { record, lastViewedSeq, lastViewedDeliveryId } = inputs;
  if (lastViewedSeq === null || lastViewedSeq > currentSeq) return null;
  if (
    lastViewedDeliveryId !== undefined &&
    lastViewedDeliveryId !== null &&
    lastViewedDeliveryId !== record.delivery_id
  ) {
    return null;
  }
  return lastViewedSeq;
}

/**
 * The digest of the changes above `lastViewedSeq`. Before the first view
 * (`null`), for a last view that does not count (see `priorView`), and once
 * the operator has viewed the current seq, it lists nothing.
 */
export function deriveDeliveryDigest(inputs: DeliveryDigestInputs): DeliveryDigest {
  const { record, events } = inputs;
  const after = foldDelivery({ record, events });
  const viewed = priorView(inputs, after.seq);
  const base = { lastViewedSeq: viewed, seq: after.seq };
  if (viewed === null || viewed >= after.seq) {
    return { ...base, source: "events", entries: [] };
  }
  if (viewed >= record.last_event_seq) {
    const before = foldDelivery({
      record,
      events: events.filter((event) => event.seq <= viewed),
    });
    const addressed = addressedTypes(events, viewed);
    return {
      ...base,
      source: "events",
      entries: diffEntries(before, after, addressed, new Set(addressed.keys()), true),
    };
  }
  // The record has moved past the last view: it stands in for the events it
  // already carries, with the rolled events the spill file still holds.
  const rolled = (inputs.rolledEvents ?? []).filter(
    (event) =>
      event.delivery_id === record.delivery_id &&
      event.seq > viewed &&
      event.seq <= record.last_event_seq,
  );
  const addressed = addressedTypes([...rolled, ...events], viewed);
  const listed = new Set(addressed.keys());
  if (!coversSeqs(rolled, viewed, record.last_event_seq)) {
    for (const key of awaitingKeys(after)) listed.add(key);
  }
  const before = foldDelivery({ record, events: [] });
  return {
    ...base,
    source: "record",
    entries: diffEntries(before, after, addressed, listed, false),
  };
}
