// Where a delivery's elapsed time went (#1671): the delivery's window, and each
// unit's, split into four states whose parts add up to the window.
//
// The split is derived from the record and the event history only. The record
// carries no session, unit or gate times, so the states are replayed from the
// events' `ts`, the decisions' `raised_at` and `decided_at`, and the
// lifecycle's `started_at` and `ended_at`:
//
// - no live session: the lifecycle is `paused` (every session closed) or
//   `wound_down` (a wind-down session is open), so the time from a wind-down
//   to its resume counts here;
// - agent working: a unit is running, or the session is live and nothing else
//   below applies;
// - at a gate: a gate whose units are all done has not passed;
// - waiting on the operator: a decision is open, or a review is open.
//
// At any instant exactly one state applies, in that order of precedence, so
// the split shows what held the delivery up: waiting counts only while no
// agent works and no gate sits. A unit's own split reads the same way, except
// that a done unit whose gate has not passed counts as at a gate, since it
// waits on that gate (or on the units the gate also follows).
//
// The decisions, the review and the lifecycle are read from the record with
// the events above its `last_event_seq` folded on (`foldDelivery`), so an event
// the record has not taken in yet still counts.
//
// Two parts cannot be derived exactly:
// - A review's close sends no event and leaves no time in the record (#1680),
//   so an open review is closed at its last outcome when the folded record no
//   longer shows it open, and `reviewCloseInferred` says so.
// - A session that ends without a pause leaves the lifecycle `running`, and
//   the record holds no session times (#1684), so the time after it counts as
//   agent working until the next lifecycle change.
import {
  GATE_PROVISIONAL_STATUS,
  type DeliveryDecision,
  type DeliveryEvent,
  type DeliveryLifecycle,
  type DeliveryRecord,
} from "./delivery-observation-contract";
import {
  classifyUnitStatus,
  foldDelivery,
  isDecisionOpen,
  looksLikeProvisionalCase,
  type UnitStatusKind,
} from "./delivery-reducer";

// The four states, in the order the view lists them.
export const DELIVERY_TIME_STATES = ["agent", "operator", "gate", "no_session"] as const;
export type DeliveryTimeState = (typeof DELIVERY_TIME_STATES)[number];
export type DeliveryTimeParts = Record<DeliveryTimeState, number>;

export interface DeliveryTimeSpan {
  // ISO times the span runs from and to.
  from: string;
  to: string;
  // The sum of `parts`, in milliseconds.
  totalMs: number;
  parts: DeliveryTimeParts;
}

export interface DeliveryUnitTimeSpan extends DeliveryTimeSpan {
  unitId: string;
}

export interface DeliveryTimeSplit extends DeliveryTimeSpan {
  // The time the split was taken.
  asOf: string;
  // True while the delivery has not ended, so the last part still grows.
  open: boolean;
  // One entry per unit of the record that has left `pending`, in record order.
  // A unit's span runs from its first move out of `pending` until it is done
  // and every gate after it has passed. A started unit with no time in the
  // window (it finished before a truncated history begins) has a zero span at
  // the window's start.
  units: DeliveryUnitTimeSpan[];
  notes: {
    // The history does not start at the first event. Before its first event, a
    // unit or gate that a later event moves counts as not yet started, and one
    // that no event moves holds its record value.
    historyTruncated: boolean;
    // A review's close time was inferred (see the header).
    reviewCloseInferred: boolean;
  };
}

export interface DeliveryTimeSplitInputs {
  record: DeliveryRecord;
  // Every event of the delivery the bench holds, at or below the record's
  // `last_event_seq` and above it. Order does not matter; seq does.
  events: readonly DeliveryEvent[];
  now: number;
}

const NO_SESSION_STATES: ReadonlySet<string> = new Set(["paused", "wound_down"]);
const COMPLETE_STATE = "complete";
const CLEARED_GATE_STATUSES: ReadonlySet<string> = new Set(["passed", "no_gating_cases"]);
const DECISION_CLOSE_EVENTS: ReadonlySet<string> = new Set([
  "decision.answered",
  "decision.defaulted",
  "decision.overturned",
  "decision.decided",
]);

interface OpenReview {
  from: number;
  outstanding: Set<string>;
  units: Set<string>;
  // The time of its last outcome, or of its opening.
  last: number;
}

interface Interval {
  from: number;
  to: number;
  units: ReadonlySet<string>;
}

function emptyParts(): DeliveryTimeParts {
  return { agent: 0, operator: 0, gate: 0, no_session: 0 };
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function payloadOf(event: DeliveryEvent): Record<string, unknown> {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function stringKey(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function decisionUnits(decision: DeliveryDecision | undefined): ReadonlySet<string> {
  if (!decision) return new Set();
  const units = new Set(decision.affected_units ?? []);
  if (decision.unit_id) units.add(decision.unit_id);
  return units;
}

// Each event with a time that never runs backwards: a `ts` earlier than the one
// before it, or unreadable, takes the one before it.
function timedEvents(events: readonly DeliveryEvent[], start: number) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let last = start;
  return sorted.map((event) => {
    last = Math.max(last, parseTime(event.ts) ?? last);
    return { event, at: last };
  });
}

type Timed = ReturnType<typeof timedEvents>[number];

// The window the delivery's split covers, from the folded lifecycle.
function windowOf(lifecycle: DeliveryLifecycle, timed: readonly Timed[], now: number) {
  const start = parseTime(lifecycle.started_at) ?? timed[0]?.at ?? now;
  let end = parseTime(lifecycle.ended_at ?? undefined);
  if (end === undefined && lifecycle.state === COMPLETE_STATE) {
    // The lifecycle may omit `ended_at`: the delivery ended when the lifecycle
    // last became complete.
    const completed = timed.filter(
      ({ event }) =>
        event.type === "lifecycle.changed" && payloadOf(event).state === COMPLETE_STATE,
    );
    end = completed.at(-1)?.at;
  }
  const open = end === undefined;
  return { start, end: Math.max(start, end ?? now), open };
}

// The time each decision held its units: from `raised_at` until it was
// settled, or until the window's end while it is still open. A settling event
// before `raised_at` belongs to an earlier raise of the same id and is ignored.
function decisionHolds(
  decisions: readonly DeliveryDecision[],
  timed: readonly Timed[],
  end: number,
): Interval[] {
  const closes = new Map<string, number[]>();
  for (const { event, at } of timed) {
    if (!DECISION_CLOSE_EVENTS.has(event.type)) continue;
    const id = stringKey(payloadOf(event), "decision_id", "id");
    if (id !== undefined) closes.set(id, [...(closes.get(id) ?? []), at]);
  }
  const holds: Interval[] = [];
  for (const decision of decisions) {
    const from = parseTime(decision.raised_at);
    if (from === undefined) continue;
    const settled = (closes.get(decision.id) ?? []).filter((at) => at >= from);
    let to: number;
    if (isDecisionOpen(decision)) {
      to = end;
    } else {
      // The earliest settling time: a default applied before a later overturn
      // settled the decision when the default applied.
      const decided = parseTime(decision.decided_at);
      const candidates = decided !== undefined && decided >= from ? [decided, ...settled] : settled;
      to = candidates.length > 0 ? Math.min(...candidates) : from;
    }
    if (to > from) holds.push({ from, to, units: decisionUnits(decision) });
  }
  return holds;
}

// The time each review was open: from `review.opened` until every decision it
// listed has an outcome, or a later review opens. A review still open at the
// end of the history runs to the window's end while the folded record shows it
// open, and otherwise closes at its last outcome (the inferred close).
function reviewHolds(
  reviewOpen: boolean,
  decisions: ReadonlyMap<string, DeliveryDecision>,
  timed: readonly Timed[],
  end: number,
) {
  const holds: Interval[] = [];
  const hold = (review: OpenReview, to: number) => {
    if (to > review.from) holds.push({ from: review.from, to, units: review.units });
  };
  let current: OpenReview | undefined;
  for (const { event, at } of timed) {
    if (event.type === "review.opened") {
      if (current) hold(current, at);
      const listed = payloadOf(event).unreviewed;
      const ids = Array.isArray(listed)
        ? listed.filter((id): id is string => typeof id === "string")
        : [];
      const units = new Set<string>();
      for (const id of ids) for (const unit of decisionUnits(decisions.get(id))) units.add(unit);
      current = { from: at, outstanding: new Set(ids), units, last: at };
    } else if (event.type === "review.outcome" && current) {
      const id = stringKey(payloadOf(event), "decision_id", "id");
      if (id === undefined) continue;
      current.outstanding.delete(id);
      current.last = at;
      if (current.outstanding.size === 0) {
        hold(current, at);
        current = undefined;
      }
    }
  }
  let inferred = false;
  if (current) {
    if (reviewOpen) {
      hold(current, end);
    } else {
      inferred = true;
      hold(current, current.last);
    }
  }
  return { holds, inferred };
}

const covers = (interval: Interval, at: number) => interval.from <= at && at < interval.to;

/**
 * The delivery's elapsed time, and each started unit's, split into agent
 * working, waiting on the operator, at a gate and no live session. Every
 * span's parts add up to its `totalMs`.
 */
export function deriveDeliveryTimeSplit({
  record,
  events,
  now,
}: DeliveryTimeSplitInputs): DeliveryTimeSplit {
  // The record brought up to date with the events above its `last_event_seq`.
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const current = foldDelivery({ record, events: sorted });
  const decisions = Object.values(current.decisionsById);
  const recordUnits = Object.values(current.unitsById);
  const gates = Object.values(current.gatesById).map((view) => view.gate);

  const provisionalStart = parseTime(current.lifecycle.started_at) ?? now;
  const timed = timedEvents(sorted, provisionalStart);
  const { start, end, open } = windowOf(current.lifecycle, timed, now);
  const decisionIntervals = decisionHolds(decisions, timed, end);
  const review = reviewHolds(
    current.review.status === "open",
    new Map(decisions.map((decision) => [decision.id, decision])),
    timed,
    end,
  );
  const holds = [...decisionIntervals, ...review.holds];

  // The state before the first event. A unit, gate or lifecycle that an event
  // of the history moves starts where the delivery starts; one that no event
  // moves held its (folded) record value all along.
  const firstSeq = timed[0]?.event.seq;
  const truncated = firstSeq === undefined ? record.last_event_seq > 0 : firstSeq > 1;
  const movedUnits = new Set<string>();
  // Each moved gate's first event type: a gate that a truncated history first
  // confirms was provisional before the history begins.
  const movedGates = new Map<string, string>();
  let lifecycleMoved = false;
  for (const { event } of timed) {
    const payload = payloadOf(event);
    if (event.type === "unit.changed" && event.unit_id && typeof payload.status === "string") {
      movedUnits.add(event.unit_id);
    } else if (event.type.startsWith("gate.")) {
      const id = stringKey(payload, "gate_id");
      if (id !== undefined && !movedGates.has(id)) movedGates.set(id, event.type);
    } else if (event.type === "lifecycle.changed" && typeof payload.state === "string") {
      lifecycleMoved = true;
    }
  }
  const unitKind = new Map<string, UnitStatusKind>();
  for (const unit of recordUnits) {
    unitKind.set(unit.id, classifyUnitStatus(movedUnits.has(unit.id) ? "pending" : unit.status));
  }
  const gateStatus = new Map<string, string>();
  // The unconfirmed marks of each provisional gate, as the reducer keeps them.
  const unconfirmed = new Map<string, Set<string>>();
  for (const gate of gates) {
    const first = movedGates.get(gate.id);
    if (first === undefined) gateStatus.set(gate.id, gate.status);
    else if (first === "gate.confirmed" && truncated) {
      gateStatus.set(gate.id, GATE_PROVISIONAL_STATUS);
      unconfirmed.set(gate.id, new Set());
    } else gateStatus.set(gate.id, "pending");
  }
  let lifecycleState = lifecycleMoved ? "running" : current.lifecycle.state;
  const started = new Set<string>();
  for (const [id, kind] of unitKind) if (kind !== "pending") started.add(id);

  const apply = (event: DeliveryEvent) => {
    const payload = payloadOf(event);
    switch (event.type) {
      case "lifecycle.changed":
        if (typeof payload.state === "string") lifecycleState = payload.state;
        break;
      case "unit.changed":
        if (event.unit_id && unitKind.has(event.unit_id) && typeof payload.status === "string") {
          const kind = classifyUnitStatus(payload.status);
          unitKind.set(event.unit_id, kind);
          if (kind !== "pending") started.add(event.unit_id);
        }
        break;
      case "gate.changed": {
        const id = stringKey(payload, "gate_id");
        if (id !== undefined && gateStatus.has(id) && typeof payload.status === "string") {
          gateStatus.set(id, payload.status);
        }
        break;
      }
      // As the reducer's handlers: a provisional judgement needs its marks, and
      // a confirmation applies to a provisional gate only, taking the payload's
      // status, else `confirmed` once every mark is confirmed.
      case "gate.provisional": {
        const id = stringKey(payload, "gate_id");
        const cases: unknown = payload.cases;
        if (id === undefined || !gateStatus.has(id) || !Array.isArray(cases)) break;
        if (!cases.every(looksLikeProvisionalCase)) break;
        gateStatus.set(id, GATE_PROVISIONAL_STATUS);
        unconfirmed.set(
          id,
          new Set(cases.filter((mark) => mark.confirmed !== true).map((mark) => mark.case)),
        );
        break;
      }
      case "gate.confirmed": {
        const id = stringKey(payload, "gate_id");
        if (id === undefined || gateStatus.get(id) !== GATE_PROVISIONAL_STATUS) break;
        const remaining = unconfirmed.get(id) ?? new Set<string>();
        // A case list that is not all strings confirms every mark, as in the
        // reducer.
        const named: unknown = payload.cases;
        if (Array.isArray(named) && named.every((entry) => typeof entry === "string")) {
          for (const entry of named) remaining.delete(entry);
        } else remaining.clear();
        unconfirmed.set(id, remaining);
        if (typeof payload.status === "string" && payload.status.length > 0) {
          gateStatus.set(id, payload.status);
        } else if (remaining.size === 0) {
          gateStatus.set(id, "confirmed");
        }
        break;
      }
    }
  };

  const gatesAfter = new Map<string, string[]>();
  for (const gate of gates) {
    for (const unitId of gate.after) {
      gatesAfter.set(unitId, [...(gatesAfter.get(unitId) ?? []), gate.id]);
    }
  }
  const isDoneKind = (kind: UnitStatusKind | undefined) => kind === "done" || kind === "skipped";
  const gateCleared = (id: string) =>
    CLEARED_GATE_STATUSES.has((gateStatus.get(id) ?? "").toLowerCase());
  const gateReached = (id: string) => {
    const gate = gates.find((entry) => entry.id === id);
    return (
      gate !== undefined &&
      gate.after.length > 0 &&
      gate.after.every((unitId) => isDoneKind(unitKind.get(unitId))) &&
      !gateCleared(id)
    );
  };

  // The boundaries where a state can change, inside the window.
  const cuts = new Set<number>([start, end]);
  for (const { at } of timed) cuts.add(at);
  for (const hold of holds) {
    cuts.add(hold.from);
    cuts.add(hold.to);
  }
  const bounds = [...cuts].filter((at) => at >= start && at <= end).sort((a, b) => a - b);

  const parts = emptyParts();
  const unitSpans = new Map<string, { from: number; to: number; parts: DeliveryTimeParts }>();
  const pending = timed.values();
  let upcoming = pending.next();
  for (const [index, from] of bounds.entries()) {
    const to = bounds[index + 1];
    if (to === undefined) break;
    while (!upcoming.done && upcoming.value.at <= from) {
      apply(upcoming.value.event);
      upcoming = pending.next();
    }
    const length = to - from;
    if (length <= 0) continue;

    const noSession = NO_SESSION_STATES.has(lifecycleState.toLowerCase());
    const live = holds.filter((hold) => covers(hold, from));
    let state: DeliveryTimeState;
    if (noSession) state = "no_session";
    else if ([...unitKind.values()].includes("running")) state = "agent";
    else if (gates.some((gate) => gateReached(gate.id))) state = "gate";
    else if (live.length > 0) state = "operator";
    else state = "agent";
    parts[state] += length;

    for (const unitId of started) {
      const kind = unitKind.get(unitId);
      const after = gatesAfter.get(unitId) ?? [];
      if (isDoneKind(kind) && after.every(gateCleared)) continue;
      let unitState: DeliveryTimeState;
      if (noSession) unitState = "no_session";
      else if (kind === "running") unitState = "agent";
      else if (isDoneKind(kind) || after.some(gateReached)) unitState = "gate";
      else if (live.some((hold) => hold.units.has(unitId))) unitState = "operator";
      else unitState = "agent";
      const span = unitSpans.get(unitId) ?? { from, to, parts: emptyParts() };
      span.to = to;
      span.parts[unitState] += length;
      unitSpans.set(unitId, span);
    }
  }

  const iso = (at: number) => new Date(at).toISOString();
  const total = (of: DeliveryTimeParts) =>
    DELIVERY_TIME_STATES.reduce((sum, state) => sum + of[state], 0);
  const units: DeliveryUnitTimeSpan[] = [];
  for (const unit of recordUnits) {
    const span =
      unitSpans.get(unit.id) ??
      (started.has(unit.id) ? { from: start, to: start, parts: emptyParts() } : undefined);
    if (!span) continue;
    units.push({
      unitId: unit.id,
      from: iso(span.from),
      to: iso(span.to),
      totalMs: total(span.parts),
      parts: span.parts,
    });
  }
  return {
    from: iso(start),
    to: iso(end),
    totalMs: total(parts),
    parts,
    asOf: iso(now),
    open,
    units,
    notes: {
      historyTruncated: truncated,
      reviewCloseInferred: review.inferred,
    },
  };
}
