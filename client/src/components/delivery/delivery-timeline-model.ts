import type { DeliveryEvent, DeliverySeam } from "@roubo/shared/delivery-observation-contract";

// The model of a unit's drill-in timeline (SB-FR-013, SB-NFR-003): the unit's
// events, newest first as DESIGN.md's Timeline event reads, with a Generation
// seam marker wherever a seam ran inside the unit. A seam comes from two
// places: the record's `seams` entries whose `unit_id` names the unit, and the
// unit's own `seam.ran` events. The fold moves a record seam's `last_run_at`
// to the `seam.ran` event that ran it, so a record seam with the name and the
// time of one of the unit's `seam.ran` events is that event's seam, marked once.

// The most events the timeline shows: the most recent ones (SB-NFR-003).
export const TIMELINE_MAX_EVENTS = 1_000;

export const SEAM_EVENT_TYPE = "seam.ran";

export interface TimelineEventItem {
  kind: "event";
  key: string;
  event: DeliveryEvent;
}

export interface TimelineSeamItem {
  kind: "seam";
  key: string;
  name: string;
  status: string;
  // The time the seam ran, or null when the record gives none.
  at: string | null;
  detail?: string;
}

export type TimelineItem = TimelineEventItem | TimelineSeamItem;

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function timeOf(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function seamOfEvent(event: DeliveryEvent): TimelineSeamItem {
  const { seam, status, last_run_at: lastRunAt, detail } = event.payload;
  return {
    kind: "seam",
    key: `event-${event.seq}`,
    name: isString(seam) ? seam : "seam",
    status: isString(status) ? status : "ran",
    at: isString(lastRunAt) ? lastRunAt : event.ts,
    ...(isString(detail) && { detail }),
  };
}

/**
 * The timeline of one unit, newest first: its events (at most the most recent
 * TIMELINE_MAX_EVENTS, in seq order), with each seam of the unit placed among
 * them by the time it ran. A record seam with no time sits before every event.
 */
export function buildTimeline(
  unitId: string,
  events: readonly DeliveryEvent[],
  seams: Readonly<Record<string, DeliverySeam>>,
): TimelineItem[] {
  const own = events.filter((event) => event.unit_id === unitId).slice(-TIMELINE_MAX_EVENTS);
  const ranByEvent = new Set(
    own
      .filter((event) => event.type === SEAM_EVENT_TYPE)
      .map((event) => {
        const seam = seamOfEvent(event);
        return `${seam.name}@${seam.at}`;
      }),
  );
  const recordSeams: TimelineSeamItem[] = Object.entries(seams)
    .filter(([, seam]) => seam.unit_id === unitId)
    .map(([name, seam]) => ({
      kind: "seam" as const,
      key: `seam-${name}`,
      name,
      status: seam.status,
      at: seam.last_run_at ?? null,
      ...(isString(seam.detail) && { detail: seam.detail }),
    }))
    .filter((seam) => !ranByEvent.has(`${seam.name}@${seam.at}`))
    .sort((a, b) => timeOf(a.at) - timeOf(b.at));

  const ascending: TimelineItem[] = [];
  let next = 0;
  for (const event of own) {
    const at = timeOf(event.ts);
    while (next < recordSeams.length && timeOf(recordSeams[next].at) <= at) {
      ascending.push(recordSeams[next]);
      next += 1;
    }
    ascending.push(
      event.type === SEAM_EVENT_TYPE
        ? seamOfEvent(event)
        : { kind: "event", key: `event-${event.seq}`, event },
    );
  }
  ascending.push(...recordSeams.slice(next));
  return ascending.reverse();
}

/** The unit's own events, in seq order. */
export function unitEvents(unitId: string, events: readonly DeliveryEvent[]): DeliveryEvent[] {
  return events.filter((event) => event.unit_id === unitId);
}

/** The line a timeline row says about its event. */
export function eventText(event: DeliveryEvent): string {
  const { payload } = event;
  for (const key of ["text", "summary", "detail", "question", "title"] as const) {
    const value = payload[key];
    if (isString(value)) return value;
  }
  if (isString(payload.status)) return `Status ${payload.status}`;
  return event.type;
}

/** Where an event's output sits in a unit's transcript text: [start, end). */
export interface TranscriptMatch {
  start: number;
  end: number;
}

/**
 * The output in a unit's transcript text that an event matches: the last
 * occurrence of the first of the event's own words that the transcript holds,
 * tried in order: the payload's `output`, then the keys its timeline row reads
 * (see `eventText`). The last occurrence, as an event follows the output it
 * reports. Null when the transcript holds none of them.
 */
export function matchEventOutput(text: string, event: DeliveryEvent): TranscriptMatch | null {
  const { payload } = event;
  for (const key of ["output", "text", "summary", "detail", "question", "title"] as const) {
    const needle = payload[key];
    if (!isString(needle)) continue;
    const start = text.lastIndexOf(needle);
    if (start >= 0) return { start, end: start + needle.length };
  }
  return null;
}

/** The mono detail line naming the role, attempt and turn, when the event names any. */
export function eventDetail(event: DeliveryEvent): string | null {
  const { role, attempt, turn } = event.payload;
  const parts: string[] = [];
  if (isString(role)) parts.push(role);
  if (typeof attempt === "number") parts.push(`attempt ${attempt}`);
  if (typeof turn === "number") parts.push(`turn ${turn}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** An RFC 3339 time as the timeline shows it: HH:MM:SS in UTC. */
export function clockTime(ts: string | null): string {
  if (ts === null) return "no time";
  const parsed = new Date(ts);
  return Number.isNaN(parsed.getTime()) ? ts : parsed.toISOString().slice(11, 19);
}

/** The label of a Generation seam marker. */
export function seamLabel(seam: TimelineSeamItem): string {
  return [seam.name, seam.status, seam.at === null ? "no time" : clockTime(seam.at), seam.detail]
    .filter((part): part is string => isString(part))
    .join(" · ");
}

// A CSI or OSC escape sequence, or a lone escape with one following byte: what
// a terminal writes for colour and cursor moves, which a read-only transcript
// does not render. Built from the escape and bell characters, as a regex
// literal may not hold control characters.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-_]`,
  "g",
);

/** A recorded transcript as plain text: escape sequences out, line ends as \n. */
export function transcriptText(lines: readonly string[]): string {
  return lines.join("").replace(ANSI_RE, "").replace(/\r\n?/g, "\n");
}
