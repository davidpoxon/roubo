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

/** The mono detail line naming the role, attempt and turn, when the event names any. */
export function eventDetail(event: DeliveryEvent): string | null {
  const { role, attempt, turn } = event.payload;
  const parts: string[] = [];
  if (isString(role)) parts.push(role);
  if (typeof attempt === "number") parts.push(`attempt ${attempt}`);
  if (typeof turn === "number") parts.push(`turn ${turn}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const DAY_MS = 86_400_000;

// The count of local calendar days from `from` to `to`. Each date is taken at
// UTC midnight of its local calendar day, so a DST change does not move it.
function calendarDaysBetween(from: Date, to: Date): number {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day(to) - day(from)) / DAY_MS);
}

/**
 * An RFC 3339 time as the timeline shows it, in local time and 24 hours:
 * `13:33:57` on the day of `now`, `Tue 13:33:57` on the six days before it,
 * and `10 Nov 13:33:57` before that or after `now`'s day. The year comes
 * after the month when it is not `now`'s year. `withSeconds: false` drops
 * the seconds (`13:33`).
 */
export function timelineTime(ts: string | null, now = new Date(), withSeconds = true): string {
  if (ts === null) return "no time";
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = [
    parsed.getHours(),
    parsed.getMinutes(),
    ...(withSeconds ? [parsed.getSeconds()] : []),
  ]
    .map(pad)
    .join(":");
  const daysAgo = calendarDaysBetween(parsed, now);
  if (daysAgo === 0) return clock;
  if (daysAgo > 0 && daysAgo < 7) return `${WEEKDAY.format(parsed)} ${clock}`;
  const year = parsed.getFullYear() === now.getFullYear() ? "" : ` ${parsed.getFullYear()}`;
  return `${DAY_MONTH.format(parsed)}${year} ${clock}`;
}

/** An RFC 3339 time as a date and a minute in UTC: `2026-10-16 10:20 UTC`. */
export function utcMinute(ts: string): string {
  const parsed = new Date(ts);
  return Number.isNaN(parsed.getTime())
    ? ts
    : `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The label of a Generation seam marker, its time read against `now`. */
export function seamLabel(seam: TimelineSeamItem, now = new Date()): string {
  return [seam.name, seam.status, timelineTime(seam.at, now), seam.detail]
    .filter((part): part is string => isString(part))
    .join(" · ");
}
