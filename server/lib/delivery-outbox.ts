// The delivery tooling's outbox (#1659, SB-FR-013): `delivery/outbox.jsonl` in
// the spec folder of the bench workspace, beside the record. The tooling
// appends one `{seq, event, payload, posted}` row per event before it writes
// the record, so the outbox holds every event the record carries, posted or
// not. The event log of a bench keeps only the events above the record's
// `last_event_seq`, so a unit's timeline reads the ones at or below it here.
import fs from "node:fs";
import {
  validateDeliveryEvent,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";

// An outbox larger than this is read from its last DELIVERY_OUTBOX_MAX_BYTES
// only: the newest events are the ones a drill-in looks at.
export const DELIVERY_OUTBOX_MAX_BYTES = 16 * 1024 * 1024;

interface CachedOutbox {
  mtimeMs: number;
  size: number;
  deliveryId: string;
  events: DeliveryEvent[];
}

const cache = new Map<string, CachedOutbox>();

// The file's text, or its last `max` bytes from the first whole line on.
function readTail(file: string, size: number, max: number): string {
  if (size <= max) return fs.readFileSync(file, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(max);
    fs.readSync(fd, buffer, 0, max, size - max);
    const text = buffer.toString("utf8");
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function parseOutbox(text: string, deliveryId: string): DeliveryEvent[] {
  const bySeq = new Map<number, DeliveryEvent>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn last line, or a line that is not JSON
    }
    if (typeof row !== "object" || row === null) continue;
    const event = validateDeliveryEvent((row as { payload?: unknown }).payload);
    if (!event.ok || event.data.delivery_id !== deliveryId) continue;
    // A later row with the same seq wins, as in the spill file.
    bySeq.set(event.data.seq, event.data);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * The events of the delivery `deliveryId` that the outbox at `outboxPath`
 * holds, one per seq, in seq order. A row whose payload is not a valid event
 * envelope, or names another delivery, is left out. No file, or one that
 * cannot be read, is no events. The parse is kept until the file's mtime or
 * size moves. Over `maxBytes`, only the rows in the file's last `maxBytes` are
 * read.
 */
export function readDeliveryOutbox(
  outboxPath: string,
  deliveryId: string,
  maxBytes = DELIVERY_OUTBOX_MAX_BYTES,
): DeliveryEvent[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(outboxPath);
  } catch {
    cache.delete(outboxPath);
    return [];
  }
  const held = cache.get(outboxPath);
  if (
    held !== undefined &&
    held.mtimeMs === stat.mtimeMs &&
    held.size === stat.size &&
    held.deliveryId === deliveryId
  ) {
    return held.events;
  }
  let text: string;
  try {
    text = readTail(outboxPath, stat.size, maxBytes);
  } catch {
    return [];
  }
  const events = parseOutbox(text, deliveryId);
  cache.set(outboxPath, { mtimeMs: stat.mtimeMs, size: stat.size, deliveryId, events });
  return events;
}

/** Drops every held parse; for tests. */
export function forgetDeliveryOutboxCache(): void {
  cache.clear();
}
