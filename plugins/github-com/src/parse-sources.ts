import type { GithubSource } from "./sources.js";

/**
 * Shape-check a host-supplied config payload during validateConfig. The host
 * now passes `sources` per-call to source-bound methods, so the plugin only
 * needs to parse the sources array when validateConfig probes each source
 * for existence. Returns the parsed sources plus field-scoped shape errors.
 */
export function parseSourcesConfig(raw: Record<string, unknown>): {
  config: { sources: GithubSource[] } | null;
  errors: Array<{ field?: string; message: string }>;
} {
  const errors: Array<{ field?: string; message: string }> = [];
  const rawSources = (raw as { sources?: unknown }).sources;

  // Token-only validation (e.g. the global "Test connection" flow before any
  // sources have been picked) sends a config without a `sources` key. Accept
  // that as an empty selection so the credential probe can still run.
  if (rawSources === undefined) {
    return { config: { sources: [] }, errors };
  }
  if (!Array.isArray(rawSources)) {
    errors.push({ field: "sources", message: "sources must be an array" });
    return { config: null, errors };
  }

  const sources: GithubSource[] = [];
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
