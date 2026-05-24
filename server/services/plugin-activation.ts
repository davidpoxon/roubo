import type { ConfiguredSource } from "@roubo/plugin-sdk";
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
 * Memoise the most recently-pushed plugin-wide config (instance URL, TLS
 * toggle, advanced settings) per plugin so a cold project doesn't pay the
 * JSON-RPC round-trip on every consecutive call. Keyed by a JSON snapshot of
 * the pushed config so any change naturally invalidates.
 *
 * This cache is keyed per plugin (not per project) because the data we push
 * here is plugin-wide: it is identical for every project that uses the
 * plugin. Per-project source selection used to ride along in the same RPC
 * (which is what caused #119's cross-project bleed when two projects used
 * the same plugin) and now flows inline on every source-bound RPC instead;
 * see `resolveSources`.
 */
const cache = new Map<string, string>(); // key: pluginId → JSON config hash

/**
 * Build the plugin-wide config payload (instance, allowSelfSignedTls, any
 * advanced fields). Source selection is supplied per-call via `resolveSources`
 * and is intentionally never included here, so the cached snapshot is safe
 * to share across every project using the plugin.
 */
function buildPluginConfig(projectId: string): Record<string, unknown> | null {
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
  const config: Record<string, unknown> = {};

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
 * Resolve the per-project source selection into the `{ kind, externalId }[]`
 * shape plugins expect under params.sources on source-bound RPCs. Returns
 * an empty list when the project has no sources configured.
 */
export function resolveSources(projectId: string): ConfiguredSource[] {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return [];

  let override = null;
  try {
    override = loadOverride(projectId);
  } catch (err) {
    if (!(err instanceof IntegrationOverrideError)) throw err;
  }

  const effective = getEffectiveWithGlobal(project.config.integration, override);
  const pluginId = effective.plugin ?? "<unknown>";
  return translateSources(effective.sources, {
    onUnknownCategory: (category) => {
      console.warn(
        `[plugin-activation] ${pluginId}: ignoring unknown source category "${category}" for project ${projectId}`,
      );
    },
  });
}

/**
 * Ensure the plugin process has been told about the plugin-wide config
 * (instance URL, TLS toggle, advanced settings) before a source-bound RPC
 * is invoked. If the plugin has no plugin-wide config (e.g. github.com,
 * which has a fixed API host and no TLS knob), this is a no-op.
 *
 * Called from route handlers immediately before each source-bound
 * `pluginManager.invoke(..., "listIssues" | "listIssueTypes" | "listLabels"
 * | ..., { sources, ... })`. Cheap on subsequent calls thanks to the
 * per-plugin snapshot cache; always pays one JSON-RPC round-trip on the
 * first call after a config change.
 *
 * Per-project source selection is supplied inline via the `sources` param
 * on each source-bound RPC (see `resolveSources`), so the plugin process
 * holds no per-project state and there is no race window between projects
 * sharing the same plugin.
 */
export async function ensurePluginActivated(_projectId: string, pluginId: string): Promise<void> {
  const config = buildPluginConfig(_projectId);
  if (!config || Object.keys(config).length === 0) {
    // Nothing plugin-wide to push (e.g. github.com): the plugin will read
    // its sources directly off the per-call params.
    return;
  }

  const snapshot = JSON.stringify(config);
  if (cache.get(pluginId) === snapshot) return;

  let result: ActivationResult | null;
  try {
    result = await pluginManager.invoke<ActivationResult>(
      pluginId,
      "setActiveConfig",
      { config },
      { timeoutMs: 5_000 },
    );
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code === "MethodNotFound") {
      // Plugin doesn't implement setActiveConfig; it has no plugin-wide
      // config to receive. Treat as success and cache to avoid re-trying.
      cache.set(pluginId, snapshot);
      return;
    }
    throw err;
  }

  if (!result?.ok) {
    const first = result?.errors?.[0];
    const message = first
      ? `[${pluginId}] setActiveConfig rejected: ${first.field ? `${first.field}: ` : ""}${first.message}`
      : `[${pluginId}] setActiveConfig rejected`;
    throw new Error(message);
  }
  cache.set(pluginId, snapshot);
}

/**
 * Drop the cached activation for a plugin so the next source-bound call
 * re-pushes its plugin-wide config. Wire this into global plugin config
 * writes (e.g. instance URL change) so the new instance takes effect
 * immediately.
 *
 * The `_projectId` argument is preserved for API compatibility with the
 * pre-#119 per-project cache; activations are now plugin-wide so any
 * project's config change forces a re-push for every project using that
 * plugin (which is what we want for global config changes).
 */
export function forgetProjectActivation(_projectId: string, pluginId?: string): void {
  if (pluginId) {
    cache.delete(pluginId);
    return;
  }
  // Without a pluginId we don't know which plugin to invalidate; drop
  // everything to be safe. Cheap: re-pushing one snapshot per plugin on
  // the next call is bounded by the number of installed plugins.
  cache.clear();
}

/**
 * Drop the cached activation for a plugin. Used by global-scope plugin
 * config writes (e.g. captured user id changes, instance change on the
 * global GHE config).
 */
export function forgetPluginActivation(pluginId: string): void {
  cache.delete(pluginId);
}

/** Drop all cached activations. Used by tests; also fine for plugin reloads. */
export function clearActivationCache(): void {
  cache.clear();
}
