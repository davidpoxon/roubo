// The events a Spec Bench's delivery session has posted since the bench
// started (SB-FR-006). Held in memory per bench, in seq order, one per seq: a
// repeated seq is the same event sent again and is kept once. The record on
// disk is the durable state; a read folds these events over it, and the fold
// skips every event at or below the record's `last_event_seq`, so losing them
// on a restart loses nothing the record does not already carry.
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";

// The most events kept per bench. The oldest go first: by then the session has
// written them into the record.
export const DELIVERY_EVENTS_MAX = 10_000;

const streams = new Map<string, DeliveryEvent[]>();

function key(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

/** Adds one validated event. Returns false when an event with its seq is already held. */
export function appendDeliveryEvent(
  projectId: string,
  benchId: number,
  event: DeliveryEvent,
): boolean {
  const k = key(projectId, benchId);
  const stream = streams.get(k) ?? [];
  if (stream.some((held) => held.seq === event.seq && held.delivery_id === event.delivery_id)) {
    return false;
  }
  stream.push(event);
  stream.sort((a, b) => a.seq - b.seq);
  if (stream.length > DELIVERY_EVENTS_MAX) stream.splice(0, stream.length - DELIVERY_EVENTS_MAX);
  streams.set(k, stream);
  return true;
}

/** The held events of one delivery, in seq order. */
export function listDeliveryEvents(
  projectId: string,
  benchId: number,
  deliveryId: string,
): DeliveryEvent[] {
  return (streams.get(key(projectId, benchId)) ?? []).filter(
    (event) => event.delivery_id === deliveryId,
  );
}

/** Drops a bench's events (Clear bench), or every bench's when none is named. */
export function forgetDeliveryEvents(projectId?: string, benchId?: number): void {
  if (projectId === undefined || benchId === undefined) {
    streams.clear();
    return;
  }
  streams.delete(key(projectId, benchId));
}
