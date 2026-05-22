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
      "[ghe] No active configuration. The host must call validateConfig before invoking source-scoped methods.",
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
    throw new Error("[ghe] Active configuration has no sources.");
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

  const rawInstance = (raw as { instance?: unknown }).instance;
  let instance = "";
  if (typeof rawInstance !== "string" || rawInstance.length === 0) {
    errors.push({ field: "instance", message: "instance must be a non-empty string" });
  } else {
    try {
      const parsed = new URL(rawInstance);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push({ field: "instance", message: "instance must be an http(s) URL" });
      } else {
        instance = rawInstance.replace(/\/$/, "");
      }
    } catch {
      errors.push({ field: "instance", message: "instance is not a valid URL" });
    }
  }

  const rawAllowSelfSignedTls = (raw as { allowSelfSignedTls?: unknown }).allowSelfSignedTls;
  let allowSelfSignedTls = false;
  if (rawAllowSelfSignedTls !== undefined) {
    if (typeof rawAllowSelfSignedTls !== "boolean") {
      errors.push({ field: "allowSelfSignedTls", message: "must be a boolean" });
    } else {
      allowSelfSignedTls = rawAllowSelfSignedTls;
    }
  }

  const rawSources = (raw as { sources?: unknown }).sources;
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
  return { config: { instance, allowSelfSignedTls, sources }, errors: [] };
}
