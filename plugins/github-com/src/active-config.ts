import type { ConfiguredSource, PluginConfig } from "./types.js";

// The plugin caches the most recently validated config so contract methods
// without explicit source parameters (listIssues, listIssueTypes, listLabels)
// know which configured source to read from. The host is expected to call
// validateConfig once at startup or when the user changes the integration
// block in roubo.yaml; until then, source-bound methods throw a clear error.

let activeConfig: PluginConfig | null = null;

export function setActiveConfig(config: PluginConfig | null): void {
  activeConfig = config;
}

export function getActiveConfig(): PluginConfig {
  if (!activeConfig) {
    throw new Error(
      "[github-com] No active configuration. The host must call validateConfig before invoking source-scoped methods.",
    );
  }
  return activeConfig;
}

export function tryGetActiveConfig(): PluginConfig | null {
  return activeConfig;
}

/**
 * Returns the first configured source. Methods that need a single source
 * (listIssues, listIssueTypes, listLabels) consume this; multi-source support
 * is deferred to a later work unit when the host wiring lands.
 */
export function getPrimarySource(): ConfiguredSource {
  const config = getActiveConfig();
  if (!config.sources || config.sources.length === 0) {
    throw new Error("[github-com] Active configuration has no sources.");
  }
  return config.sources[0];
}

/**
 * Parses the host-provided config record into the typed PluginConfig shape
 * used internally. Returns the typed config plus a list of field-scoped
 * errors. The caller decides whether to surface the errors via validateConfig
 * or throw.
 */
export function parseConfig(raw: Record<string, unknown>): {
  config: PluginConfig | null;
  errors: Array<{ field?: string; message: string }>;
} {
  const errors: Array<{ field?: string; message: string }> = [];
  const rawSources = (raw as { sources?: unknown }).sources;
  // Token-only validation (e.g. the global "Test connection" flow before any
  // sources have been picked) sends a config without a `sources` key. We
  // accept that as an empty selection so the credential probe can still run;
  // it is the caller's responsibility not to overwrite a non-empty active
  // config with an empty one.
  if (rawSources === undefined) {
    return { config: { sources: [] }, errors };
  }
  if (!Array.isArray(rawSources)) {
    errors.push({ field: "sources", message: "sources must be an array" });
    return { config: null, errors };
  }

  const sources: ConfiguredSource[] = [];
  rawSources.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      errors.push({ field: `sources[${idx}]`, message: "must be an object" });
      return;
    }
    const e = entry as { kind?: unknown; externalId?: unknown };
    if (e.kind !== "repo" && e.kind !== "project") {
      errors.push({ field: `sources[${idx}].kind`, message: 'must be "repo" or "project"' });
      return;
    }
    if (typeof e.externalId !== "string" || e.externalId.length === 0) {
      errors.push({
        field: `sources[${idx}].externalId`,
        message: "must be a non-empty string",
      });
      return;
    }
    sources.push({ kind: e.kind, externalId: e.externalId });
  });

  if (errors.length > 0) return { config: null, errors };
  return { config: { sources }, errors: [] };
}
