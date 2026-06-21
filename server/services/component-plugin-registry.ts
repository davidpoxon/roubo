import type { JsonRpcConnection } from "./plugin-rpc.js";
import { getConnection } from "./plugin-manager.js";
import { getProject } from "./project-registry.js";

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
 * - `plugin-unavailable`: the bound plugin is not currently running (unknown,
 *   disabled, invalid, incompatible, errored, or mid-restart), so there is no
 *   live connection yet.
 */
export type NotBound =
  | { reason: "unknown-project" }
  | { reason: "invalid-config" }
  | { reason: "unknown-component" }
  | { reason: "not-bound" }
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
  // The plugin must be a discovered, running plugin. getConnection returns null
  // unless the plugin is spawned and connected (unknown, disabled, invalid,
  // incompatible, errored, and mid-restart all surface the same way), so a
  // null connection is the single plugin-unavailable outcome.
  const connection = getConnection(pluginId);
  if (!connection) return { reason: "plugin-unavailable", pluginId };

  return { pluginId, connection };
}
