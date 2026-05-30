import type { Bench } from "@roubo/shared";
import { ServiceError } from "./service-error.js";

/**
 * Single source of truth for the blank-workspacePath operability invariant.
 *
 * A persisted bench whose workspacePath fails the safe-path allowlist loads with
 * workspacePath = "" and status "error" (see bench-manager.initialize(), CodeQL #31,
 * js/command-line-injection). Such a bench must never reach a spawn/git/fs sink: every
 * consumer that resolves a path against it would otherwise root the operation at the
 * server's own cwd (path.resolve("", x), path.join("", x), spawn({ cwd: "" }),
 * runCommand(..., "")). Its only valid action is Clear.
 *
 * Operability is defined here, once. Every single-bench operation that runs a command,
 * fs op, or git op must gate on it:
 *   - refusing operations throw (assertBenchOperable, or their own typed error built
 *     from benchNotOperableMessage());
 *   - tolerant chokepoints (clear / auto-clear via git-state.getDirtyState, and
 *     reconcile) branch on isBenchOperable() and succeed/skip instead of throwing.
 */
export function isBenchOperable(bench: Pick<Bench, "workspacePath">): boolean {
  return bench.workspacePath !== "";
}

/**
 * Standard refusal wording for a non-operable bench. Pass an action verb phrase (e.g.
 * "be inspected") to produce the operation-specific variant; omit it for the generic
 * form. Always contains "no valid workspace path" so callers share one message.
 */
export function benchNotOperableMessage(action?: string): string {
  return action
    ? `Bench has no valid workspace path and cannot ${action}; clear it instead.`
    : `Bench has no valid workspace path; clear it instead.`;
}

/**
 * Refuse a non-operable bench with ServiceError(400). For ServiceError-ecosystem
 * callers (services whose routes map ServiceError.statusCode -> HTTP status).
 */
export function assertBenchOperable(bench: Pick<Bench, "workspacePath">, action?: string): void {
  if (!isBenchOperable(bench)) {
    throw new ServiceError(400, benchNotOperableMessage(action));
  }
}
