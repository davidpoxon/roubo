// The decision notification of a Spec Bench's delivery (SB-FR-014, SB-US-005).
//
// The delivery event route calls this with the events it just accepted. It is
// raised from the event type alone, with no fold of the record: a
// `decision.raised` raises the bench's `delivery-decision` notification for
// that decision, keyed by the decision id, so each decision has one
// notification and a repeated raise of the same decision adds none. A
// `decision.answered` or a `decision.overturned` settles the decision and
// dismisses its notification. A `decision.defaulted` leaves it: the default is
// applied, and the operator can still overturn it. Only the last of these
// events that a batch gives a decision counts, so a batch that raises a
// decision and answers it again raises nothing.
//
// A decision the session decided on its own (`decision.decided`, auto mode)
// raises nothing: it waits on the review stack (SB-FR-033). A `review.opened`
// raises one `delivery-decision` notification for the review call (SB-FR-034),
// keyed by the delivery, the trigger and the oldest unreviewed decision, so the
// same review call again raises none. Its metadata carries the count of
// decisions to review and nothing the session wrote (SB-NFR-009): no question,
// rationale, summary or reply reaches it.
import type { Bench } from "@roubo/shared";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { createNotification, dismissByKey } from "./notification.js";

export const DELIVERY_DECISION_RAISED_TYPE = "decision.raised";
export const DELIVERY_REVIEW_OPENED_TYPE = "review.opened";
// The event types that settle a decision and dismiss its notification.
export const DELIVERY_DECISION_SETTLED_TYPES: ReadonlySet<string> = new Set([
  "decision.answered",
  "decision.overturned",
]);

type DecisionNotice =
  | { kind: "raised"; question: string; unitId?: string }
  | { kind: "settled" };

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// The last notice the events give each decision, in the order the decisions
// first appear.
function lastNoticeByDecision(events: readonly DeliveryEvent[]): Map<string, DecisionNotice> {
  const notices = new Map<string, DecisionNotice>();
  for (const event of events) {
    const raised = event.type === DELIVERY_DECISION_RAISED_TYPE;
    if (!raised && !DELIVERY_DECISION_SETTLED_TYPES.has(event.type)) continue;
    const payload = event.payload as Record<string, unknown>;
    const decisionId = payloadString(payload, "decision_id") ?? payloadString(payload, "id");
    if (decisionId === undefined) continue;
    if (!raised) {
      notices.set(decisionId, { kind: "settled" });
      continue;
    }
    const question = payloadString(payload, "question");
    if (question === undefined) continue;
    const unitId = payloadString(payload, "unit_id") ?? event.unit_id;
    notices.set(decisionId, {
      kind: "raised",
      question,
      ...(unitId !== undefined && unitId.length > 0 && { unitId }),
    });
  }
  return notices;
}

/**
 * The dedupe key of a review call's notification: the delivery, the trigger
 * (empty when the event names none) and the oldest unreviewed decision.
 */
export function reviewNotificationKey(
  deliveryId: string,
  trigger: string | undefined,
  oldestId: string,
): string {
  return `review:${deliveryId}:${trigger ?? ""}:${oldestId}`;
}

function payloadIds(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string" && entry.length > 0)
    ? (value as string[])
    : undefined;
}

function applyReviewNotifications(
  bench: Bench,
  events: readonly DeliveryEvent[],
  unreviewedNow: () => readonly string[],
): void {
  for (const event of events) {
    if (event.type !== DELIVERY_REVIEW_OPENED_TYPE) continue;
    const payload = event.payload as Record<string, unknown>;
    // The event lists the decisions to review oldest first; one that lists
    // none reviews what the folded delivery holds unreviewed.
    const unreviewed = payloadIds(payload, "unreviewed") ?? unreviewedNow();
    const oldest = unreviewed[0];
    if (oldest === undefined) continue;
    createNotification(
      bench,
      "delivery-decision",
      undefined,
      { review: true, count: unreviewed.length },
      undefined,
      undefined,
      reviewNotificationKey(event.delivery_id, payloadString(payload, "trigger"), oldest),
    );
  }
}

/**
 * Raises and dismisses the decision notifications of the accepted events.
 * `unreviewedNow` answers the folded delivery's unreviewed decisions, oldest
 * first, for a `review.opened` that lists none; it is read only then.
 */
export function applyDeliveryDecisionNotifications(
  bench: Bench,
  events: readonly DeliveryEvent[],
  unreviewedNow: () => readonly string[] = () => [],
): void {
  applyReviewNotifications(bench, events, unreviewedNow);
  for (const [decisionId, notice] of lastNoticeByDecision(events)) {
    if (notice.kind === "raised") {
      createNotification(
        bench,
        "delivery-decision",
        undefined,
        {
          decisionId,
          question: notice.question,
          ...(notice.unitId !== undefined && { unitId: notice.unitId }),
        },
        undefined,
        undefined,
        decisionId,
      );
    } else {
      dismissByKey(bench, "delivery-decision", decisionId);
    }
  }
}
