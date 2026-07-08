import type { NormalizedIssue } from "@roubo/shared";
import * as projectRegistry from "./project-registry.js";
import * as pluginManager from "./plugin-manager.js";
import { ServiceError } from "./service-error.js";

/**
 * Default bound for the single blocking-read RPC the gate may issue. The start
 * path must never hang on a slow integration: a read that does not resolve in
 * this window reads as indeterminate and fails closed (NFR-002, NFR-003).
 */
const DEFAULT_GATE_TIMEOUT_MS = 3000;

export interface AssertGateOpenOptions {
  /**
   * Explicit enforcement decision. When omitted the gate resolves enforcement
   * via `projectRegistry.resolveEnforceIssueDependencies(projectId)`.
   */
  enforce?: boolean;
  /** Upper bound for the blocking-read RPC. Defaults to 3000ms. */
  timeoutMs?: number;
  /**
   * The already-fetched issue. When supplied the gate reads `blockedBy` from it
   * directly and issues NO RPC (NFR-002: at most one blocking read on the start
   * path, and the callers already hold a fresh fetch).
   */
  prefetchedIssue?: NormalizedIssue;
}

/**
 * Hard start-gate. Refuses to start or assign a bench on a unit whose upstream
 * verify gate has not passed, keyed entirely to `enforceIssueDependencies`.
 *
 * - OFF: returns immediately, no gate-blocking, no RPC (FR-006).
 * - ON: reads the issue's `blockedBy`. A non-empty `blockedBy` means an
 *   unresolved upstream gate (the GitHub plugin filters resolved blockers out
 *   before this point), so the start is refused with `409 GATE_BLOCKED` naming
 *   every blocker for traceability.
 * - ON and the blocking state cannot be determined (no active plugin when a
 *   read is needed, RPC error, or timeout): fails closed with
 *   `409 GATE_INDETERMINATE`; the start is never allowed (NFR-003).
 *
 * The decision over `blockedBy` is purely in-memory. This does not evaluate the
 * gate's results or load `work-units.json`; that lifecycle is a separate issue.
 */
export async function assertGateOpen(
  projectId: string,
  externalId: string,
  pluginId: string | undefined,
  opts: AssertGateOpenOptions = {},
): Promise<void> {
  const enforce = opts.enforce ?? projectRegistry.resolveEnforceIssueDependencies(projectId);
  if (!enforce) return;

  const blockedBy = await resolveBlockedBy(externalId, pluginId, opts);

  if (blockedBy.length > 0) {
    const blockers = blockedBy.join(", ");
    throw new ServiceError(
      409,
      `Issue ${externalId} is blocked by an unresolved upstream gate: ${blockers}`,
      { code: "GATE_BLOCKED", blockedBy },
    );
  }
}

/** Options for the shared start-path issue fetch. */
export interface FetchIssueForStartOptions {
  /**
   * Explicit enforcement decision. When omitted the enforcement state is
   * resolved via `projectRegistry.resolveEnforceIssueDependencies(projectId)`.
   */
  enforce?: boolean;
  /** Upper bound for the blocking-read RPC when enforcement is ON. Defaults to 3000ms. */
  timeoutMs?: number;
}

/**
 * Fetch the issue a gated start path needs, applying the gate's blocking-read
 * budget when enforcement is ON so the single read cannot stall the start path.
 *
 * - Enforcement ON: the one `getIssue` RPC is bounded to the gate budget (3s by
 *   default) via {@link fetchIssueBounded}. A timeout, missing plugin, or RPC
 *   error fails closed with `409 GATE_INDETERMINATE` (NFR-002, NFR-003). The
 *   returned issue is then handed to {@link assertGateOpen} as `prefetchedIssue`,
 *   so the whole start request still issues exactly one `getIssue` RPC.
 * - Enforcement OFF: a plain, ungated `getIssue` at the plugin manager's default
 *   RPC bound (the gate never runs, FR-006). Plugin RPC errors propagate to the
 *   caller unchanged so the route can surface them as plugin-RPC errors.
 */
export async function fetchIssueForStart(
  projectId: string,
  externalId: string,
  pluginId: string | undefined,
  opts: FetchIssueForStartOptions = {},
): Promise<NormalizedIssue> {
  const enforce = opts.enforce ?? projectRegistry.resolveEnforceIssueDependencies(projectId);

  if (!pluginId) {
    // The gated callers always resolve an active plugin first; a missing plugin
    // here is the same unknowable state the gate treats as indeterminate.
    throw indeterminate(externalId, "no active integration plugin");
  }

  if (!enforce) {
    return pluginManager.invoke<NormalizedIssue>(pluginId, "getIssue", { externalId });
  }

  return fetchIssueBounded(externalId, pluginId, opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS);
}

/**
 * Obtain the issue's `blockedBy`, reusing a prefetched issue when supplied and
 * otherwise issuing exactly one bounded `getIssue` RPC. Any failure to determine
 * the blocking state (no plugin, RPC error, timeout) fails closed with
 * `409 GATE_INDETERMINATE`.
 */
async function resolveBlockedBy(
  externalId: string,
  pluginId: string | undefined,
  opts: AssertGateOpenOptions,
): Promise<string[]> {
  if (opts.prefetchedIssue) {
    return opts.prefetchedIssue.blockedBy;
  }

  if (!pluginId) {
    throw indeterminate(externalId, "no active integration plugin");
  }

  const issue = await fetchIssueBounded(
    externalId,
    pluginId,
    opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
  );
  return issue.blockedBy;
}

/**
 * Issue exactly one `getIssue` RPC bounded to `timeoutMs`. pluginManager.invoke
 * does not guarantee a hard wall-clock bound, so race it against a timer to
 * enforce the start-path budget. A timeout, or any RPC error, reads as
 * indeterminate and fails closed with `409 GATE_INDETERMINATE`.
 */
async function fetchIssueBounded(
  externalId: string,
  pluginId: string,
  timeoutMs: number,
): Promise<NormalizedIssue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(indeterminate(externalId, `blocking-read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      pluginManager.invoke<NormalizedIssue>(pluginId, "getIssue", { externalId }),
      timeout,
    ]);
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw indeterminate(externalId, "blocking-read failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function indeterminate(externalId: string, reason: string): ServiceError {
  return new ServiceError(
    409,
    `Cannot determine the gate state for issue ${externalId} (${reason}); refusing to start (fail-closed)`,
    { code: "GATE_INDETERMINATE" },
  );
}
