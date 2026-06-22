// Gate lifecycle coordinator (#700, FR-007, US-005, NFR-001).
//
// The impure, I/O side that complements the pure `evaluateGate`
// (`server/lib/gate-evaluator.ts`, #698). When a verify gate's state has
// transitioned to `passed`, `onGatePassed` closes the gate's tracker issue
// through the active integration plugin so the tracker's blocking relationship
// clears and the next batch's units unblock (architecture.md "Happy path",
// lines 155-166).
//
// Scope (issue #700): this module owns the close-on-pass step only. The caller
// gates on `evaluateGate` returning `passed`; a failed / pending / stale gate is
// never handed here, so a premature unblock is impossible by construction. The
// sign-off path that wires `evaluateGate` -> `onGatePassed` is a separate
// architecture row ("TestBench sign-off path", architecture.md:72) and is out of
// scope for this slice.
//
// All plugin failures propagate as a thrown error so the gate is never left
// half-closed: when `applyTransition` rejects, no audit entry is recorded and the
// tracker issue stays open, leaving the downstream blocked (FR-007 AC-4).

import { DONE_STATUSES, type GateAuditEntry, type NormalizedIssue } from "@roubo/shared";
import type { VerifyUnit } from "../lib/gate-evaluator.js";
import * as pluginManager from "./plugin-manager.js";

/**
 * In-memory record of every privileged gate-lifecycle plugin call (NFR-001),
 * mirroring the per-bench broker `AuditLog` (`audit-log.ts`) but scoped to a
 * project + gate rather than a bench. Entries are appended in call order and
 * queried, optionally filtered by `pluginId`, in that same chronological order.
 * This is an in-process store only: nothing is persisted, so the log is empty
 * after a server restart.
 */
export class GateAuditLog {
  private readonly entries: GateAuditEntry[] = [];

  /** Append one entry, preserving insertion (chronological) order. */
  record(entry: GateAuditEntry): void {
    this.entries.push(entry);
  }

  /**
   * Return a copy of the recorded entries in chronological order, optionally
   * filtered by `projectId` and/or `pluginId`. A copy is returned so callers
   * cannot mutate the internal store.
   */
  query(filter: { projectId?: string; pluginId?: string } = {}): GateAuditEntry[] {
    return this.entries.filter((entry) => {
      if (filter.projectId !== undefined && entry.projectId !== filter.projectId) return false;
      if (filter.pluginId !== undefined && entry.pluginId !== filter.pluginId) return false;
      return true;
    });
  }

  /** Drop every recorded entry (test reset / host shutdown). */
  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * The process-wide gate-lifecycle audit log. A single instance accumulates every
 * gate-close call across projects; `query` filters by project / plugin.
 */
export const gateAuditLog = new GateAuditLog();

/**
 * Seams the coordinator depends on, injectable so tests can drive it without a
 * live plugin connection or the global audit log. Defaults wire to the real
 * `pluginManager.invoke` and the process-wide `gateAuditLog`.
 */
export interface GateLifecycleDeps {
  /** Invoke a plugin RPC. Defaults to `pluginManager.invoke`. */
  invoke: typeof pluginManager.invoke;
  /** Record one privileged gate-lifecycle call. Defaults to `gateAuditLog.record`. */
  recordAudit: (entry: GateAuditEntry) => void;
  /** Clock for the audit timestamp. Defaults to `() => new Date().toISOString()`. */
  now: () => string;
}

function defaultDeps(): GateLifecycleDeps {
  return {
    invoke: pluginManager.invoke,
    recordAudit: (entry) => gateAuditLog.record(entry),
    now: () => new Date().toISOString(),
  };
}

/**
 * Whether a normalized issue is in a terminal/done state (idempotency check). An
 * issue whose `currentState` is already done needs no transition; closing it
 * again would be a redundant privileged call.
 */
function isDone(issue: NormalizedIssue): boolean {
  return DONE_STATUSES.has(issue.currentState.toLowerCase());
}

/**
 * Pick a done-bound transition from an issue's `allowedTransitions` (FR-007
 * AC-2). The GitHub / GHE plugins expose exactly `["close"]` for an open issue
 * (`plugins/github-com/src/normalize.ts`), so the common case is direct. The
 * selection is tolerant of casing and of trackers (e.g. Jira) whose transition
 * names embed a done-ish verb. When no transition can be determined, the caller
 * surfaces a clear error rather than guessing (issue #700 open question 1).
 */
export function pickDoneTransition(issue: NormalizedIssue): string | undefined {
  const transitions = issue.allowedTransitions;
  if (transitions.length === 0) return undefined;

  // Verbs that name a done-bound transition, in preference order. `close` is the
  // GitHub/GHE transition; the others cover trackers that name the target state.
  const doneVerbs = ["close", "done", "resolve", "complete", "finish"];
  for (const verb of doneVerbs) {
    const match = transitions.find((t) => t.toLowerCase().includes(verb));
    if (match) return match;
  }

  // A transition whose name lands directly in a done state (e.g. a Jira
  // workflow whose transition is literally named "Closed"/"Done").
  const stateMatch = transitions.find((t) => DONE_STATUSES.has(t.toLowerCase()));
  if (stateMatch) return stateMatch;

  return undefined;
}

/**
 * Close a passed gate's tracker issue so the downstream batch unblocks (FR-007,
 * NFR-001).
 *
 * Hand this ONLY a gate the caller has confirmed is `passed` via `evaluateGate`;
 * the coordinator does not re-evaluate gate state, so a failed / pending gate
 * passed here would still be closed (the caller is the guard, architecture.md
 * happy-path step 3). The flow is:
 *
 *   1. Resolve the gate's tracker issue ref (`gate.tracker.ref`). A gate with no
 *      filed tracker is a no-op (nothing to close).
 *   2. Fetch the issue via the plugin's `getIssue` RPC.
 *   3. If the issue is already done, return without acting (idempotent no-op,
 *      AC-3) and record an `already-done` audit entry.
 *   4. Otherwise pick a done-bound transition from `allowedTransitions` and apply
 *      it via the plugin's `applyTransition` RPC (the same RPC the
 *      `/issues/:externalId/transitions` route uses), then record a `closed`
 *      audit entry.
 *
 * Any plugin RPC rejection propagates: no audit entry is recorded for the failed
 * call and the issue stays open, so the gate is never left half-closed (AC-4).
 *
 * @param projectId the project the gate belongs to.
 * @param gate      the passed verify unit; `tracker.ref` names the issue to close.
 * @param pluginId  the active integration plugin to route the close through.
 * @param deps      injectable seams (plugin invoke, audit sink, clock).
 */
export async function onGatePassed(
  projectId: string,
  gate: VerifyUnit,
  pluginId: string,
  deps: GateLifecycleDeps = defaultDeps(),
): Promise<void> {
  const trackerRef = gate.tracker?.ref;
  // A gate with no filed tracker issue has nothing to close (the tracker block
  // is absent before the unit is filed, work-units-contract.ts:89).
  if (!trackerRef) return;

  const issue = await deps.invoke<NormalizedIssue>(pluginId, "getIssue", {
    externalId: trackerRef,
  });

  // Idempotent no-op: an already-done gate issue is left untouched (AC-3). The
  // skip is still audit-logged so the privileged check is observable (NFR-001).
  if (isDone(issue)) {
    deps.recordAudit({
      ts: deps.now(),
      projectId,
      pluginId,
      gateId: gate.id,
      trackerRef,
      outcome: "already-done",
    });
    return;
  }

  const transitionName = pickDoneTransition(issue);
  if (!transitionName) {
    throw new Error(
      `Cannot close gate ${gate.id}: tracker issue ${trackerRef} exposes no done-bound transition ` +
        `(allowedTransitions=[${issue.allowedTransitions.join(", ")}]).`,
    );
  }

  // Apply the transition. A plugin rejection propagates: nothing below runs, so
  // no audit entry is recorded and the issue stays open (AC-4).
  await deps.invoke<NormalizedIssue>(pluginId, "applyTransition", {
    externalId: trackerRef,
    transitionName,
  });

  deps.recordAudit({
    ts: deps.now(),
    projectId,
    pluginId,
    gateId: gate.id,
    trackerRef,
    transitionName,
    outcome: "closed",
  });
}
