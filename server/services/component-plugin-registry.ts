import type { JsonRpcConnection } from "./plugin-rpc.js";
import { getConnection, getRecord, HOST_API_VERSION } from "./plugin-manager.js";
import { getProject } from "./project-registry.js";
import { hasConsent } from "./plugin-consent-state.js";

// ComponentPluginRegistry (issue #608, FR-010, architecture.md 'Components').
//
// Resolves a `roubo.yaml` component-to-plugin binding to the live per-plugin
// JSON-RPC connection. A component plugin is spawned once per plugin (not once
// per bench); benches multiplex over the single shared connection via
// `BenchContext.benchId`. This registry is therefore intentionally thin: it
// reads the binding off the project's parsed config and hands back the live
// connection plugin-manager already owns (the same kind-agnostic supervision
// integration plugins use). It spawns nothing and caches nothing of its own;
// the connection's lifetime is plugin-manager's to own.

/**
 * Why a binding could not be resolved to a live connection. The
 * discriminated-union `reason` lets callers (bench-manager) branch:
 *
 * - `unknown-project`: the project id is not registered.
 * - `invalid-config`: the project's roubo.yaml failed to parse.
 * - `unknown-component`: no component by that name in the project config.
 * - `not-bound`: the component carries no `plugin` binding (a legacy
 *   `type`-only built-in component, which this registry does not own).
 * - `not-installed`: the bound plugin id is not installed at all (no
 *   PluginRecord). Checked before the consent gate so an uninstalled id yields
 *   install guidance rather than misleading consent guidance (issue #408,
 *   CP-TC-025). Consent is reserved for installed-but-unconsented plugins.
 * - `not-consented`: the bound plugin has no persisted ConsentRecord, so the
 *   consumer has not acknowledged its declared permissions. The server refuses
 *   to start the component, spawning no process or container (issue #615,
 *   CP-FR-012, advisory v1 gate). Checked before the connection so a plugin that
 *   happens to be running still cannot back an unconsented component.
 * - `incompatible`: the bound plugin is installed but held in status
 *   `incompatible` because its required manifest `roubo` range is not satisfied
 *   by the host API version, so it was never spawned. Carries the required range
 *   and host version so the bench-start error names the mismatch rather than a
 *   generic "not running" (issue #408, CP-TC-011).
 * - `plugin-unavailable`: the bound plugin is installed and compatible but not
 *   currently running (disabled, invalid, errored, or mid-restart), so there is
 *   no live connection yet.
 */
export type NotBound =
  | { reason: "unknown-project" }
  | { reason: "invalid-config" }
  | { reason: "unknown-component" }
  | { reason: "not-bound" }
  | { reason: "not-installed"; pluginId: string }
  | { reason: "not-consented"; pluginId: string }
  | { reason: "incompatible"; pluginId: string; requiredRange: string; hostVersion: string }
  | { reason: "plugin-unavailable"; pluginId: string };

export interface ResolvedBinding {
  pluginId: string;
  connection: JsonRpcConnection;
}

function isNotBound(value: ResolvedBinding | NotBound): value is NotBound {
  return "reason" in value;
}

export { isNotBound };

/**
 * Resolve `(projectId, componentName)` to the bound plugin's live JSON-RPC
 * connection, or a `NotBound` explaining why it could not.
 *
 * Spawn-once-per-plugin: the returned connection is the single shared
 * per-plugin connection plugin-manager holds, so two benches that bind the same
 * component to the same plugin receive the same connection object and
 * multiplex over it via `BenchContext.benchId`.
 */
export function resolveBinding(
  projectId: string,
  componentName: string,
): ResolvedBinding | NotBound {
  const project = getProject(projectId);
  if (!project) return { reason: "unknown-project" };
  if (!project.configValid || !project.config) return { reason: "invalid-config" };

  // `componentName` is a user-controlled key. Read it through a hasOwnProperty
  // guard rather than a bare index so a crafted name (`__proto__`,
  // `constructor`) cannot reach an inherited object property (CodeQL
  // prototype-pollution guard, mirrors the bench-manager indexing sites).
  const components = project.config.components;
  if (!Object.prototype.hasOwnProperty.call(components, componentName)) {
    return { reason: "unknown-component" };
  }
  const component = components[componentName];
  const binding = component.plugin;
  if (!binding) return { reason: "not-bound" };

  const pluginId = binding.id;

  // Existence gate (issue #408, CP-TC-025): an uninstalled plugin id has no
  // PluginRecord, so it must not fall through to the consent gate and be told to
  // acknowledge permissions for a plugin that cannot be consented. Checked
  // before hasConsent so consent guidance stays reserved for installed plugins.
  const record = getRecord(pluginId);
  if (record === undefined) {
    return { reason: "not-installed", pluginId };
  }

  // Consent gate (issue #615, CP-FR-012, AC5): refuse to resolve a binding whose
  // plugin has no ConsentRecord. Checked before getConnection so nothing is
  // spawned and no process/container is started without acknowledged permissions.
  if (!hasConsent(pluginId)) {
    return { reason: "not-consented", pluginId };
  }

  // getConnection returns null unless the plugin is spawned and connected
  // (disabled, invalid, incompatible, errored, and mid-restart all surface the
  // same way). A version-incompatible plugin is held in status `incompatible`
  // and never spawned, so distinguish it here to surface the range/host mismatch
  // instead of a generic "not running" (issue #408, CP-TC-011); every other
  // null-connection cause remains the single plugin-unavailable outcome.
  const connection = getConnection(pluginId);
  if (!connection) {
    if (record.status === "incompatible") {
      return {
        reason: "incompatible",
        pluginId,
        requiredRange: record.manifest?.roubo ?? "unknown",
        hostVersion: HOST_API_VERSION,
      };
    }
    return { reason: "plugin-unavailable", pluginId };
  }

  return { pluginId, connection };
}
