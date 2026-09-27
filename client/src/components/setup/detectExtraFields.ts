// Top-level keys Guided mode can represent; add new keys here when the schema grows.
export const KNOWN_TOP_LEVEL_KEYS = new Set([
  "project",
  "layout",
  "components",
  "ports",
  "tools",
  "benches",
  "jigs",
  "users",
]);

// Top-level keys of removed features. The server's config parser strips them
// quietly, so Guided mode must not warn that it cannot preserve them.
const REMOVED_TOP_LEVEL_KEYS = new Set(["inspection"]);

// Returns unknown top-level keys; input must be the raw YAML.parse result.
export function detectExtraFields(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed as Record<string, unknown>).filter(
    (k) => !KNOWN_TOP_LEVEL_KEYS.has(k) && !REMOVED_TOP_LEVEL_KEYS.has(k),
  );
}
