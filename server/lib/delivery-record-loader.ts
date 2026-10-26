// Loads a Spec Bench's delivery record (SB-FR-002, SB-FR-009). The record is
// `delivery-observation.json` in `.specifications/<slug>/` inside the bench
// workspace, where the delivery session that the bench launches runs and writes
// it. The slug is the one of the spec folder the bench focuses on in the project
// checkout, but the record in that checkout folder is never read or written:
// the record lives only in the workspace and goes with it when Clear bench or
// Cleanup & Retry removes it. A record placed in the checkout reaches the bench
// only as a committed file that the worktree checks out. The spill file of the
// bench's event log sits beside the record and goes with the workspace too. The
// spec's plan and results, which the fold reads for gate state and progress,
// are read from the same workspace folder (`loadBenchDeliveryVerifyInputs`).
//
// Nothing is cached: every read goes back to the file and checks it against the
// record schema, so a record edited on disk, or read again after a restart, is
// validated again before any view sees it. A record that fails gives one named
// error (see checkDeliveryRecord in @roubo/shared/delivery-bench).
import fs from "node:fs";
import path from "node:path";
import type { Bench } from "@roubo/shared";
import {
  DELIVERY_EVENT_SPILL_FILE,
  DELIVERY_RECORD_FILE,
  checkDeliveryRecord,
  type DeliveryRecordCheck,
} from "@roubo/shared/delivery-bench";
import type { DeliveryFoldInputs } from "@roubo/shared/delivery-reducer";
import { MissingPlanError, readPlanAndResults } from "./testbench-store.js";
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  resolveWithin,
  SPEC_SLUG_RE,
  UnsafePathError,
} from "./safe-path.js";

// A record larger than this is refused unread. The record describes one
// delivery, so a file this size is not one.
export const DELIVERY_RECORD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The spec folder of a Spec Bench's delivery inside its workspace:
 * `<workspacePath>/.specifications/<slug>`, with the slug of the focused spec
 * folder. Throws UnsafePathError when the slug fails the allowlist or the
 * folder would leave the workspace.
 */
export function deliverySpecFolder(
  bench: Pick<Bench, "workspacePath" | "focusedSpecPath">,
): string {
  const slug = path.basename(bench.focusedSpecPath ?? "");
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const folder = resolveWithin(bench.workspacePath, ".specifications", slug);
  assertRealpathWithin(bench.workspacePath, folder, "delivery spec folder");
  return folder;
}

function unsafePath(err: UnsafePathError): DeliveryRecordCheck {
  return {
    ok: false,
    error: {
      code: "DELIVERY_INVALID",
      error: `The delivery record path is unsafe: ${err.message}`,
      errors: [err.message],
    },
  };
}

/** Loads the delivery record of a Spec Bench from its workspace. */
export function loadBenchDeliveryRecord(
  bench: Pick<Bench, "workspacePath" | "focusedSpecPath">,
): DeliveryRecordCheck {
  let folder: string;
  try {
    folder = deliverySpecFolder(bench);
  } catch (err) {
    if (err instanceof UnsafePathError) return unsafePath(err);
    throw err;
  }
  return loadDeliveryRecord(folder);
}

/**
 * The spill file of a Spec Bench's delivery event log: beside the record in
 * the spec folder of the bench workspace, so it goes with the workspace. Throws
 * UnsafePathError when the path would leave the workspace.
 */
export function benchDeliveryEventSpillPath(
  bench: Pick<Bench, "workspacePath" | "focusedSpecPath">,
): string {
  const folder = deliverySpecFolder(bench);
  const spill = resolveWithin(folder, DELIVERY_EVENT_SPILL_FILE);
  assertRealpathWithin(folder, spill, "delivery event spill path");
  return spill;
}

/**
 * The spec's plan and recorded results in the bench workspace, as the delivery
 * fold takes them for gate state and progress (SB-FR-011): the
 * `test-cases.json` and `test-results.json` beside the record. The results
 * carry the live plan hash when they are current and a hash that matches
 * nothing when the plan changed since they were written, so stale results never
 * count a case met (the gates route threads them the same way). A missing or
 * invalid plan, or an unsafe slug, gives neither: the fold then reads every gate
 * `stale` and reports no progress totals.
 */
export function loadBenchDeliveryVerifyInputs(
  bench: Pick<Bench, "workspacePath" | "focusedSpecPath">,
): Pick<DeliveryFoldInputs, "plan" | "results"> {
  const slug = path.basename(bench.focusedSpecPath ?? "");
  try {
    const { plan, results, planHash, stale } = readPlanAndResults(bench.workspacePath, slug);
    if (results === null) return { plan };
    return { plan, results: { ...results, planHash: stale ? `${planHash}::stale` : planHash } };
  } catch (err) {
    if (err instanceof MissingPlanError || err instanceof UnsafePathError) return {};
    throw err;
  }
}

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
    if (err instanceof UnsafePathError) return unsafePath(err);
    throw err;
  }

  const stat = fs.statSync(recordPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_RECORD_MISSING",
        error: `No delivery record yet: ${DELIVERY_RECORD_FILE} is not in the spec folder of the bench workspace`,
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
