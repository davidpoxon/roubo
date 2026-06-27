// Tracker-action gateway (#705, FR-011, NFR-001, NFR-005; spike #704).
//
// The single wrapper around `pluginManager.invoke` for the privileged tracker
// ops: create an issue, register an "is blocked by" link, close a gate's tracker
// issue, and reopen a signed-off gate's tracker issue (issue #830). Centralizing
// them here (architecture.md:66) means the
// capability gating, consent gating, and audit logging live in exactly one
// place, ships GitHub-first, and is testable in isolation.
//
// Each op is gated three ways before it reaches the plugin:
//   1. Capability flag. The active integration plugin's manifest must declare the
//      per-op capability (`supportsCreateIssue` / `supportsBlockingLinks`). When
//      it is absent or false, the gateway NEVER calls the op: it throws a typed
//      `TrackerActionError` with a legible message and audit-logs the refused
//      attempt (NFR-005: a clear degrade, never a silent no-op). close-gate is
//      not a new flag; it reuses the existing `applyTransition` capability
//      (spike #704), so its gate is consent only.
//   2. Consent. The plugin must hold a consent record (NFR-001). An unconsented
//      call is refused and audit-logged, mirroring the undeclared-actions guard.
//   3. Audit. Every privileged op (applied, skipped, or refused) is recorded in
//      the in-process tracker-action audit log, carrying only non-secret refs.
//      No tracker token or secret is ever placed on an audit entry (NFR-001).
//
// close-gate reuses the gate-lifecycle coordinator's `onGatePassed`, which is the
// shipped close-on-pass path (it fetches the issue, picks a done-bound
// transition, and applies it through the same `applyTransition` RPC). The gateway
// adds the consent gate and a tracker-action audit entry around it so close is
// observable in the same log as create and link.

import type { CreateIssueResult } from "@roubo/plugin-sdk";
import type { TrackerActionAuditEntry } from "@roubo/shared";
import type { VerifyUnit } from "../lib/gate-evaluator.js";
import { resolveActivePlugin } from "./active-plugin.js";
import { onGatePassed, onGateReopened } from "./gate-lifecycle-coordinator.js";
import { hasConsent } from "./plugin-consent-state.js";
import * as pluginManager from "./plugin-manager.js";

/** The privileged ops the gateway gates. */
export type TrackerAction = "createIssue" | "addBlockedBy" | "closeGate" | "reopenGate";

/** The capability flag each create/link op requires (close reuses transition). */
const REQUIRED_CAPABILITY = {
  createIssue: "supportsCreateIssue",
  addBlockedBy: "supportsBlockingLinks",
} as const;

/**
 * A privileged tracker op was refused before it reached the plugin, or there is
 * no active integration plugin to route it through. The `reason` is the same
 * legible string recorded on the audit entry; callers (the route layer, the
 * filer) surface it to the operator and map it to the appropriate status (the
 * architecture maps the capability-absent case to 422, architecture.md:147).
 */
export class TrackerActionError extends Error {
  constructor(
    message: string,
    readonly code: "no-active-integration" | "capability-absent" | "not-consented",
  ) {
    super(message);
    this.name = "TrackerActionError";
  }
}

/**
 * In-memory record of every privileged tracker-action call (NFR-001), scoped to
 * a project + plugin (these ops have no bench). Mirrors the per-bench broker
 * `AuditLog` and the gate-close `GateAuditLog`, kept separate so the
 * create/link/close ledger does not overload either bench- or gate-close-scoped
 * shape. In-process only: empty after a server restart.
 */
export class TrackerActionAuditLog {
  private readonly entries: TrackerActionAuditEntry[] = [];

  /** Append one entry, preserving insertion (chronological) order. */
  record(entry: TrackerActionAuditEntry): void {
    this.entries.push(entry);
  }

  /**
   * Return a copy of the recorded entries in chronological order, optionally
   * filtered by `projectId` and/or `pluginId`. A copy is returned so callers
   * cannot mutate the internal store.
   */
  query(filter: { projectId?: string; pluginId?: string } = {}): TrackerActionAuditEntry[] {
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
 * The process-wide tracker-action audit log. A single instance accumulates every
 * create/link/close call across projects; `query` filters by project / plugin.
 */
export const trackerActionAuditLog = new TrackerActionAuditLog();

/**
 * Seams the gateway depends on, injectable so tests can drive it without a live
 * plugin connection, the global audit log, or the real consent / manifest state.
 */
export interface TrackerActionGatewayDeps {
  /** Invoke a plugin RPC. Defaults to `pluginManager.invoke`. */
  invoke: typeof pluginManager.invoke;
  /** Resolve the active integration plugin for a project. */
  resolveActivePlugin: typeof resolveActivePlugin;
  /** Read a plugin's declared manifest capabilities (null when unknown). */
  getCapabilities: (pluginId: string) => Record<string, boolean | undefined> | null;
  /** True when the plugin holds a consent record. */
  hasConsent: (pluginId: string) => boolean;
  /** Close a passed gate's tracker issue. Defaults to `onGatePassed`. */
  onGatePassed: typeof onGatePassed;
  /** Reopen a signed-off gate's tracker issue. Defaults to `onGateReopened`. */
  onGateReopened: typeof onGateReopened;
  /** Record one privileged tracker-action call. Defaults to the global log. */
  recordAudit: (entry: TrackerActionAuditEntry) => void;
  /** Clock for the audit timestamp. Defaults to `() => new Date().toISOString()`. */
  now: () => string;
}

/**
 * Default capability reader: the active plugin's manifest `capabilities` object
 * from the installed-plugin record. Returns null when the plugin is not
 * installed or has no parsed manifest.
 */
function defaultGetCapabilities(pluginId: string): Record<string, boolean | undefined> | null {
  const record = pluginManager.listInstalled().find((r) => r.id === pluginId);
  if (!record?.manifest) return null;
  return record.manifest.capabilities ?? {};
}

function defaultDeps(): TrackerActionGatewayDeps {
  return {
    invoke: pluginManager.invoke,
    resolveActivePlugin,
    getCapabilities: defaultGetCapabilities,
    hasConsent,
    onGatePassed,
    onGateReopened,
    recordAudit: (entry) => trackerActionAuditLog.record(entry),
    now: () => new Date().toISOString(),
  };
}

/**
 * Resolve the active integration plugin id for a project, throwing a typed error
 * when none is configured (the route maps this to a 503-style "no integration").
 */
function requireActivePlugin(projectId: string, deps: TrackerActionGatewayDeps): string {
  const active = deps.resolveActivePlugin(projectId);
  if (!active) {
    throw new TrackerActionError(
      `No active integration plugin is configured for project "${projectId}", so the tracker action cannot run.`,
      "no-active-integration",
    );
  }
  return active.pluginId;
}

/**
 * Enforce consent, and (for create/link) the per-op capability flag, before the
 * op reaches the plugin. On refusal it records a "refused" audit entry and throws
 * a typed `TrackerActionError` (never a silent no-op). Returns nothing on a pass.
 */
function enforceGuards(
  projectId: string,
  pluginId: string,
  action: TrackerAction,
  refs: Record<string, string>,
  deps: TrackerActionGatewayDeps,
): void {
  const refuse = (
    message: string,
    code: "capability-absent" | "not-consented",
    reason: string,
  ): never => {
    deps.recordAudit({
      ts: deps.now(),
      projectId,
      pluginId,
      action,
      outcome: "refused",
      reason,
      refs,
    });
    throw new TrackerActionError(message, code);
  };

  // Consent gate (NFR-001): every privileged op, including close, requires the
  // plugin to be consented.
  if (!deps.hasConsent(pluginId)) {
    refuse(
      `Integration plugin "${pluginId}" is not consented, so the tracker action "${action}" was refused.`,
      "not-consented",
      "plugin not consented",
    );
  }

  // Capability gate (NFR-005): create / link require the declared manifest
  // capability. close-gate reuses the existing transition capability and so has
  // no flag of its own (spike #704).
  if (action === "createIssue" || action === "addBlockedBy") {
    const flag = REQUIRED_CAPABILITY[action];
    const capabilities = deps.getCapabilities(pluginId);
    if (!capabilities || capabilities[flag] !== true) {
      refuse(
        `Integration plugin "${pluginId}" does not declare the "${flag}" capability, so "${action}" cannot run. ` +
          `File it manually, or use a tracker that supports this action.`,
        "capability-absent",
        `capability ${flag} not declared`,
      );
    }
  }
}

/**
 * Create a tracker issue through the active integration plugin (FR-011). Gated on
 * the `supportsCreateIssue` capability and consent; audit-logged. Returns the
 * created issue's external ref, url, and (when available) node id.
 */
export async function createIssue(
  projectId: string,
  params: { repoFullName: string; title: string; body?: string; labels?: string[] },
  deps: TrackerActionGatewayDeps = defaultDeps(),
): Promise<CreateIssueResult> {
  const pluginId = requireActivePlugin(projectId, deps);
  // refs carry only non-secret identifiers (repo + title), never the token.
  const refs = { repoFullName: params.repoFullName, title: params.title };
  enforceGuards(projectId, pluginId, "createIssue", refs, deps);

  const result = await deps.invoke<CreateIssueResult>(pluginId, "createIssue", {
    repoFullName: params.repoFullName,
    title: params.title,
    body: params.body,
    labels: params.labels,
  });

  deps.recordAudit({
    ts: deps.now(),
    projectId,
    pluginId,
    action: "createIssue",
    outcome: "applied",
    refs: { ...refs, ref: result.ref },
  });
  return result;
}

/**
 * Register an "is blocked by" link through the active integration plugin
 * (FR-010/FR-011): `blockedRef` becomes blocked by `blockerRef`. Gated on the
 * `supportsBlockingLinks` capability and consent; audit-logged.
 */
export async function addBlockedBy(
  projectId: string,
  params: { blockedRef: string; blockerRef: string },
  deps: TrackerActionGatewayDeps = defaultDeps(),
): Promise<void> {
  const pluginId = requireActivePlugin(projectId, deps);
  const refs = { blockedRef: params.blockedRef, blockerRef: params.blockerRef };
  enforceGuards(projectId, pluginId, "addBlockedBy", refs, deps);

  await deps.invoke(pluginId, "addBlockedBy", {
    blockedRef: params.blockedRef,
    blockerRef: params.blockerRef,
  });

  deps.recordAudit({
    ts: deps.now(),
    projectId,
    pluginId,
    action: "addBlockedBy",
    outcome: "applied",
    refs,
  });
}

/**
 * Close a passed gate's tracker issue (FR-007/FR-011). Gated on consent (close
 * reuses the existing `applyTransition` capability, so there is no create/link
 * flag); audit-logged through the tracker-action log around the shipped
 * close-on-pass path (`onGatePassed`). The tracker-action ledger records
 * "skipped" only when there is nothing to close (a gate with no filed tracker
 * issue); a gate that does have a filed issue records "applied" once
 * `onGatePassed` runs. `onGatePassed` returns void, so the gateway cannot
 * observe its already-done idempotent no-op here; that nuance is captured at the
 * gate-close granularity by `onGatePassed`'s own `GateAuditLog` entry
 * (`outcome: "already-done"`), not duplicated in this unified ledger.
 *
 * Hand this ONLY a gate the caller has confirmed is `passed`; like
 * `onGatePassed`, the gateway does not re-evaluate gate state.
 */
export async function closeGate(
  projectId: string,
  gate: VerifyUnit,
  deps: TrackerActionGatewayDeps = defaultDeps(),
): Promise<void> {
  const pluginId = requireActivePlugin(projectId, deps);
  const refs: Record<string, string> = { gateId: gate.id };
  const trackerRef = gate.tracker?.ref;
  if (trackerRef) refs.trackerRef = trackerRef;
  enforceGuards(projectId, pluginId, "closeGate", refs, deps);

  // A gate with no filed tracker issue has nothing to close: record a skip so the
  // privileged check is observable, then return (mirrors onGatePassed's no-op).
  if (!trackerRef) {
    deps.recordAudit({
      ts: deps.now(),
      projectId,
      pluginId,
      action: "closeGate",
      outcome: "skipped",
      reason: "gate has no filed tracker issue",
      refs,
    });
    return;
  }

  // onGatePassed owns the fetch / done-check / transition. Its own GateAuditLog
  // entry records the close at the gate-close granularity; the tracker-action
  // entry here records it in the unified create/link/close ledger. A plugin
  // rejection propagates: no "applied" entry is recorded, so the log never shows
  // a close that did not happen.
  await deps.onGatePassed(projectId, gate, pluginId);

  deps.recordAudit({
    ts: deps.now(),
    projectId,
    pluginId,
    action: "closeGate",
    outcome: "applied",
    refs,
  });
}

/**
 * Reopen a signed-off gate's tracker issue (issue #830). The mirror of
 * `closeGate`: gated on consent (reopen reuses the existing `applyTransition`
 * capability, so there is no create/link flag); audit-logged through the
 * tracker-action log around the `onGateReopened` coordinator path. The
 * tracker-action ledger records "skipped" only when there is nothing to reopen
 * (a gate with no filed tracker issue); a gate that does have a filed issue
 * records "applied" once `onGateReopened` runs. `onGateReopened` returns void, so
 * the gateway cannot observe its already-open idempotent no-op here; that nuance
 * is captured at the gate granularity by `onGateReopened`'s own `GateAuditLog`
 * entry (`outcome: "already-open"`), not duplicated in this unified ledger.
 */
export async function reopenGate(
  projectId: string,
  gate: VerifyUnit,
  deps: TrackerActionGatewayDeps = defaultDeps(),
): Promise<void> {
  const pluginId = requireActivePlugin(projectId, deps);
  const refs: Record<string, string> = { gateId: gate.id };
  const trackerRef = gate.tracker?.ref;
  if (trackerRef) refs.trackerRef = trackerRef;
  enforceGuards(projectId, pluginId, "reopenGate", refs, deps);

  // A gate with no filed tracker issue has nothing to reopen: record a skip so
  // the privileged check is observable, then return (mirrors onGateReopened).
  if (!trackerRef) {
    deps.recordAudit({
      ts: deps.now(),
      projectId,
      pluginId,
      action: "reopenGate",
      outcome: "skipped",
      reason: "gate has no filed tracker issue",
      refs,
    });
    return;
  }

  // onGateReopened owns the fetch / open-check / transition. A plugin rejection
  // propagates: no "applied" entry is recorded, so the log never shows a reopen
  // that did not happen.
  await deps.onGateReopened(projectId, gate, pluginId);

  deps.recordAudit({
    ts: deps.now(),
    projectId,
    pluginId,
    action: "reopenGate",
    outcome: "applied",
    refs,
  });
}
