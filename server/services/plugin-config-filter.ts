import type { PluginManifest } from "@roubo/shared";

export type AdvancedFilterSource = "activation" | "persist-global" | "persist-project";

// Top-level keys on `IntegrationConfig` (see `shared/config-schema.ts`). A
// plugin's manifest `configSchema.properties` may legitimately list any of
// these (e.g. github-com declares `sources`), but they belong at the top
// level of the integration config and not under `advanced`. So even if a key
// is in the manifest schema, it is treated as stale if it shadows a top-
// level field. This is what catches the documented `advanced.sources: ""`
// leftover from issue #125.
const TOP_LEVEL_INTEGRATION_KEYS: ReadonlySet<string> = new Set([
  "plugin",
  "instance",
  "sources",
  "advanced",
  "pluginSource",
  "pageSize",
  "capturedUserId",
  "excludedStatuses",
]);

// Read the legal top-level keys from a plugin manifest's JSON-Schema
// `configSchema.properties` block, minus any that are top-level
// `IntegrationConfig` fields (those don't belong under `advanced`). Returns
// `null` when the schema is missing or has no `properties` map (the plugin
// declares no plugin-wide surface, so every `advanced.*` key is stale).
function legalAdvancedKeysFromManifest(manifest: PluginManifest | null): Set<string> | null {
  const schema = manifest?.configSchema;
  if (!schema || typeof schema !== "object") return null;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return null;
  const legal = new Set<string>();
  for (const key of Object.keys(properties)) {
    if (!TOP_LEVEL_INTEGRATION_KEYS.has(key)) legal.add(key);
  }
  return legal;
}

/**
 * Drop entries from a plugin-wide `advanced` block that don't appear in the
 * plugin manifest's `configSchema.properties`. Returns the cleaned record, or
 * `undefined` when the cleaned record would be empty (so callers can drop the
 * `advanced` key entirely).
 *
 * The host previously copied every `advanced.*` entry into the
 * `setActiveConfig` payload and back onto disk on every save. Older
 * `~/.roubo/integrations/_global/{pluginId}.yaml` files written before commit
 * `23ea55b` ("Pass sources per-call to eliminate per-project plugin state")
 * can still contain leftovers like `advanced.sources: ""` that no current
 * plugin schema recognises. See issue #125.
 *
 * When stale keys are dropped, a single `console.warn` is emitted carrying the
 * plugin id, the calling `source` tag, and the comma-separated key list, so
 * the cleanup is observable in server logs without surfacing in the UI.
 */
export function filterAdvancedAgainstManifest(
  pluginId: string,
  advanced: Record<string, unknown> | undefined,
  manifest: PluginManifest | null,
  source: AdvancedFilterSource,
): Record<string, unknown> | undefined {
  if (!advanced || typeof advanced !== "object") return undefined;
  const entries = Object.entries(advanced);
  if (entries.length === 0) return undefined;

  const legal = legalAdvancedKeysFromManifest(manifest);
  const cleaned: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of entries) {
    if (legal && legal.has(key)) {
      cleaned[key] = value;
    } else {
      dropped.push(key);
    }
  }

  if (dropped.length > 0) {
    const droppedList = dropped.map((k) => `advanced.${k}`).join(", ");
    console.warn(
      `[plugin-config-filter] ${pluginId}: dropping stale advanced keys not in manifest (${droppedList}); source=${source}`,
    );
  }

  if (Object.keys(cleaned).length === 0) return undefined;
  return cleaned;
}
