import type { Bench } from "@roubo/shared";

// A Spec Bench keeps its delivery record only in its workspace, so removing the
// workspace (Clear bench, Cancel preparing, Cleanup & Retry) deletes the record
// with it. The bench warns the operator first and asks for a confirmation.

/** The warning in the Clear bench dialog of a Spec Bench whose workspace goes. */
export const CLEAR_DELIVERY_RECORD_WARNING =
  "The delivery record of this Spec Bench lives in its workspace and will be deleted with it. It cannot be recovered.";

/** The warning in the Cleanup & Retry confirmation of a Spec Bench. */
export const RETRY_DELIVERY_RECORD_WARNING =
  "Cleanup & Retry removes the workspace of this Spec Bench and prepares it again. The delivery record in the workspace will be deleted with it. It cannot be recovered.";

/** Whether removing the bench workspace deletes a delivery record. */
export function holdsDeliveryRecord(bench: Pick<Bench, "variant">): boolean {
  return bench.variant === "specbench";
}
