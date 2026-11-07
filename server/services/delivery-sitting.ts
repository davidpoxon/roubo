// The call to a gate sitting of a Spec Bench's delivery (SB-FR-023, SB-US-009).
//
// The delivery event route calls this with the events it just accepted. The
// last `gate.reached` of the batch that names its gate (payload `gate_id`)
// starts the preparation of that gate's sitting, out of band of the route's
// answer: the gate pin service pins the gate commit, restarts the components
// from the pin and smoke-checks the build, and only once that check passes
// raises the bench's `delivery-sitting` notification (see
// services/gate-pin.ts). Until then the sitting reads `preparing`, which the
// Delivery tab shows as the gate waiting for its build.
//
// The gate commit is the head of the top unit the gate runs after, read from
// the folded delivery after the batch. A gate the folded delivery does not
// know, or whose top unit has no head yet, starts nothing. Neither does a
// bench that has a sitting or a pin already.
import type { Bench } from "@roubo/shared";
import type { DeliveryEvent, DeliveryUnit } from "@roubo/shared/delivery-observation-contract";
import { ownValue, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { deliverySpecFolder } from "../lib/delivery-record-loader.js";
import { prepareGateSitting } from "./gate-pin.js";

export const DELIVERY_SITTING_EVENT_TYPE = "gate.reached";

/**
 * The gate commit the record carries for a gate: the head of the top unit of
 * the stack the gate runs after (the unit of `after` on the highest layer, the
 * last of them on a tie), or undefined when that unit has no head yet.
 */
export function gateCommitOf(snapshot: DeliverySnapshot, gateId: string): string | undefined {
  const view = ownValue(snapshot.gatesById, gateId);
  if (view === undefined) return undefined;
  let top: DeliveryUnit | undefined;
  for (const unitId of view.gate.after) {
    const unit = ownValue(snapshot.unitsById, unitId);
    if (unit !== undefined && (top === undefined || unit.layer >= top.layer)) top = unit;
  }
  return top?.head;
}

// The gate the last `gate.reached` of the events names, if any.
function reachedGate(events: readonly DeliveryEvent[]): string | undefined {
  let gateId: string | undefined;
  for (const event of events) {
    if (event.type !== DELIVERY_SITTING_EVENT_TYPE) continue;
    const id = event.payload.gate_id;
    if (typeof id === "string" && id.length > 0) gateId = id;
  }
  return gateId;
}

/**
 * Starts the preparation of the sitting of the gate the batch reached, and
 * returns its promise, or undefined when it starts none. `fold` gives the
 * folded delivery after the batch, or undefined when the bench has no record.
 * Never throws: the preparation runs after the caller answered.
 */
export function applyDeliverySittingPreparation(
  bench: Bench,
  events: readonly DeliveryEvent[],
  fold: () => DeliverySnapshot | undefined,
): Promise<unknown> | undefined {
  const gateId = reachedGate(events);
  if (gateId === undefined) return undefined;
  if (bench.deliverySitting !== undefined || bench.gatePin !== undefined) return undefined;
  try {
    const snapshot = fold();
    if (snapshot === undefined) return undefined;
    const commit = gateCommitOf(snapshot, gateId);
    if (commit === undefined || commit.length === 0) return undefined;
    const resultsSpecPath = deliverySpecFolder(bench);
    return prepareGateSitting(bench, { gateId, commit, resultsSpecPath });
  } catch (err) {
    console.warn(
      `[delivery-sitting] Could not start the sitting of gate ${gateId} on bench ${bench.id}: ${(err as Error).message}`,
    );
    return undefined;
  }
}
