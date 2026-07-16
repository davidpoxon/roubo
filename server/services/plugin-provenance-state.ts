import fs from "node:fs";
import path from "node:path";
import {
  PLUGIN_PROVENANCE_STATE_SCHEMA_VERSION,
  PluginProvenanceStateSchema,
  type PluginProvenanceRecord,
  type PluginProvenanceState,
} from "@roubo/shared";
import { atomicWrite, ensureDirs, getRouboDir } from "./state.js";

// Issue #558 / CPHMTP-FR-005, CPHMTP-FR-006: persistent per-plugin record of which
// marketplace source a plugin was installed from. See:
//   .specifications/component-plugins-hosted-marketplace-third-party/prd.md
//   .specifications/component-plugins-hosted-marketplace-third-party/architecture.md
//     ('Data model': PluginRecord provenance)
//
// Pure persistence module mirroring plugin-consent-state.ts. Reads/writes
// ~/.roubo/plugins-provenance.json via the same atomicWrite discipline used by
// state.json, plugins-consent.json, and marketplace-sources.json.
//
// Why a ledger rather than a field on the record: plugin-manager rebuilds every
// PluginRecord from disk (buildEntryFromDir re-parses ~/.roubo/plugins/<id>), so a
// record-only field would be dropped on the next load. The install commit writes
// here; record rebuilds read back. An absent entry means first-party / verified, so
// installs predating this file need no migration.

const FILE_NAME = "plugins-provenance.json";

function filePath(): string {
  return path.join(getRouboDir(), FILE_NAME);
}

// Last successfully loaded or saved state, kept in-process so a corrupted file
// mid-session can fall back to "what we knew last" instead of resetting. Reset by
// `__test.reset()`.
let lastKnown: PluginProvenanceState | null = null;

/**
 * Loads `~/.roubo/plugins-provenance.json`. Returns `null` when the file is
 * absent: callers interpret this as "nothing has been installed from a named
 * marketplace source yet".
 *
 * On JSON.parse failure or schema rejection, the bad file is renamed to
 * `plugins-provenance.json.broken-<ISO-timestamp>` and the function returns the
 * last successful in-memory snapshot if one exists, otherwise `null`.
 */
export function loadProvenanceState(): PluginProvenanceState | null {
  ensureDirs();
  const p = filePath();
  if (!fs.existsSync(p)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (err) {
    console.warn(`plugin-provenance-state: failed to read ${p}:`, (err as Error).message);
    return lastKnown;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return backupAndRecover(p, `invalid JSON: ${(err as Error).message}`);
  }
  const result = PluginProvenanceStateSchema.safeParse(parsed);
  if (!result.success) {
    return backupAndRecover(p, `schema rejected: ${result.error.message}`);
  }
  lastKnown = result.data;
  return result.data;
}

/**
 * Writes the state via atomicWrite (tmp + rename) and updates the in-process
 * `lastKnown` cache. Validates before persisting so a buggy caller cannot write a
 * file the next load would reject and back up.
 */
export function saveProvenanceState(state: PluginProvenanceState): void {
  ensureDirs();
  const validated = PluginProvenanceStateSchema.parse(state);
  atomicWrite(filePath(), JSON.stringify(validated, null, 2));
  lastKnown = validated;
}

/**
 * The persisted provenance for `pluginId`, or `null` when the plugin has none
 * (a bundled plugin, or an install that predates this ledger). A null reads as
 * first-party / verified.
 */
export function getProvenance(pluginId: string): PluginProvenanceRecord | null {
  const current = loadProvenanceState();
  if (!current) return null;
  if (!Object.prototype.hasOwnProperty.call(current.plugins, pluginId)) return null;
  return current.plugins[pluginId];
}

/**
 * Records the source a plugin was installed from. Called at install/update commit
 * with the source the consumer explicitly chose (CPHMTP-FR-005 AC4). Seeds an
 * empty document on an absent file, then persists the record under `pluginId`.
 *
 * An update re-stamps the row rather than merging: the update was resolved against
 * a specific source too, so the newest choice is the truth.
 */
export function recordProvenance(input: {
  pluginId: string;
  sourceId: string;
  sourceUrl: string;
  unverified: boolean;
}): PluginProvenanceRecord {
  const current = loadProvenanceState() ?? {
    schemaVersion: PLUGIN_PROVENANCE_STATE_SCHEMA_VERSION,
    plugins: {},
  };
  const record: PluginProvenanceRecord = {
    pluginId: input.pluginId,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    unverified: input.unverified,
    installedAt: new Date().toISOString(),
  };
  saveProvenanceState({
    ...current,
    plugins: { ...current.plugins, [input.pluginId]: record },
  });
  return record;
}

/**
 * Removes a plugin id from the ledger, so the file stays in sync with what is
 * actually installed (called on uninstall).
 */
export function removeProvenance(pluginId: string): void {
  const current = loadProvenanceState();
  if (!current || !Object.prototype.hasOwnProperty.call(current.plugins, pluginId)) return;
  const nextPlugins: Record<string, PluginProvenanceRecord> = {};
  for (const [id, value] of Object.entries(current.plugins)) {
    if (id !== pluginId) nextPlugins[id] = value;
  }
  saveProvenanceState({ ...current, plugins: nextPlugins });
}

function backupAndRecover(p: string, reason: string): PluginProvenanceState | null {
  const backup = `${p}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(p, backup);
    console.warn(
      `plugin-provenance-state: ${path.basename(p)} corrupt (${reason}); backed up to ${path.basename(backup)}`,
    );
  } catch (err) {
    console.warn(
      `plugin-provenance-state: ${path.basename(p)} corrupt (${reason}); backup to ${path.basename(backup)} failed: ${(err as Error).message}`,
    );
  }
  return lastKnown;
}

// Test-only reset so vitest module isolation can clear the in-process cache
// without leaking state between test files.
export const __test = {
  reset(): void {
    lastKnown = null;
  },
};
