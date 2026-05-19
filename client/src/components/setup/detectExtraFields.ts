// Top-level keys Guided mode can represent; add new keys here when the schema grows.
export const KNOWN_TOP_LEVEL_KEYS = new Set([
  "project",
  "layout",
  "components",
  "ports",
  "tools",
  "inspection",
  "benches",
  "blueprints",
  "users",
]);

// Returns unknown top-level keys; input must be the raw YAML.parse result.
export function detectExtraFields(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed as Record<string, unknown>).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
}
