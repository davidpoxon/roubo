// Failed-case fix-issue filer (#706, FR-009, FR-010, NFR-003; spec
// .specifications/verify-gate/architecture.md "FixIssueFiler").
//
// On marking a gating case failed or blocked, the verifier captures notes and
// files a tracker fix issue that is wired to block the gate. This service is the
// orchestrator for that flow: it sits on top of the already-shipped
// tracker-action gateway (#705) and turns its two privileged ops (createIssue,
// addBlockedBy) into a single create-then-link operation with partial-failure
// recovery.
//
// The contract this module guarantees:
//   - Pre-flight (NFR-005). Before creating anything, it checks that the active
//     plugin declares BOTH `supportsCreateIssue` and `supportsBlockingLinks`. A
//     gate that can be created but never linked would leave an orphan fix issue
//     and a falsely passable gate, so the filer degrades loudly UP FRONT (a typed
//     TrackerActionError with code "capability-absent") rather than creating an
//     issue it can never wire up.
//   - Create-then-link (FR-009, FR-010). createIssue, then addBlockedBy: the new
//     fix issue is registered as a blocker on the gate's tracker issue.
//   - Link-pending recovery (NFR-003). When createIssue succeeds but addBlockedBy
//     fails afterwards (a transient tracker error), the filer returns a
//     FixIssueRecord with `linkStatus: 'link_pending'` carrying the created
//     `fixIssueRef`. The route surfaces this as a partial (207) and the operator
//     retries with `existingFixRef` set, which runs ONLY the link step against
//     the already-created ref: no duplicate issue is filed.
//   - Empty-notes guard. Filing with empty / whitespace-only notes is rejected
//     before any privileged op runs (no tracker call, no issue created).
//
// The gate is never falsely passable in any of these states. Passability is
// decided by the pure evaluator over the recorded case results (the failed
// gating case keeps the gate non-passable); this filer's FixIssueRecord is a
// per-request shape, never the source of truth for gate state. The durable
// blocking relationship lives in the tracker (`tracker.blocked_by_refs` is its
// derived projection), set by the addBlockedBy op, not stored locally.

import type { CreateIssueResult } from "@roubo/plugin-sdk";
import type { FixIssueRecord } from "@roubo/shared";
import { resolveActivePlugin } from "./active-plugin.js";
import { TrackerActionError, addBlockedBy, createIssue } from "./tracker-action-gateway.js";
import * as pluginManager from "./plugin-manager.js";

/**
 * Seams the filer depends on, injectable so tests can drive it without a live
 * plugin connection. Mirrors the gateway's deps-factory style: each default
 * delegates to the shipped tracker-action gateway and plugin-manager.
 */
export interface FixIssueFilerDeps {
  /** Resolve the active integration plugin id for a project (null when none). */
  resolveActivePlugin: typeof resolveActivePlugin;
  /** Read a plugin's declared manifest capabilities (null when unknown). */
  getCapabilities: (pluginId: string) => Record<string, boolean | undefined> | null;
  /** Create a fix issue through the consented, audit-logged gateway op. */
  createIssue: typeof createIssue;
  /** Register an "is blocked by" link through the consented, audit-logged op. */
  addBlockedBy: typeof addBlockedBy;
  /** Clock for the record timestamp. Defaults to `() => new Date().toISOString()`. */
  now: () => string;
}

/**
 * Default capability reader: the active plugin's manifest `capabilities` object
 * from the installed-plugin record (the same shape the gateway uses). Returns
 * null when the plugin is not installed or has no parsed manifest.
 */
function defaultGetCapabilities(pluginId: string): Record<string, boolean | undefined> | null {
  const record = pluginManager.listInstalled().find((r) => r.id === pluginId);
  if (!record?.manifest) return null;
  return record.manifest.capabilities ?? {};
}

function defaultDeps(): FixIssueFilerDeps {
  return {
    resolveActivePlugin,
    getCapabilities: defaultGetCapabilities,
    createIssue,
    addBlockedBy,
    now: () => new Date().toISOString(),
  };
}

/**
 * Filing was rejected because the verifier's notes were empty / whitespace-only
 * (the route maps this to 422). Distinct from a tracker-action failure: no
 * privileged op was attempted and no issue was created.
 */
export class EmptyNotesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyNotesError";
  }
}

/** Parameters for the repo the fix issue is filed into and how it is titled. */
export interface FileFixIssueParams {
  /** The "owner/repo" the fix issue is created in (passed to createIssue). */
  repoFullName: string;
  /** The failed gating case the fix issue is filed for (e.g. "TC-024"). */
  failedCaseId: string;
  /** The gate's tracker ref the fix issue is wired to block (e.g. "owner/repo#451"). */
  gateRef: string;
  /**
   * Extra tracker refs the SAME fix issue must also block, beyond `gateRef`. A
   * normally-loaded gate has none (its single target is `gateRef`); a merged (or
   * split-of-a-merge) synthetic gate fans out over its source gates, so the fix
   * issue blocks every source's filed issue (issue #435, issue #445), mirroring
   * "sign-off closes every source". Absent/empty keeps the single-target flow
   * behaviour-identical to before.
   */
  additionalGateRefs?: readonly string[];
  /** The verifier's failure notes. Required and non-empty (guarded here). */
  notes: string;
  /**
   * When set, the create step is skipped and ONLY the block-link step runs
   * against this already-created fix issue ref. Drives the link-only retry after
   * a prior `link_pending` outcome (NFR-003).
   */
  existingFixRef?: string;
}

/**
 * Pre-flight the two capabilities the full flow needs, throwing the gateway's
 * typed `capability-absent` error when either is absent. Done UP FRONT so a
 * tracker that can create but not link never leaves an orphan fix issue (the
 * create would succeed and the link would be impossible). The check mirrors the
 * gateway's own REQUIRED_CAPABILITY map; the gateway re-enforces both at call
 * time, so this is a fail-fast, not the only barrier.
 */
function preflightCapabilities(
  projectId: string,
  flags: ("supportsCreateIssue" | "supportsBlockingLinks")[],
  deps: FixIssueFilerDeps,
): void {
  const active = deps.resolveActivePlugin(projectId);
  if (!active) {
    throw new TrackerActionError(
      `No active integration plugin is configured for project "${projectId}", so a fix issue cannot be filed.`,
      "no-active-integration",
    );
  }
  const capabilities = deps.getCapabilities(active.pluginId);
  for (const flag of flags) {
    if (!capabilities || capabilities[flag] !== true) {
      throw new TrackerActionError(
        `Integration plugin "${active.pluginId}" does not declare the "${flag}" capability, so a fix issue cannot be filed and wired to block the gate. ` +
          `File it manually, or use a tracker that supports this action.`,
        "capability-absent",
      );
    }
  }
}

/**
 * File a fix issue for a failed gating case and register it as a blocker on the
 * gate, with create-then-link partial-failure recovery (FR-009, FR-010,
 * NFR-003).
 *
 * Flow:
 *   1. Reject empty / whitespace-only notes before any tracker call.
 *   2. Link-only retry: when `existingFixRef` is set, pre-flight ONLY the
 *      blocking-link capability, run addBlockedBy against the existing ref, and
 *      return `complete`. No new issue is created.
 *   3. Full flow: pre-flight BOTH capabilities, createIssue, then addBlockedBy.
 *      On a post-create addBlockedBy failure, return `link_pending` carrying the
 *      created ref (so the operator can retry the link step alone) rather than
 *      throwing: the issue exists and must not be re-created.
 *
 * A capability-absent or no-active-integration condition throws a typed
 * `TrackerActionError` (the route maps capability-absent to 422). A consent
 * failure or a createIssue failure also propagates (no partial record is
 * returned for a failure that happened before the issue was created).
 */
export async function fileFixIssueAndBlock(
  projectId: string,
  params: FileFixIssueParams,
  deps: FixIssueFilerDeps = defaultDeps(),
): Promise<FixIssueRecord> {
  if (typeof params.notes !== "string" || params.notes.trim().length === 0) {
    throw new EmptyNotesError(
      "Fix issue notes must not be empty: enter a description of the failure before filing.",
    );
  }

  const { failedCaseId, gateRef } = params;
  // Every ref the fix issue must block: the primary gate ref plus any source-gate
  // fan-out refs (merged/split gate, issue #435/#445). For a single-target gate
  // this is just [gateRef], so one addBlockedBy call, identical to before.
  const blockedRefs = [gateRef, ...(params.additionalGateRefs ?? [])];

  // Link-only retry (NFR-003): the issue already exists, so skip create and run
  // only the block-link step against every target. Pre-flight only the link
  // capability.
  if (params.existingFixRef !== undefined && params.existingFixRef.length > 0) {
    preflightCapabilities(projectId, ["supportsBlockingLinks"], deps);
    for (const blockedRef of blockedRefs) {
      await deps.addBlockedBy(projectId, {
        blockedRef,
        blockerRef: params.existingFixRef,
      });
    }
    return {
      fixIssueRef: params.existingFixRef,
      gateRef,
      failedCaseId,
      linkStatus: "complete",
      createdAt: deps.now(),
    };
  }

  // Full flow: both capabilities must be present before we create anything, so a
  // create-then-unlinkable orphan is impossible.
  preflightCapabilities(projectId, ["supportsCreateIssue", "supportsBlockingLinks"], deps);

  const created: CreateIssueResult = await deps.createIssue(projectId, {
    repoFullName: params.repoFullName,
    title: `Fix failed verify case ${failedCaseId} blocking gate ${gateRef}`,
    body: params.notes,
  });

  // Create succeeded. From here a link failure must NOT throw: the issue exists,
  // so we surface the partial state for a link-only retry (NFR-003) rather than
  // letting the operator re-file. The gate stays non-passable regardless: the
  // failed gating case keeps it so. Every target is linked; a failure on any one
  // surfaces link_pending, and the retry re-runs all links against the existing
  // ref (addBlockedBy is idempotent, so already-linked sources are harmless).
  try {
    for (const blockedRef of blockedRefs) {
      await deps.addBlockedBy(projectId, {
        blockedRef,
        blockerRef: created.ref,
      });
    }
  } catch {
    return {
      fixIssueRef: created.ref,
      gateRef,
      failedCaseId,
      linkStatus: "link_pending",
      createdAt: deps.now(),
    };
  }

  return {
    fixIssueRef: created.ref,
    gateRef,
    failedCaseId,
    linkStatus: "complete",
    createdAt: deps.now(),
  };
}
