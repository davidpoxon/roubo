import type { DeliverySnapshotResponse } from "@roubo/shared/delivery-bench";

// The words a gate sitting reads as (SB-FR-023): the gate waits for
// its build until the pinned build passed its smoke check, then it is ready to
// sit, and the operator is called; then the sitting opens.

export type DeliverySittingView = NonNullable<DeliverySnapshotResponse["sitting"]>;
export type DeliverySittingPhase = NonNullable<DeliverySittingView["state"]>;

const SITTING_LABELS: Record<DeliverySittingPhase, string> = {
  preparing: "waiting for build",
  ready: "ready to sit",
  open: "sitting open",
};

/** The phase of a sitting; a sitting with no state reads as open. */
export function sittingPhase(sitting: DeliverySittingView): DeliverySittingPhase {
  return sitting.state ?? "open";
}

/** The words a gate's sitting reads as: "waiting for build", "ready to sit". */
export function sittingLabel(sitting: DeliverySittingView): string {
  return SITTING_LABELS[sittingPhase(sitting)];
}
