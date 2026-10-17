// Loads a Spec Bench's delivery record (SB-FR-002, SB-FR-009). The record is
// `delivery-observation.json` in `.specifications/<slug>/` inside the bench
// workspace, where the delivery session that the bench launches runs and writes
// it. The slug is the one of the spec folder the bench focuses on in the project
// checkout.
//
// The checkout's spec folder keeps the durable copy (SB-FR-004): the bench
// never deletes the record. Before Clear bench or Cleanup & Retry removes the
// workspace, preserveDeliveryRecord copies the workspace record into the
// checkout's spec folder, unless the checkout's record is newer (an attached
// session that writes the checkout's record keeps its later writes); when a workspace is provisioned for attach mode, or
// re-provisioned by Cleanup & Retry, seedWorkspaceDeliveryRecord copies the
// checkout's record into a workspace that has none. Every read still goes to the
// workspace.
//
// Nothing is cached: every read goes back to the file and checks it against the
// record schema, so a record edited on disk, or read again after a restart, is
// validated again before any view sees it. A record that fails gives one named
// error (see checkDeliveryRecord in @roubo/shared/delivery-bench).
import fs from "node:fs";
import path from "node:path";
import type { Bench } from "@roubo/shared";
import {
  DELIVERY_RECORD_FILE,
  checkDeliveryRecord,
  type DeliveryRecordCheck,
} from "@roubo/shared/delivery-bench";
import {
  assertRealpathWithin,
  assertSafeIdentifier,
  normalizeAbsolutePath,
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

/**
 * The spec folder that a Spec Bench focuses on in the project checkout, which
 * keeps the durable copy of the record. Throws UnsafePathError when the path is
 * not absolute or its slug fails the allowlist.
 */
export function checkoutSpecFolder(bench: Pick<Bench, "focusedSpecPath">): string {
  const folder = normalizeAbsolutePath(bench.focusedSpecPath ?? "", "focused spec folder");
  assertSafeIdentifier(path.basename(folder), SPEC_SLUG_RE, "spec slug");
  return folder;
}

// The record path in a spec folder, checked to stay in that folder after
// symlink resolution.
function checkedRecordPath(specFolder: string): string {
  const recordPath = deliveryRecordPath(specFolder);
  assertRealpathWithin(specFolder, recordPath, "delivery record path");
  return recordPath;
}

function isFile(filePath: string): boolean {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Copies the record from the workspace into the checkout's spec folder, so it
 * outlives the workspace. Copies that one file and removes nothing. Returns
 * true when a record was copied, false when the workspace holds none, a path
 * is unsafe (the loader would never have read that record), or the checkout's
 * record is newer. A failed copy throws, so the caller keeps the workspace
 * rather than lose the record.
 *
 * The copy goes only when the workspace record is at least as new as the
 * checkout's (by mtime). In attach mode the session that already runs the
 * delivery keeps writing the checkout's record, while the workspace holds the
 * copy seeded at create time; copying that stale copy back would destroy the
 * newer record. A seeded copy gets a fresh mtime from the copy, so it is never
 * older than the checkout original it came from, and copying it back on
 * teardown rewrites the same content.
 */
export function preserveDeliveryRecord(
  bench: Pick<Bench, "workspacePath" | "focusedSpecPath">,
): boolean {
  let source: string;
  let target: string;
  try {
    source = checkedRecordPath(deliverySpecFolder(bench));
    if (!isFile(source)) return false;
    const folder = checkoutSpecFolder(bench);
    if (!fs.existsSync(folder)) return false;
    target = checkedRecordPath(folder);
  } catch (err) {
    if (err instanceof UnsafePathError) return false;
    throw err;
  }
  if (isFile(target) && fs.statSync(target).mtimeMs > fs.statSync(source).mtimeMs) return false;
  fs.copyFileSync(source, target);
  return true;
}

/**
 * Copies the checkout's record into the workspace when the workspace has none,
 * creating `.specifications/<slug>/` there when needed. A record already in the
 * workspace is left as it is. Returns true when a record was copied.
 */
export function seedWorkspaceDeliveryRecord(
  bench: Pick<Bench, "workspacePath" | "focusedSpecPath">,
): boolean {
  let source: string;
  let folder: string;
  try {
    source = checkedRecordPath(checkoutSpecFolder(bench));
    if (!isFile(source)) return false;
    folder = deliverySpecFolder(bench);
    if (fs.existsSync(checkedRecordPath(folder))) return false;
  } catch (err) {
    if (err instanceof UnsafePathError) return false;
    throw err;
  }
  fs.mkdirSync(folder, { recursive: true });
  let target: string;
  try {
    target = checkedRecordPath(folder);
  } catch (err) {
    if (err instanceof UnsafePathError) return false;
    throw err;
  }
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return true;
}
