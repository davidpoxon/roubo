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
// The log holds the accepted events above the record's `last_event_seq`, at
// most DELIVERY_EVENT_LOG_MAX of them. Each time the record moves forward, the
// events it now carries leave the log. When the log is full the batch is
// refused whole and nothing is dropped from the log: an event the record does
// not carry yet would otherwise leave a hole in the fold.
//
// A batch is applied whole or not at all: every check runs before anything is
// added, so a refused batch leaves the accepted seq where it was.
import type { DeliveryEvent, DeliveryRecord } from "@roubo/shared/delivery-observation-contract";
import { DELIVERY_EVENT_LOG_MAX, type DeliveryIngestError } from "@roubo/shared/delivery-bench";

interface BenchEventLog {
  // The delivery the log belongs to: the record's, or the first accepted
  // event's while the bench has no record yet.
  deliveryId: string | undefined;
  // The `last_event_seq` of the record the log last saw, 0 before any.
  recordSeq: number;
  acceptedSeq: number;
  // Seq order, dense, every seq above recordSeq.
  events: DeliveryEvent[];
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
  };
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
 */
export function ingestDeliveryEvents(
  projectId: string,
  benchId: number,
  record: DeliveryRecord | undefined,
  batch: readonly DeliveryEvent[],
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
  if (log.events.length + fresh.length > DELIVERY_EVENT_LOG_MAX) {
    return {
      ok: false,
      status: 429,
      error: {
        code: "EVENT_LOG_FULL",
        error: `The bench holds ${log.events.length} events its delivery record does not carry yet, and keeps at most ${DELIVERY_EVENT_LOG_MAX}: write the record, then post again`,
        acceptedSeq: log.acceptedSeq,
      },
    };
  }

  log.deliveryId = deliveryId;
  log.events.push(...fresh);
  log.acceptedSeq = last;
  return {
    ok: true,
    acceptedSeq: last,
    accepted: fresh.length,
    dropped: batch.length - fresh.length,
  };
}

/**
 * The accepted events above the record's `last_event_seq`, in seq order, for a
 * fold over the record. Seeds the bench's log from the record when it has none.
 */
export function deliveryEventsAfterRecord(
  projectId: string,
  benchId: number,
  record: DeliveryRecord,
): DeliveryEvent[] {
  return syncLog(key(projectId, benchId), record).events.slice();
}

/** The bench's accepted seq, or undefined before its events were read or posted. */
export function deliveryAcceptedSeq(projectId: string, benchId: number): number | undefined {
  return logs.get(key(projectId, benchId))?.acceptedSeq;
}

/** Drops a bench's log (Clear bench, a fresh workspace), or every bench's when none is named. */
export function forgetDeliveryEventLog(projectId?: string, benchId?: number): void {
  if (projectId === undefined || benchId === undefined) {
    logs.clear();
    return;
  }
  logs.delete(key(projectId, benchId));
}
