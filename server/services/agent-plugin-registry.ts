import type { PluginManifest } from "@roubo/shared";
import type { AgentLaunchDescriptor } from "@roubo/shared/agent-launch-descriptor-schema";
import type { JsonRpcConnection } from "./plugin-rpc.js";
import {
  getAgentManifests,
  getConnection,
  getRecord,
  invoke,
  HOST_API_VERSION,
} from "./plugin-manager.js";
import { hasConsent } from "./plugin-consent-state.js";

// AgentPluginRegistry (issue #507, AP-FR-001, AP-US-001).
//
// The inventory of installed `agent`-kind plugins, plus the gate that resolves
// one to the live per-plugin JSON-RPC connection plugin-manager already owns.
// Like ComponentPluginRegistry this is intentionally thin: it spawns nothing and
// caches nothing of its own. An agent plugin is spawned-and-RPC exactly like an
// integration plugin (architecture note in plugin-manager's spawn seam), so all
// this registry adds over `getConnection` is the ordered availability chain.
//
// The gate order is deliberately identical to component-plugin-registry's
// (not-installed -> incompatible -> not-consented -> plugin-unavailable), which
// is what makes AP-TC-014 S002 true: declining consent leaves an installed,
// running agent plugin inert, because every path that would use it resolves to
// `not-consented` before a connection is ever handed out.

/**
 * Why an agent could not be resolved to a live connection:
 *
 * - `not-installed`: no PluginRecord for that id. Checked first so an unknown id
 *   yields install guidance rather than misleading consent guidance.
 * - `not-an-agent`: the id resolves to an installed plugin of a different kind.
 * - `incompatible`: installed but held in status `incompatible` because its
 *   manifest `roubo` range is not satisfied by the host API version, so it was
 *   never spawned. Checked before the consent gate so the real blocker is named.
 * - `not-consented`: no persisted ConsentRecord, so the user has not
 *   acknowledged the plugin's declared permissions. Checked before the
 *   connection, so a plugin that happens to be running still cannot back a
 *   launch (AP-TC-014 S002).
 * - `plugin-unavailable`: installed, compatible, and consented, but not
 *   currently running (disabled, invalid, errored, or mid-restart).
 */
export type AgentNotAvailable =
  | { reason: "not-installed"; pluginId: string }
  | { reason: "not-an-agent"; pluginId: string; kind: string | undefined }
  | { reason: "incompatible"; pluginId: string; requiredRange: string; hostVersion: string }
  | { reason: "not-consented"; pluginId: string }
  | { reason: "plugin-unavailable"; pluginId: string };

export interface ResolvedAgent {
  pluginId: string;
  manifest: PluginManifest;
  connection: JsonRpcConnection;
}

export function isAgentNotAvailable(
  value: ResolvedAgent | AgentNotAvailable,
): value is AgentNotAvailable {
  return "reason" in value;
}

/**
 * Every installed `agent`-kind plugin, whatever its status. Callers that need to
 * know whether an entry is actually usable go through `resolveAgent`; this is
 * the enumeration a settings list renders, so an incompatible or unconsented
 * agent is still visible (with its blocker explained) rather than vanishing.
 */
export function listAgents(): PluginManifest[] {
  return getAgentManifests();
}

/**
 * Resolve an agent plugin id to its live JSON-RPC connection, or an
 * `AgentNotAvailable` explaining why it could not be resolved.
 */
export function resolveAgent(pluginId: string): ResolvedAgent | AgentNotAvailable {
  // Existence gate: an uninstalled id has no PluginRecord, so it must not fall
  // through to the consent gate and be told to acknowledge permissions for a
  // plugin that cannot be consented (the CP-TC-025 precedent).
  const record = getRecord(pluginId);
  if (record === undefined) {
    return { reason: "not-installed", pluginId };
  }

  const manifest = record.manifest;
  if (manifest?.kind !== "agent") {
    return { reason: "not-an-agent", pluginId, kind: manifest?.kind };
  }

  // Compatibility gate: a plugin whose required manifest `roubo` range is not
  // satisfied by the host is held in status `incompatible` and never spawned.
  // Surfaced before the consent gate so the version mismatch is named rather
  // than misleading "acknowledge permissions" guidance.
  if (record.status === "incompatible") {
    return {
      reason: "incompatible",
      pluginId,
      requiredRange: manifest.roubo ?? "unknown",
      hostVersion: HOST_API_VERSION,
    };
  }

  // Consent gate (AP-TC-014 S002): refuse to resolve an agent whose plugin has
  // no ConsentRecord. Checked before getConnection so declining consent leaves
  // the plugin inert no matter what its process is doing.
  if (!hasConsent(pluginId)) {
    return { reason: "not-consented", pluginId };
  }

  const connection = getConnection(pluginId);
  if (!connection) return { reason: "plugin-unavailable", pluginId };

  return { pluginId, manifest, connection };
}

/** Human-readable explanation of an `AgentNotAvailable`, for API/UI surfacing. */
export function describeAgentNotAvailable(notAvailable: AgentNotAvailable): string {
  switch (notAvailable.reason) {
    case "not-installed":
      return `Agent plugin "${notAvailable.pluginId}" is not installed. Install it from the marketplace.`;
    case "not-an-agent":
      return `Plugin "${notAvailable.pluginId}" is kind "${notAvailable.kind ?? "unknown"}", not an agent plugin.`;
    case "incompatible":
      return `Agent plugin "${notAvailable.pluginId}" requires roubo "${notAvailable.requiredRange}" but host is ${notAvailable.hostVersion}.`;
    case "not-consented":
      return `Agent plugin "${notAvailable.pluginId}" has not been consented. Acknowledge its declared permissions before using it.`;
    case "plugin-unavailable":
      return `Agent plugin "${notAvailable.pluginId}" is installed but not currently running.`;
  }
}

/**
 * The launch-descriptor RPC (AP-FR-001): ask a resolved agent plugin to
 * translate a launch request into an `AgentLaunchDescriptor`.
 *
 * This goes through plugin-manager's ordinary `invoke()` path, the same
 * timeout-and-cancellation-wrapped request every integration and component
 * method uses, so an agent plugin needs no bespoke transport. The returned value
 * is UNVALIDATED here on purpose: `agent-launch-executor.validateDescriptor`
 * owns the Zod gate, so validation cannot be skipped by a caller that reaches
 * for the raw RPC.
 */
export async function requestLaunchDescriptor(
  pluginId: string,
  params: { config: Record<string, unknown>; context: Record<string, unknown> },
  opts?: { timeoutMs?: number },
): Promise<unknown> {
  return invoke<AgentLaunchDescriptor>(pluginId, "translateLaunch", params, opts);
}
