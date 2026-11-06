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
import type { Bench } from "@roubo/shared";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { createNotification, dismissByKey } from "./notification.js";

export const DELIVERY_DECISION_RAISED_TYPE = "decision.raised";
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

export function applyDeliveryDecisionNotifications(
  bench: Bench,
  events: readonly DeliveryEvent[],
): void {
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
