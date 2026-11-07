// The SpecbenchTestbenchAdapter (SB-FR-026, SB-FR-027, SB-US-009): the
// TestbenchHostResolver's provider for the `specbench` variant, so the
// escalated cases of a gate sitting are marked on the TestBench surfaces and
// written to the same test-results.json through the existing routes.
//
//   - The plan and the results live in the bench workspace's own
//     `.specifications/<slug>/`, beside the delivery record: the folder that
//     the sitting names as its resultsSpecPath. The slug is the focused spec
//     folder's, resolved against the project repoPath.
//   - Reads, and the gates route, are always admitted. A Spec Bench cannot be
//     re-pointed at another spec.
//   - A mark is refused with 400 while no sitting is open, and with 409
//     CROSSCHECK_BLOCKED while the bench's last cross-check holds a blocking
//     class (less an entry exempt for the sitting's gate).
//   - A case marked Not met files a fix unit below the gate through the
//     fix-issue filer, and the sitting lists it in `fixUnitBlockers`. A blocker
//     clears once a `unit.changed` event moves the record's unit that carries
//     its fix issue ref to `done` and the case reads passed in
//     test-results.json; a passing mark that lands after that event clears it
//     too.
import path from "node:path";
import type { Bench, DeliveryFixUnitBlocker } from "@roubo/shared";
import type { DeliveryEvent, DeliveryUnit } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery, ownValue, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectCrossCheckBlock } from "@roubo/shared/delivery-selectors";
import {
  registerTestbenchHostProvider,
  type TestbenchHostProvider,
  type TestbenchHostRefusal,
  type TestbenchStatusMark,
} from "../services/testbench-host-resolver.js";
import { readDeliveryCrossCheck } from "../services/delivery-cross-check-loader.js";
import { deliveryEventsAfterRecord } from "../services/delivery-event-log.js";
import { fileFixIssueAndBlock } from "../services/fix-issue-filer.js";
import { gateTrackerExternalId } from "../services/gate-external-id.js";
import * as stateService from "../services/state.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import { benchDeliveryEventSpillPath, loadBenchDeliveryRecord } from "./delivery-record-loader.js";
import * as testbenchStore from "./testbench-store.js";

/** The message of the 400 a mark gets while the Spec Bench has no sitting open. */
export const SPECBENCH_NO_SITTING_ERROR =
  "Marks are not allowed on this Spec Bench: no gate sitting is open";

/** The unit status that, with a passing case, clears a fix unit's blocker. */
const FIX_UNIT_DONE_STATUS = "done";

/** The open sitting of a bench, or undefined. A sitting with no state reads as open. */
function openSitting(bench: Bench) {
  const sitting = bench.deliverySitting;
  return sitting !== undefined && (sitting.state ?? "open") === "open" ? sitting : undefined;
}

function persist(bench: Bench): void {
  stateService.updateBench(stateService.toPersistedBench(bench));
}

/** The record folded with the accepted events, or undefined when the bench has no readable record. */
function foldBenchDelivery(bench: Bench): DeliverySnapshot | undefined {
  const loaded = loadBenchDeliveryRecord(bench);
  if (!loaded.ok) return undefined;
  try {
    const events = deliveryEventsAfterRecord(
      bench.projectId,
      bench.id,
      loaded.record,
      benchDeliveryEventSpillPath(bench),
    );
    return foldDelivery({ record: loaded.record, events });
  } catch {
    return undefined;
  }
}

// The fix issue ref a record unit carries, when it has one.
function trackerRefOf(unit: DeliveryUnit): string | undefined {
  const tracker = (unit as { tracker?: { ref?: unknown } }).tracker;
  return typeof tracker?.ref === "string" && tracker.ref.length > 0 ? tracker.ref : undefined;
}

// A record unit's tracker ref names the fix issue as filed (`owner/repo#12`)
// or bare (`12`), as the work-units contract writes it.
function refNamesFixIssue(ref: string, fixRef: string): boolean {
  return ref === fixRef || fixRef.endsWith(`#${ref}`);
}

// The effective status of a case in test-results.json, or undefined when it
// has no result or the results cannot be read.
function caseStatusOf(bench: Bench, caseId: string): string | undefined {
  const slug = path.basename(bench.focusedSpecPath ?? "");
  try {
    const caseResults = testbenchStore.readPlanAndResults(bench.workspacePath, slug).results
      ?.caseResults;
    const result = caseResults === undefined ? undefined : ownValue(caseResults, caseId);
    return result?.statusOverride?.status ?? result?.derivedStatus;
  } catch {
    return undefined;
  }
}

/**
 * Clears each blocker of the bench's sitting whose fix unit the folded
 * delivery shows `done` while its case reads passed in test-results.json.
 * Persists the bench when one cleared, and returns the cleared blockers.
 */
export function clearFixUnitBlockers(
  bench: Bench,
  snapshot: DeliverySnapshot,
): DeliveryFixUnitBlocker[] {
  const sitting = bench.deliverySitting;
  const blockers = sitting?.fixUnitBlockers ?? [];
  if (sitting === undefined || blockers.length === 0) return [];
  const doneRefs = Object.values(snapshot.unitsById)
    .filter((unit) => unit.status === FIX_UNIT_DONE_STATUS)
    .flatMap((unit) => {
      const ref = trackerRefOf(unit);
      return ref === undefined ? [] : [ref];
    });
  const cleared = blockers.filter(
    (blocker) =>
      doneRefs.some((ref) => refNamesFixIssue(ref, blocker.fixRef)) &&
      caseStatusOf(bench, blocker.caseId) === "passed",
  );
  if (cleared.length === 0) return [];
  const kept = blockers.filter((blocker) => !cleared.includes(blocker));
  if (kept.length > 0) sitting.fixUnitBlockers = kept;
  else delete sitting.fixUnitBlockers;
  persist(bench);
  return cleared;
}

/**
 * The delivery event route's step for a batch it accepted: a `unit.changed`
 * with status `done` clears the blockers its fix unit held, once the case
 * reads passed. `fold` gives the folded delivery after the batch.
 */
export function applyFixUnitBlockerClearing(
  bench: Bench,
  events: readonly DeliveryEvent[],
  fold: () => DeliverySnapshot | undefined,
): DeliveryFixUnitBlocker[] {
  if ((bench.deliverySitting?.fixUnitBlockers ?? []).length === 0) return [];
  const unitDone = events.some(
    (event) =>
      event.type === "unit.changed" &&
      event.unit_id !== undefined &&
      event.payload.status === FIX_UNIT_DONE_STATUS,
  );
  if (!unitDone) return [];
  try {
    const snapshot = fold();
    return snapshot === undefined ? [] : clearFixUnitBlockers(bench, snapshot);
  } catch (err) {
    console.warn(
      `[specbench-testbench] Could not clear the fix unit blockers of bench ${bench.id}: ${(err as Error).message}`,
    );
    return [];
  }
}

/** What the case status route adds to its answer for a fix unit. */
interface FixUnitOutcome {
  fixUnit?: DeliveryFixUnitBlocker & { linkStatus?: string; alreadyFiled?: true };
  fixUnitError?: { error: string; code?: string };
}

function fixUnitError(error: string, code?: string): FixUnitOutcome {
  return { fixUnitError: code === undefined ? { error } : { error, code } };
}

/**
 * Files a fix unit below the sitting's gate for a case marked Not met, through
 * the fix-issue filer, and lists it in the sitting's `fixUnitBlockers`. A case
 * that holds a blocker already files none again.
 */
async function fileSittingFixUnit(
  bench: Bench,
  mark: TestbenchStatusMark,
): Promise<FixUnitOutcome> {
  const sitting = openSitting(bench);
  if (sitting === undefined) return fixUnitError(SPECBENCH_NO_SITTING_ERROR, "NO_SITTING");
  const held = (sitting.fixUnitBlockers ?? []).find((blocker) => blocker.caseId === mark.caseId);
  if (held !== undefined) return { fixUnit: { ...held, alreadyFiled: true } };

  let gate: workUnitLoader.LoadedVerifyUnit | undefined;
  try {
    gate = workUnitLoader
      .loadVerifyUnits(mark.rootPath, mark.slug)
      .find((loaded) => loaded.unit.id === sitting.gateId);
  } catch (err) {
    return fixUnitError(`The gates of the spec could not be read: ${(err as Error).message}`);
  }
  const tracker = gate?.unit.tracker;
  if (tracker === undefined || !tracker.ref) {
    return fixUnitError(
      `Gate ${sitting.gateId} has no tracker issue, so no fix unit can be filed below it`,
      "GATE_UNTRACKED",
    );
  }
  let gateRef: string;
  try {
    gateRef = gateTrackerExternalId(tracker);
  } catch (err) {
    return fixUnitError((err as Error).message, "GATE_UNTRACKED");
  }
  const repoFullName = /^([^#\s]+\/[^#\s]+)#\d+$/.exec(gateRef)?.[1];
  if (repoFullName === undefined) {
    return fixUnitError(
      `Gate ${sitting.gateId} tracker ref '${gateRef}' is not an 'owner/repo#number' ref, so no fix unit can be filed below it`,
      "GATE_UNTRACKED",
    );
  }
  const note = mark.note?.trim() ?? "";
  const notes =
    note.length > 0
      ? note
      : `Case ${mark.caseId} was marked Not met in the sitting of gate ${sitting.gateId}.`;
  let filed;
  try {
    filed = await fileFixIssueAndBlock(bench.projectId, {
      repoFullName,
      failedCaseId: mark.caseId,
      gateRef,
      notes,
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return fixUnitError(
      `The fix unit could not be filed: ${(err as Error).message}`,
      typeof code === "string" ? code : undefined,
    );
  }
  const blocker: DeliveryFixUnitBlocker = {
    caseId: mark.caseId,
    fixRef: filed.fixIssueRef,
    filedAt: filed.createdAt,
  };
  sitting.fixUnitBlockers = [...(sitting.fixUnitBlockers ?? []), blocker];
  persist(bench);
  return { fixUnit: { ...blocker, linkStatus: filed.linkStatus } };
}

async function checkSpecbenchMark(bench: Bench): Promise<TestbenchHostRefusal | undefined> {
  const sitting = openSitting(bench);
  if (sitting === undefined) {
    return { ok: false, status: 400, error: SPECBENCH_NO_SITTING_ERROR, code: "NO_SITTING" };
  }
  // Only a record that loads arms the bench's cross-check, as the sitting route reads it.
  if (!loadBenchDeliveryRecord(bench).ok) return undefined;
  const { disagreements } = await readDeliveryCrossCheck(bench);
  const block = selectCrossCheckBlock(disagreements, "sit", sitting.gateId);
  if (block === null) return undefined;
  return { ok: false, status: 409, error: block.reason, code: block.code, classes: block.classes };
}

export const specbenchTestbenchHostProvider: TestbenchHostProvider = {
  refocusable: false,
  markable: true,
  rootPath: (bench) => bench.workspacePath,
  // The bench keeps the spec folder; the resolver reads the slug from its plan's path.
  focusedSpecPath: (bench) =>
    bench.focusedSpecPath === undefined
      ? undefined
      : path.join(bench.focusedSpecPath, "test-cases.json"),
  checkMark: checkSpecbenchMark,
  async afterStatusMark(bench, mark) {
    if (mark.override === "failed") {
      return { ...(await fileSittingFixUnit(bench, mark)) };
    }
    if (mark.override === "passed" && (bench.deliverySitting?.fixUnitBlockers ?? []).length > 0) {
      const snapshot = foldBenchDelivery(bench);
      const cleared = snapshot === undefined ? [] : clearFixUnitBlockers(bench, snapshot);
      return cleared.length === 0 ? {} : { clearedFixUnits: cleared };
    }
    return {};
  },
};

/** Registers the Spec Bench's TestBench host provider. Called once at server startup. */
export function registerSpecbenchTestbenchAdapter(): void {
  registerTestbenchHostProvider("specbench", specbenchTestbenchHostProvider);
}
