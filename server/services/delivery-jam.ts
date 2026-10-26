// The jam notification of a Spec Bench's delivery (SB-FR-019, SB-US-007).
//
// The delivery event route calls this with the events it just accepted. It is
// raised from the event type alone, with no fold of the record: a
// `unit.changed` whose status word classifies as jammed (see
// `classifyUnitStatus`) raises the bench's `delivery-jam` notification for that
// unit, keyed by the unit id, so each jammed unit has one notification and a
// repeat updates it. A `unit.changed` whose status does not classify as jammed
// dismisses that unit's notification, as the map drops the unit's jam mark.
// Only the last status a batch gives a unit counts, so a batch that jams a
// unit and resumes it again raises nothing.
import type { Bench } from "@roubo/shared";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { classifyUnitStatus } from "@roubo/shared/delivery-reducer";
import { createNotification, dismissByKey } from "./notification.js";

export const DELIVERY_JAM_EVENT_TYPE = "unit.changed";

// The last status word the events give each unit, in the order the units first
// appear.
function lastStatusByUnit(events: readonly DeliveryEvent[]): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const event of events) {
    if (event.type !== DELIVERY_JAM_EVENT_TYPE) continue;
    const unitId = event.unit_id;
    const status = event.payload.status;
    if (typeof unitId !== "string" || unitId.length === 0) continue;
    if (typeof status !== "string" || status.length === 0) continue;
    statuses.set(unitId, status);
  }
  return statuses;
}

export function applyDeliveryJamNotifications(
  bench: Bench,
  events: readonly DeliveryEvent[],
): void {
  for (const [unitId, status] of lastStatusByUnit(events)) {
    if (classifyUnitStatus(status) === "jammed") {
      createNotification(
        bench,
        "delivery-jam",
        undefined,
        { unitId, status },
        undefined,
        undefined,
        unitId,
      );
    } else {
      dismissByKey(bench, "delivery-jam", unitId);
    }
  }
}
