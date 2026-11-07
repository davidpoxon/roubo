// The delivery cross-check (SB-FR-028, SB-US-010): one pure comparison of what
// the delivery record claims, as the folded `DeliverySnapshot` carries it, with
// what the world shows. It returns one entry per disagreement, over nine classes,
// each tied to the source of truth that settles it:
//
//   class                source of truth
//   branch-missing       git
//   head-commit-differs  git
//   record-stale         git
//   layer-order-differs  the stacks resource
//   pr-state-differs     the pull request API
//   base-branch-differs  the pull request API
//   gate-state-differs   test-results.json
//   case-status-differs  test-results.json
//   plan-hash-mismatch   test-results.json
//
// Shape. Like the gate evaluator (`./gate-evaluator`), this module does no I/O,
// reads no clock and mutates none of its inputs: the caller reads git, the stacks
// resource, the pull request query and the results file, and threads them in.
// Identical inputs give a deep-equal list. The gate state is read through
// `evaluateGate` itself, so the cross-check and the gate can never disagree on how
// a set of results reads.
//
// Every comparison is conservative: a class reports a disagreement only when the
// record makes a claim of that kind and the source observes something else. A
// claim the record does not make (a unit with no branch yet, a pull request it has
// not recorded) is never a disagreement.

import {
  ownValue,
  type DeliverySnapshot,
  type DeliveryResults,
} from "@roubo/shared/delivery-reducer";
import type { DeliveryGate, DeliveryUnit } from "@roubo/shared/delivery-observation-contract";
import type { TestCasesPlan } from "@roubo/shared/testbench-contracts";
import {
  evaluateGate,
  indexResolutions,
  isCaseMet,
  readCaseResult,
  type GateLifecycle,
  type GateStatus,
  type VerifyUnit,
} from "./gate-evaluator";

// ── Classes and sources ──

export const DELIVERY_CROSS_CHECK_CLASSES = [
  "branch-missing",
  "head-commit-differs",
  "layer-order-differs",
  "pr-state-differs",
  "base-branch-differs",
  "gate-state-differs",
  "case-status-differs",
  "plan-hash-mismatch",
  "record-stale",
] as const;
export type DeliveryCrossCheckClass = (typeof DELIVERY_CROSS_CHECK_CLASSES)[number];

export type DeliveryCrossCheckSource = "git" | "stack" | "pull-request-api" | "test-results.json";

// The source of truth of each class: the entry's `source` is always this value.
export const DELIVERY_CROSS_CHECK_SOURCES: Readonly<
  Record<DeliveryCrossCheckClass, DeliveryCrossCheckSource>
> = {
  "branch-missing": "git",
  "head-commit-differs": "git",
  "record-stale": "git",
  "layer-order-differs": "stack",
  "pr-state-differs": "pull-request-api",
  "base-branch-differs": "pull-request-api",
  "gate-state-differs": "test-results.json",
  "case-status-differs": "test-results.json",
  "plan-hash-mismatch": "test-results.json",
};

// ── Inputs ──

// What local git shows for one branch: its local head, its remote-tracking head
// (null when the branch was never pushed), and the commit time of the head, as an
// RFC 3339 timestamp.
export interface DeliveryGitBranch {
  localHead: string;
  remoteHead: string | null;
  committedAt: string;
}

// Branch name to what git shows for it. A branch with no key is missing.
export type DeliveryGitObservation = Readonly<Record<string, DeliveryGitBranch>>;

// Stack name to its ordered branch names, base first, as the stacks resource
// lists them. Matched to the record's stacks by name, and to its units through
// each unit's `branch`.
export type DeliveryStacksObservation = Readonly<Record<string, readonly string[]>>;

// One pull request as the query returned it. `state` is the API's word (`open`,
// `closed` or `merged`, in any case); `baseBranch` is the branch it targets.
export interface DeliveryPullRequest {
  state: string;
  baseBranch: string;
  url: string;
}

// Head branch name to its pull request, one entry per pull request the query
// returned.
export type DeliveryPullRequestsObservation = Readonly<Record<string, DeliveryPullRequest>>;

// The plan and lifecycle the snapshot's fold used, when the caller has them.
// Without them the gate is evaluated over the gating set the fold already
// narrowed (`gatesById[id].state.gatingCaseIds`), each case read by its own id.
export interface DeliveryCrossCheckContext {
  plan?: TestCasesPlan;
  lifecycle?: GateLifecycle;
}

// ── Entries ──

// A claimed or observed value: a word, a list (a stack's branch order), a small
// record (a head claimed on more than one side), or null when there is nothing.
export type DeliveryCrossCheckValue =
  string | null | readonly string[] | Readonly<Record<string, string | null>>;

export interface DeliveryCrossCheckEntry {
  class: DeliveryCrossCheckClass;
  // True when the disagreement stops the delivery from landing as recorded; see
  // `crossCheckDelivery` for the reading of each class.
  blocking: boolean;
  // The unit the entry is about. For gate-state-differs and case-status-differs
  // it is the gate's id, which is the id of the verify unit the gate is. Absent on
  // layer-order-differs (see `stack`) and on plan-hash-mismatch.
  unitId?: string;
  // The stack the entry is about, on layer-order-differs.
  stack?: string;
  // The case the entry is about, on case-status-differs.
  caseId?: string;
  // On pr-state-differs: the units above this one in its stack, base first. A
  // pull request that closed mid-stack blocks them, since GitHub does not
  // retarget the pull requests above it.
  blocksAbove?: string[];
  claimed: DeliveryCrossCheckValue;
  observed: DeliveryCrossCheckValue;
  source: DeliveryCrossCheckSource;
}

// ── Readings ──

// The evaluator's own status words. A record's gate `status` is an open word;
// only one of these can be compared with the evaluated state.
const EVALUATOR_STATUSES: ReadonlySet<string> = new Set<GateStatus>([
  "passed",
  "failed",
  "pending",
  "stale",
  "no_gating_cases",
]);

function stringKey(unit: DeliveryUnit, key: string): string | undefined {
  const value = unit[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function prState(pullRequest: DeliveryPullRequest | undefined): string | null {
  return pullRequest === undefined ? null : pullRequest.state.toLowerCase();
}

function entry(
  cls: DeliveryCrossCheckClass,
  blocking: boolean,
  fields: Omit<DeliveryCrossCheckEntry, "class" | "blocking" | "source">,
): DeliveryCrossCheckEntry {
  return { class: cls, blocking, ...fields, source: DELIVERY_CROSS_CHECK_SOURCES[cls] };
}

// The units of a stack in the record's order, base first. Ids the record lists
// in a stack with no unit behind them are skipped.
function stackUnits(snapshot: DeliverySnapshot, stack: string): DeliveryUnit[] {
  const ids = ownValue(snapshot.stacks, stack) ?? [];
  const units: DeliveryUnit[] = [];
  for (const id of ids) {
    const unit = ownValue(snapshot.unitsById, id);
    if (unit !== undefined) units.push(unit);
  }
  return units;
}

function verifyUnitOf(gate: DeliveryGate, testCaseIds: readonly string[]): VerifyUnit {
  return {
    id: gate.id,
    title: gate.id,
    type: "task",
    kind: "verify",
    description: "",
    acceptance_criteria: [],
    depends_on: [...gate.after],
    covers: [...gate.after],
    implements: {
      requirement_ids: [],
      user_story_ids: [],
      test_case_ids: [...testCaseIds],
    },
  };
}

// ── The cross-check ──

// Compare the snapshot with git, the stacks resource, the pull request query and
// the recorded results. Pure: no I/O, no clock, no input mutation.
//
// `results` is the results file with its own plan hash, or null/undefined when
// none exist. `context` is optional: see `DeliveryCrossCheckContext`.
//
// Entries come grouped by class, in the order of DELIVERY_CROSS_CHECK_CLASSES,
// and within a class in the record's order of units, stacks or gates.
export function crossCheckDelivery(
  snapshot: DeliverySnapshot,
  git: DeliveryGitObservation,
  stacks: DeliveryStacksObservation,
  pullRequests: DeliveryPullRequestsObservation,
  results: DeliveryResults | null | undefined,
  context: DeliveryCrossCheckContext = {},
): DeliveryCrossCheckEntry[] {
  const units = Object.values(snapshot.unitsById);
  const gates = Object.values(snapshot.gatesById);
  const current = results ?? null;
  const out: DeliveryCrossCheckEntry[] = [];

  // branch-missing: the record names a branch that git does not have. Blocking:
  // nothing of the unit can land, and every git class below skips the unit.
  for (const unit of units) {
    if (unit.branch === undefined) continue;
    if (ownValue(git, unit.branch) === undefined) {
      out.push(
        entry("branch-missing", true, {
          unitId: unit.id,
          claimed: unit.branch,
          observed: null,
        }),
      );
    }
  }

  // head-commit-differs: the record's local head (`head`) and, when the record
  // carries one, its remote head (the loose `remote_head` key) against git. A
  // mismatch on either side, or both, is one entry for the unit. Blocking: the
  // record describes commits that are not the ones on the branch.
  for (const unit of units) {
    const observedBranch = unit.branch === undefined ? undefined : ownValue(git, unit.branch);
    if (observedBranch === undefined) continue;
    const claimedRemote = stringKey(unit, "remote_head");
    const localDiffers = unit.head !== undefined && unit.head !== observedBranch.localHead;
    const remoteDiffers =
      claimedRemote !== undefined && claimedRemote !== observedBranch.remoteHead;
    if (!localDiffers && !remoteDiffers) continue;
    const claimed: Record<string, string | null> = {};
    const observed: Record<string, string | null> = {};
    if (unit.head !== undefined) {
      claimed.local = unit.head;
      observed.local = observedBranch.localHead;
    }
    if (claimedRemote !== undefined) {
      claimed.remote = claimedRemote;
      observed.remote = observedBranch.remoteHead;
    }
    out.push(entry("head-commit-differs", true, { unitId: unit.id, claimed, observed }));
  }

  // layer-order-differs: the record's order of a stack's branches against the
  // order the stacks resource lists them. Only the branches both sides know are
  // compared: a unit with no branch yet, or a branch the resource lists beyond the
  // record (a trunk it puts first, say), is not an order claim. A stack the
  // resource does not list is skipped. Informational: base-branch-differs reports
  // the pull requests that a reorder actually mistargets.
  for (const stack of Object.keys(snapshot.stacks)) {
    const observedOrder = ownValue(stacks, stack);
    if (observedOrder === undefined) continue;
    const recordBranches = stackUnits(snapshot, stack)
      .map((unit) => unit.branch)
      .filter((branch): branch is string => branch !== undefined);
    const known = new Set(recordBranches);
    const observedKnown = observedOrder.filter((branch) => known.has(branch));
    const shown = new Set(observedKnown);
    const claimedKnown = recordBranches.filter((branch) => shown.has(branch));
    const same =
      claimedKnown.length === observedKnown.length &&
      claimedKnown.every((branch, index) => branch === observedKnown[index]);
    if (!same) {
      out.push(
        entry("layer-order-differs", false, {
          stack,
          claimed: claimedKnown,
          observed: observedKnown,
        }),
      );
    }
  }

  // pr-state-differs: the record claims a pull request for the unit (`pr_url`,
  // or the loose `pr_state` word) and the query shows otherwise. With a
  // `pr_state` claim the words are compared. With only a `pr_url` the claim is a
  // live pull request: `open` and `merged` agree, `closed` (closed unmerged) and
  // absent (the query returned none for the branch) disagree. Blocking when the
  // pull request is closed or absent: the unit cannot land as recorded, and the
  // units above it in the stack are named in `blocksAbove`.
  for (const unit of units) {
    if (unit.branch === undefined) continue;
    const claimedState = stringKey(unit, "pr_state")?.toLowerCase();
    if (claimedState === undefined && unit.pr_url === undefined) continue;
    const observedState = prState(ownValue(pullRequests, unit.branch));
    const differs =
      claimedState !== undefined
        ? claimedState !== observedState
        : observedState !== "open" && observedState !== "merged";
    if (!differs) continue;
    const stackIds = ownValue(snapshot.stacks, unit.stack) ?? [];
    const index = stackIds.indexOf(unit.id);
    const blocksAbove = index < 0 ? [] : stackIds.slice(index + 1);
    out.push(
      entry("pr-state-differs", observedState === null || observedState === "closed", {
        unitId: unit.id,
        blocksAbove,
        claimed: claimedState ?? unit.pr_url ?? null,
        observed: observedState,
      }),
    );
  }

  // base-branch-differs: an open pull request of a unit above the base of its
  // stack must target the branch of the unit below it. The base layer is skipped
  // (the record names no trunk), as is a unit whose lower unit has no branch, and
  // a lower unit whose pull request merged: GitHub then retargets the upper pull
  // request to the trunk, which is not a disagreement. Blocking: the pull request
  // would merge into the wrong branch.
  for (const stack of Object.keys(snapshot.stacks)) {
    const ordered = stackUnits(snapshot, stack);
    for (let index = 1; index < ordered.length; index += 1) {
      const unit = ordered[index];
      const below = ordered[index - 1];
      if (unit.branch === undefined || below.branch === undefined) continue;
      const pullRequest = ownValue(pullRequests, unit.branch);
      if (pullRequest === undefined || prState(pullRequest) !== "open") continue;
      if (prState(ownValue(pullRequests, below.branch)) === "merged") continue;
      if (pullRequest.baseBranch !== below.branch) {
        out.push(
          entry("base-branch-differs", true, {
            unitId: unit.id,
            claimed: below.branch,
            observed: pullRequest.baseBranch,
          }),
        );
      }
    }
  }

  // gate-state-differs: the record's gate status word against `evaluateGate` over
  // the results and the record's plan hash. The record's word is open: only a
  // claim that is one of the evaluator's own words is compared, so a word such as
  // `provisional` (the session's judgement awaiting the operator, whose marks
  // case-status-differs checks) is never a disagreement. Blocking when the record
  // claims `passed` and the results do not: a false pass would let the delivery
  // move past the gate.
  for (const view of gates) {
    const claimed = view.gate.status;
    if (!EVALUATOR_STATUSES.has(claimed)) continue;
    const evaluated =
      context.plan !== undefined
        ? evaluateGate(
            verifyUnitOf(view.gate, view.gate.cases),
            current,
            snapshot.planHash,
            context.plan,
            context.lifecycle,
          )
        : evaluateGate(
            verifyUnitOf(view.gate, view.state.gatingCaseIds),
            current,
            snapshot.planHash,
            undefined,
            context.lifecycle,
          );
    if (evaluated.status !== claimed) {
      out.push(
        entry("gate-state-differs", claimed === "passed", {
          unitId: view.gate.id,
          claimed,
          observed: evaluated.status,
        }),
      );
    }
  }

  // case-status-differs: the record's per-case claims are the provisional marks
  // of its gates (`met` or `not_met`), so the class is confined to them. A mark
  // agrees when `met` reads the same as the result's met reading (`isCaseMet`,
  // as the gate reads it). A case with no recorded result is skipped: the results
  // observe nothing about it. Blocking when the mark says `met` and the result
  // does not, the same false pass as above.
  if (current !== null) {
    const resolutionById = indexResolutions(context.lifecycle);
    for (const view of gates) {
      for (const mark of view.gate.provisionalCases ?? []) {
        const result = readCaseResult(
          mark.case,
          current.caseResults,
          resolutionById,
          context.lifecycle,
        );
        if (result === undefined) continue;
        const resultMet = isCaseMet(result);
        if ((mark.mark === "met") === resultMet) continue;
        const observed =
          result.orphaned === true
            ? "orphaned"
            : (result.statusOverride?.status ?? result.derivedStatus);
        out.push(
          entry("case-status-differs", mark.mark === "met", {
            unitId: view.gate.id,
            caseId: mark.case,
            claimed: mark.mark,
            observed,
          }),
        );
      }
    }
  }

  // plan-hash-mismatch: the record's plan hash against the results' own. With no
  // results there is nothing to compare (the gates read stale, which
  // gate-state-differs reports). Blocking: every result belongs to another plan.
  if (current !== null && current.planHash !== snapshot.planHash) {
    out.push(
      entry("plan-hash-mismatch", true, {
        claimed: snapshot.planHash,
        observed: current.planHash,
      }),
    );
  }

  // record-stale: a branch head committed after the record's `updated_at`, so the
  // record has not caught up with the branch. A time that does not parse is not
  // compared. Informational: the next record write catches up.
  const updatedAt = Date.parse(snapshot.staleness.updatedAt);
  if (!Number.isNaN(updatedAt)) {
    for (const unit of units) {
      const observedBranch = unit.branch === undefined ? undefined : ownValue(git, unit.branch);
      if (observedBranch === undefined) continue;
      const committedAt = Date.parse(observedBranch.committedAt);
      if (Number.isNaN(committedAt) || committedAt <= updatedAt) continue;
      out.push(
        entry("record-stale", false, {
          unitId: unit.id,
          claimed: snapshot.staleness.updatedAt,
          observed: observedBranch.committedAt,
        }),
      );
    }
  }

  return out;
}
