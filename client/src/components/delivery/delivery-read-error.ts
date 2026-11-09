import type { DeliveryReadError } from "@roubo/shared/delivery-bench";

// The title of a delivery read error, as the Delivery tab and the Spec Bench
// card name it: the cause in a few words, before the detail the route sends.
export function readErrorTitle(error: DeliveryReadError): string {
  switch (error.code) {
    case "DELIVERY_NONCONFORMANT":
      return `The delivery record is missing its ${error.section ?? "required"} section`;
    case "DELIVERY_INVALID":
      return error.field
        ? `The delivery record has an invalid ${error.field} field`
        : "The delivery record is invalid";
    case "DELIVERY_VERSION_MISMATCH":
      return `The delivery record is at version ${error.found ?? "unknown"}, and this bench reads ${error.supported ?? "another"}`;
    case "DELIVERY_RECORD_MISSING":
      return "No delivery record yet";
  }
}
