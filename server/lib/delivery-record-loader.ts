// Loads a Spec Bench's delivery record (SB-FR-002, SB-FR-009). The record is
// `delivery-observation.json` in the spec folder the bench focuses on,
// `.specifications/<slug>/` in the project checkout, so it outlives the bench.
//
// Nothing is cached: every read goes back to the file and checks it against the
// record schema, so a record edited on disk, or read again after a restart, is
// validated again before any view sees it. A record that fails gives one named
// error (see checkDeliveryRecord in @roubo/shared/delivery-bench).
import fs from "node:fs";
import {
  DELIVERY_RECORD_FILE,
  checkDeliveryRecord,
  type DeliveryRecordCheck,
} from "@roubo/shared/delivery-bench";
import { assertRealpathWithin, resolveWithin, UnsafePathError } from "./safe-path.js";

// A record larger than this is refused unread. The record describes one
// delivery, so a file this size is not one.
export const DELIVERY_RECORD_MAX_BYTES = 8 * 1024 * 1024;

/** The absolute path of the record in a spec folder. */
export function deliveryRecordPath(specFolder: string): string {
  return resolveWithin(specFolder, DELIVERY_RECORD_FILE);
}

export function loadDeliveryRecord(specFolder: string): DeliveryRecordCheck {
  let recordPath: string;
  try {
    recordPath = deliveryRecordPath(specFolder);
    assertRealpathWithin(specFolder, recordPath, "delivery record path");
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return {
        ok: false,
        error: {
          code: "DELIVERY_INVALID",
          error: `The delivery record path is unsafe: ${err.message}`,
          errors: [err.message],
        },
      };
    }
    throw err;
  }

  const stat = fs.statSync(recordPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_RECORD_MISSING",
        error: `No delivery record yet: ${DELIVERY_RECORD_FILE} is not in the spec folder`,
      },
    };
  }
  if (stat.size > DELIVERY_RECORD_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_INVALID",
        error: `The delivery record is ${stat.size} bytes, over the ${DELIVERY_RECORD_MAX_BYTES} byte limit`,
        errors: ["the record is too large"],
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_INVALID",
        error: `The delivery record is not valid JSON: ${(err as Error).message}`,
        errors: ["the record is not valid JSON"],
      },
    };
  }
  return checkDeliveryRecord(raw);
}
