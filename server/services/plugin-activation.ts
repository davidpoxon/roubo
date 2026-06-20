import type { ConfiguredSource } from "@roubo/plugin-sdk";
import * as projectRegistry from "./project-registry.js";
import {
  getEffectiveWithGlobal,
  loadOverride,
  resolveRootExclusion,
  IntegrationOverrideError,
} from "./integration-overrides.js";
import * as pluginManager from "./plugin-manager.js";
import { filterAdvancedAgainstManifest } from "./plugin-config-filter.js";
import { translateSources } from "./plugin-source-translation.js";
import { deriveInstanceHost, setInstanceHost } from "./plugin-instance-registry.js";
import { getPluginSortFields } from "./plugin-sort-fields.js";

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

  // Drop any `advanced.*` keys the active plugin's manifest doesn't declare,
  // so leftovers from earlier schema versions (e.g. issue #125's
  // `advanced.sources: ""` in `~/.roubo/integrations/_global/github-com.yaml`)
  // never reach the `setActiveConfig` payload.
  const pluginId = effective.plugin;
  const manifest = pluginId
    ? (pluginManager.listInstalled().find((r) => r.id === pluginId)?.manifest ?? null)
    : null;
  const cleanedAdvanced = pluginId
    ? filterAdvancedAgainstManifest(pluginId, effective.advanced, manifest, "activation")
    : undefined;
  if (cleanedAdvanced) {
    for (const [k, v] of Object.entries(cleanedAdvanced)) {
      if (v !== undefined && config[k] === undefined) {
        config[k] = v;
      }
    }
  }

  return config;
}

/**
 * Resolve the effective integration `instance` endpoint for a project (the
 * GHE / Jira instance URL), or `null` for a fixed-host plugin like github.com
 * that has no configured instance. Used by the disk snapshot cache to derive
 * the tenant-safety `instanceHash` key field (Spike-553 field 3); the endpoint
 * is hashed by the cache, never stored raw, and never carries a credential.
 */
export function resolveInstanceEndpoint(projectId: string): string | null {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return null;

  let override = null;
  try {
    override = loadOverride(projectId);
  } catch (err) {
    if (!(err instanceof IntegrationOverrideError)) throw err;
  }

  const effective = getEffectiveWithGlobal(project.config.integration, override);
  return typeof effective.instance === "string" && effective.instance.length > 0
    ? effective.instance
    : null;
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
 * Resolve the root-level status exclusion for a project's cut list (FR-009 /
 * FR-010): the merged effective `excludedStatusCategories` / `excludedStatuses`
 * with the active plugin's manifest `defaultIntegrationConfig` as the final
 * fallback. Forwarded into `listIssues` so exclusion happens in the query. A
 * project with no config (or a plugin that ships no defaults) yields empty
 * lists, which the JQL builder treats as "exclude nothing".
 */
export function resolveExclusion(projectId: string): {
  excludedStatusCategories: string[];
  excludedStatuses: string[];
} {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return { excludedStatusCategories: [], excludedStatuses: [] };

  let override = null;
  try {
    override = loadOverride(projectId);
  } catch (err) {
    if (!(err instanceof IntegrationOverrideError)) throw err;
  }

  const effective = getEffectiveWithGlobal(project.config.integration, override);
  const manifestDefaults = effective.plugin
    ? (pluginManager.listInstalled().find((r) => r.id === effective.plugin)?.manifest
        ?.defaultIntegrationConfig ?? undefined)
    : undefined;
  return resolveRootExclusion(effective, manifestDefaults);
}

/**
 * Resolve the per-project cut-list sort selection (CLI-FR-013/CLI-FR-017): the
 * merged effective `sortBy`/`sortDir` (roubo.yaml integration block, the global
 * plugin override, and the per-user override, already shallow-replaced by
 * `getEffectiveWithGlobal`). Forwarded into `listIssues` so the plugin orders
 * source-side (CLI-FR-010). A project with no config, or no sort persisted at
 * any layer, yields `{ sortBy: undefined, sortDir: undefined }`, which the
 * plugin treats as its natural order (key-ascending fallback). `sortDir`
 * defaults to `asc` only when a `sortBy` is set without an explicit direction.
 */
export function resolveSort(projectId: string): {
  sortBy: string | undefined;
  sortDir: "asc" | "desc" | undefined;
} {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return { sortBy: undefined, sortDir: undefined };

  let override = null;
  try {
    override = loadOverride(projectId);
  } catch (err) {
    if (!(err instanceof IntegrationOverrideError)) throw err;
  }

  const effective = getEffectiveWithGlobal(project.config.integration, override);
  const sortBy = effective.sortBy;
  if (typeof sortBy !== "string" || sortBy.length === 0) {
    return { sortBy: undefined, sortDir: undefined };
  }
  const sortDir = effective.sortDir === "desc" ? "desc" : "asc";
  return { sortBy, sortDir };
}

/**
 * Resolve the per-project cut-list sort selection (CLI-FR-017) and validate it
 * against the active plugin's declared sort fields (CLI-FR-009). Starts from the
 * merged persisted value (`resolveSort`), then reconciles it with what the
 * plugin actually supports:
 *
 * - The persisted `sortBy` is a declared field id: keep it (with its persisted
 *   `sortDir`, defaulting to `asc`).
 * - The persisted `sortBy` is set but NOT among the plugin's declared field ids
 *   (an unsupported value, e.g. a field carried over from a different plugin, or
 *   one the active plugin dropped): fall back to the plugin's FIRST declared
 *   field id and its `defaultDir`, with no error (CLI-TC-070). This is also what
 *   delivers "switching the active plugin resets to that plugin's defaults"
 *   (AC3): a value the new plugin does not declare is replaced by its first
 *   field rather than passed through verbatim.
 * - The plugin declares no sort fields (host-API < 1.2.0, or `getSortFields`
 *   omitted): return natural order (`{ undefined, undefined }`), matching the
 *   "no picker" rendering (CLI-FR-011).
 * - Nothing persisted at any layer: natural order, regardless of declarations.
 *
 * Async because the declared-field set comes from the plugin's `getSortFields`
 * RPC; kept separate from the synchronous `resolveSort` so that function's
 * contract and callers are undisturbed.
 */
export async function resolveSortForActivePlugin(
  projectId: string,
  pluginId: string,
): Promise<{ sortBy: string | undefined; sortDir: "asc" | "desc" | undefined }> {
  const persisted = resolveSort(projectId);
  if (persisted.sortBy === undefined) {
    return { sortBy: undefined, sortDir: undefined };
  }

  const fields = await getPluginSortFields(pluginId);
  if (fields.length === 0) {
    // The plugin declares no sort fields: there is nothing to validate against
    // and no picker is rendered, so fall back to the plugin's natural order.
    return { sortBy: undefined, sortDir: undefined };
  }

  const declared = fields.find((f) => f.id === persisted.sortBy);
  if (declared) {
    return { sortBy: persisted.sortBy, sortDir: persisted.sortDir };
  }

  // Persisted value is unsupported by the active plugin: substitute its first
  // declared field and that field's default direction (CLI-TC-070 / AC3).
  const first = fields[0];
  return { sortBy: first.id, sortDir: first.defaultDir };
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
  // Record the host-side instance constraint before anything else, on every
  // call (cheap), so `host.fetch` enforcement always reflects the current
  // instance even when the activation cache short-circuits the RPC below. A
  // plugin with no instance (e.g. github.com) records null, leaving its
  // manifest allowlist to govern alone. See issue #338.
  setInstanceHost(pluginId, deriveInstanceHost(config?.instance));
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
