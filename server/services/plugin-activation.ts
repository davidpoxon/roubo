import * as projectRegistry from "./project-registry.js";
import {
  getEffectiveWithGlobal,
  loadOverride,
  IntegrationOverrideError,
} from "./integration-overrides.js";
import * as pluginManager from "./plugin-manager.js";
import { translateSources } from "./plugin-source-translation.js";

interface ActivationResult {
  ok: boolean;
  errors?: Array<{ field?: string; message: string; code?: string }>;
}

/**
 * Memoise the most recently-pushed activation per (pluginId, projectId) so
 * a cold project doesn't pay the JSON-RPC round-trip on every consecutive
 * call. Keyed by a JSON snapshot of the pushed config so a sources/instance
 * change naturally invalidates without having to call `forget*` from every
 * write path.
 *
 * Known gap: if the plugin process crashes and auto-restarts, the host's
 * cache will still think the plugin is activated even though the new
 * process started with an empty `activeConfig`. The next source-bound call
 * will fail with "No active configuration"; the user will see the error
 * once and any subsequent call (after `forgetPluginActivation` is invoked
 * from the next config write, or after the cache entry is replaced by a
 * different snapshot) recovers. Tracked in #119, which removes the
 * singleton (and therefore this cache) entirely by passing sources as an
 * explicit per-call parameter.
 */
const cache = new Map<string, string>(); // key: `${pluginId}::${projectId}` → JSON config hash

function cacheKey(pluginId: string, projectId: string): string {
  return `${pluginId}::${projectId}`;
}

/**
 * Build the PluginConfig payload for the project's effective integration
 * config. Currently produces `{ sources, instance?, allowSelfSignedTls? }`
 * depending on what plugins expect; the plugin's parseConfig is responsible
 * for accepting/rejecting fields it doesn't recognise.
 */
function buildPluginConfig(projectId: string, pluginId: string): Record<string, unknown> | null {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return null;

  let override = null;
  try {
    override = loadOverride(projectId);
  } catch (err) {
    if (!(err instanceof IntegrationOverrideError)) throw err;
    // Malformed override: fall back to committed config so we don't error
    // out source-bound calls just because the settings UI hasn't been
    // opened to repair the file yet.
  }

  const effective = getEffectiveWithGlobal(project.config.integration, override);
  const config: Record<string, unknown> = {
    sources: translateSources(effective.sources, {
      onUnknownCategory: (category) => {
        console.warn(
          `[plugin-activation] ${pluginId}: ignoring unknown source category "${category}" for project ${projectId}`,
        );
      },
    }),
  };

  if (typeof effective.instance === "string" && effective.instance.length > 0) {
    config.instance = effective.instance;
  }

  const advanced = effective.advanced;
  if (advanced && typeof advanced === "object") {
    for (const [k, v] of Object.entries(advanced)) {
      if (v !== undefined && config[k] === undefined) {
        config[k] = v;
      }
    }
  }

  return config;
}

/**
 * Ensure the plugin process has been told about the project's current
 * source selection before a source-bound RPC is invoked.
 *
 * Called from route handlers immediately before `pluginManager.invoke(...,
 * "listIssues" | "listIssueTypes" | "listLabels" | ...)`. Cheap on
 * subsequent calls thanks to the per-(plugin,project) snapshot cache;
 * always pays one JSON-RPC round-trip on the first call after a config
 * change (the cache hashes the pushed config so any change invalidates).
 *
 * Errors are surfaced by throwing — callers should let the existing
 * `sendPluginRpcError` paths translate them into 502/504s.
 */
export async function ensurePluginActivated(projectId: string, pluginId: string): Promise<void> {
  const config = buildPluginConfig(projectId, pluginId);
  if (!config) return; // no config to push; downstream invoke will 503

  const snapshot = JSON.stringify(config);
  const key = cacheKey(pluginId, projectId);
  if (cache.get(key) === snapshot) return;

  const result = await pluginManager.invoke<ActivationResult>(
    pluginId,
    "setActiveConfig",
    { config },
    { timeoutMs: 5_000 },
  );
  if (!result?.ok) {
    // Don't cache a failed activation; surface the first error so the
    // route handler can show something useful.
    const first = result?.errors?.[0];
    const message = first
      ? `[${pluginId}] setActiveConfig rejected: ${first.field ? `${first.field}: ` : ""}${first.message}`
      : `[${pluginId}] setActiveConfig rejected`;
    throw new Error(message);
  }
  cache.set(key, snapshot);
}

/**
 * Drop the cached activation for a project so the next source-bound call
 * re-pushes. Wire this into config-write routes (override save, sources
 * save, global integration save) so users see new config take effect
 * immediately instead of waiting for the next plugin restart.
 */
export function forgetProjectActivation(projectId: string, pluginId?: string): void {
  if (pluginId) {
    cache.delete(cacheKey(pluginId, projectId));
    return;
  }
  for (const key of cache.keys()) {
    if (key.endsWith(`::${projectId}`)) cache.delete(key);
  }
}

/**
 * Drop the cached activation for every project that was activated against a
 * given plugin. Wire into global-scope plugin config writes (e.g. captured
 * user id changes, instance change on the global GHE config) since those
 * affect every project that inherits from the global defaults.
 */
export function forgetPluginActivation(pluginId: string): void {
  const prefix = `${pluginId}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Drop all cached activations. Used by tests; also fine for plugin reloads. */
export function clearActivationCache(): void {
  cache.clear();
}
