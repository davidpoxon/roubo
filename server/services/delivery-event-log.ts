// The accepted sequence and the bounded event log of each Spec Bench's delivery
// (SB-FR-007, SB-FR-008, SB-NFR-006).
//
// The record on disk is the durable state. Its `last_event_seq` seeds the
// accepted seq the first time a bench's events are read or posted, so after a
// server restart the bench starts again from the record. An event at or below
// the accepted seq is dropped. The next event must carry acceptedSeq + 1: the
// fold stops at a hole, so an event that skips a seq is refused rather than
// held where no snapshot could reach it.
//
// The log holds the accepted events above the record's `last_event_seq` in
// memory, at most DELIVERY_EVENT_LOG_MAX of them. Each time the record moves
// forward, the events it now carries leave memory. When a batch would take
// memory over the limit, the oldest events, DELIVERY_EVENT_SPILL_CHUNK at a
// time, are appended to the bench's spill file (a JSON Lines file beside the
// record in the bench workspace) and leave memory, and the batch is accepted.
// No accepted event is discarded: a read of the log reads the spill file as
// well as memory, in seq order. The spill file is append-only, so it can hold
// an event more than once (a spill that failed part way, or a session that
// posts again after a restart); a read keeps one event per seq, memory first.
//
// The log also keeps, per unit, the span of the unit's accepted events: the ts
// of its first and last event and how many it has, counted once per seq. The
// span outlives a record write, which takes the events it carries out of the
// log, so a finished unit's drill-in can still cut its transcript out of the
// session's scrollback and tell events folded into the record from none
// (SB-FR-013). The span lives in memory only, like the scrollback it cuts:
// after a server restart it holds only the events read again from the log.
//
// A batch is applied whole or not at all: every check, and the spill write,
// runs before anything is added, so a refused batch leaves the log and the
// accepted seq where they were.
import fs from "node:fs";
import path from "node:path";
import {
  validateDeliveryEvent,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import {
  DELIVERY_EVENT_LOG_MAX,
  DELIVERY_EVENT_SPILL_CHUNK,
  type DeliveryIngestError,
} from "@roubo/shared/delivery-bench";

interface BenchEventLog {
  // The delivery the log belongs to: the record's, or the first accepted
  // event's while the bench has no record yet.
  deliveryId: string | undefined;
  // The `last_event_seq` of the record the log last saw, 0 before any.
  recordSeq: number;
  acceptedSeq: number;
  // Seq order, dense, every seq above recordSeq.
  events: DeliveryEvent[];
  // Per unit id, the span of the unit's accepted events, the folded ones too.
  unitSpans: Map<string, UnitSpan>;
}

interface UnitSpan {
  first: { seq: number; ts: string };
  last: { seq: number; ts: string };
  seqs: Set<number>;
}

/**
 * The span of a unit's accepted events, the ones the record already carries
 * included: the ts of the first and the last, and how many there are, and how
 * many of them sit at or below the record's last_event_seq.
 */
export interface DeliveryUnitEventSpan {
  from: string;
  to: string;
  count: number;
  folded: number;
}

const logs = new Map<string, BenchEventLog>();

function key(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

function fromRecord(record: DeliveryRecord): BenchEventLog {
  return {
    deliveryId: record.delivery_id,
    recordSeq: record.last_event_seq,
    acceptedSeq: record.last_event_seq,
    events: [],
    unitSpans: new Map(),
  };
}

// Adds each event that names a unit to that unit's span. An event already in
// the span (a re-read of the spill file) counts once.
function noteUnitEvents(log: BenchEventLog, events: Iterable<DeliveryEvent>): void {
  for (const event of events) {
    const unitId = event.unit_id;
    if (unitId === undefined) continue;
    const mark = { seq: event.seq, ts: event.ts };
    const span = log.unitSpans.get(unitId);
    if (span === undefined) {
      log.unitSpans.set(unitId, { first: mark, last: mark, seqs: new Set([event.seq]) });
      continue;
    }
    if (span.seqs.has(event.seq)) continue;
    span.seqs.add(event.seq);
    if (event.seq < span.first.seq) span.first = mark;
    if (event.seq > span.last.seq) span.last = mark;
  }
}

// Brings a bench's log into line with its record, or with no record. A record
// of another delivery, or one whose seq went back (it was rewritten), starts
// the log again from the record.
function syncLog(k: string, record: DeliveryRecord | undefined): BenchEventLog {
  const log = logs.get(k);
  if (record === undefined) {
    if (log !== undefined) return log;
    const empty: BenchEventLog = {
      deliveryId: undefined,
      recordSeq: 0,
      acceptedSeq: 0,
      events: [],
      unitSpans: new Map(),
    };
    logs.set(k, empty);
    return empty;
  }
  if (
    log === undefined ||
    (log.deliveryId !== undefined && log.deliveryId !== record.delivery_id) ||
    record.last_event_seq < log.recordSeq
  ) {
    const seeded = fromRecord(record);
    logs.set(k, seeded);
    return seeded;
  }
  log.deliveryId = record.delivery_id;
  if (record.last_event_seq > log.recordSeq) {
    log.recordSeq = record.last_event_seq;
    log.events = log.events.filter((event) => event.seq > record.last_event_seq);
    log.acceptedSeq = Math.max(log.acceptedSeq, record.last_event_seq);
  }
  return log;
}

export type DeliveryIngestResult =
  | { ok: true; acceptedSeq: number; accepted: number; dropped: number }
  | { ok: false; status: number; error: DeliveryIngestError };

/**
 * Checks a batch of validated events against the bench's delivery and accepted
 * seq, and appends it whole to the log, or refuses it whole. `record` is the
 * bench's record when it has a readable one, undefined while it has none.
 * `spillPath` is the bench's spill file, which takes the oldest events in
 * memory when the batch would take memory over DELIVERY_EVENT_LOG_MAX.
 */
export function ingestDeliveryEvents(
  projectId: string,
  benchId: number,
  record: DeliveryRecord | undefined,
  batch: readonly DeliveryEvent[],
  spillPath: string,
): DeliveryIngestResult {
  const log = syncLog(key(projectId, benchId), record);
  const deliveryId = log.deliveryId ?? batch[0]?.delivery_id;
  for (const [index, event] of batch.entries()) {
    if (event.delivery_id !== deliveryId) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "INVALID_EVENT",
          error: `Invalid delivery event at index ${index}: delivery_id names another delivery than ${deliveryId}`,
          field: "delivery_id",
          index,
        },
      };
    }
  }

  const fresh: DeliveryEvent[] = [];
  let last = log.acceptedSeq;
  for (const [index, event] of batch.entries()) {
    if (event.seq <= log.acceptedSeq) continue;
    if (event.seq <= last) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "STALE_SEQ",
          error: `The event at index ${index} repeats seq ${event.seq} of the same batch`,
          field: "seq",
          index,
          acceptedSeq: log.acceptedSeq,
        },
      };
    }
    if (event.seq !== last + 1) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "SEQ_GAP",
          error: `The event at index ${index} carries seq ${event.seq}, and the next seq is ${last + 1}`,
          field: "seq",
          index,
          acceptedSeq: log.acceptedSeq,
          expected: last + 1,
          got: event.seq,
        },
      };
    }
    fresh.push(event);
    last = event.seq;
  }
  if (fresh.length === 0) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "STALE_SEQ",
        error: `Every seq of the batch is at or below the accepted seq ${log.acceptedSeq}`,
        field: "seq",
        acceptedSeq: log.acceptedSeq,
      },
    };
  }
  // A batch holds at most DELIVERY_EVENT_LOG_MAX events, so spilling every
  // event in memory always makes room.
  let spilled = 0;
  while (
    log.events.length - spilled + fresh.length > DELIVERY_EVENT_LOG_MAX &&
    spilled < log.events.length
  ) {
    spilled += Math.min(DELIVERY_EVENT_SPILL_CHUNK, log.events.length - spilled);
  }
  if (spilled > 0) {
    try {
      appendSpill(spillPath, log.events.slice(0, spilled));
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: {
          code: "EVENT_LOG_SPILL_FAILED",
          error: `The bench holds ${log.events.length} events in memory, at most ${DELIVERY_EVENT_LOG_MAX}, and the oldest could not be written to its spill file: ${(err as Error).message}`,
          acceptedSeq: log.acceptedSeq,
        },
      };
    }
    log.events = log.events.slice(spilled);
  }

  log.deliveryId = deliveryId;
  log.events.push(...fresh);
  noteUnitEvents(log, fresh);
  log.acceptedSeq = last;
  return {
    ok: true,
    acceptedSeq: last,
    accepted: fresh.length,
    dropped: batch.length - fresh.length,
  };
}

// True when the file ends part way through a line: a write that failed after
// some bytes reached it.
function endsMidLine(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

function appendSpill(spillPath: string, events: readonly DeliveryEvent[]): void {
  fs.mkdirSync(path.dirname(spillPath), { recursive: true });
  // A torn last line is closed first, so the first event appended now is a
  // line of its own and not the tail of the torn one.
  const lead = endsMidLine(spillPath) ? "\n" : "";
  fs.appendFileSync(spillPath, lead + events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}

// The events of the spill file that belong to the delivery and sit above
// `afterSeq`, keyed by seq; a later line wins over an earlier one with the same
// seq. A line that is not a valid envelope (the torn tail of a failed write) is
// skipped. No file is no events.
function readSpill(
  spillPath: string,
  deliveryId: string,
  afterSeq: number,
): Map<number, DeliveryEvent> {
  const bySeq = new Map<number, DeliveryEvent>();
  let text: string;
  try {
    text = fs.readFileSync(spillPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return bySeq;
    throw err;
  }
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const event = validateDeliveryEvent(raw);
    if (!event.ok) continue;
    if (event.data.delivery_id !== deliveryId || event.data.seq <= afterSeq) continue;
    bySeq.set(event.data.seq, event.data);
  }
  return bySeq;
}

/**
 * The accepted events above the record's `last_event_seq`, in seq order, for a
 * fold over the record: the ones in the bench's spill file and the ones in
 * memory, one per seq. Seeds the bench's log from the record when it has none.
 */
export function deliveryEventsAfterRecord(
  projectId: string,
  benchId: number,
  record: DeliveryRecord,
  spillPath: string,
): DeliveryEvent[] {
  const log = syncLog(key(projectId, benchId), record);
  const bySeq = readSpill(spillPath, record.delivery_id, record.last_event_seq);
  for (const event of log.events) bySeq.set(event.seq, event);
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  // The spill file can hold events that this log has not seen since a restart.
  noteUnitEvents(log, events);
  return events;
}

/**
 * The span of a unit's accepted events, read after the record so the log is
 * in line with it (see deliveryEventsAfterRecord), or undefined when no
 * accepted event the log knows names the unit.
 */
export function deliveryUnitEventSpan(
  projectId: string,
  benchId: number,
  record: DeliveryRecord,
  unitId: string,
): DeliveryUnitEventSpan | undefined {
  const log = syncLog(key(projectId, benchId), record);
  const span = log.unitSpans.get(unitId);
  if (span === undefined) return undefined;
  let folded = 0;
  for (const seq of span.seqs) if (seq <= record.last_event_seq) folded += 1;
  return { from: span.first.ts, to: span.last.ts, count: span.seqs.size, folded };
}

/** The bench's accepted seq, or undefined before its events were read or posted. */
export function deliveryAcceptedSeq(projectId: string, benchId: number): number | undefined {
  return logs.get(key(projectId, benchId))?.acceptedSeq;
}

/**
 * Drops a bench's in-memory log (Clear bench, a fresh workspace), or every
 * bench's when none is named. The spill file is in the workspace and goes with it.
 */
export function forgetDeliveryEventLog(projectId?: string, benchId?: number): void {
  if (projectId === undefined || benchId === undefined) {
    logs.clear();
    return;
  }
  logs.delete(key(projectId, benchId));
}
