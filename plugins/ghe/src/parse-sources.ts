import type { GheSource } from "./sources.js";

/**
 * Shape-check a host-supplied config payload's `sources` array during
 * validateConfig. Source selection is supplied per-call to source-bound RPCs,
 * but validateConfig still needs to inspect them so it can probe each source
 * for existence at config-save time.
 */
export function parseSourcesConfig(raw: Record<string, unknown>): {
  config: { sources: GheSource[] } | null;
  errors: Array<{ field?: string; message: string }>;
} {
  const errors: Array<{ field?: string; message: string }> = [];
  const rawSources = (raw as { sources?: unknown }).sources;

  if (rawSources === undefined) {
    return { config: { sources: [] }, errors };
  }
  if (!Array.isArray(rawSources)) {
    errors.push({ field: "sources", message: "sources must be an array" });
    return { config: null, errors };
  }

  const sources: GheSource[] = [];
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
