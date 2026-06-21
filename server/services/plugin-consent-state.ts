import fs from "node:fs";
import path from "node:path";
import {
  PLUGIN_CONSENT_STATE_SCHEMA_VERSION,
  PluginConsentStateSchema,
  type ConsentRecord,
  type PluginConsentState,
} from "@roubo/shared";
import { atomicWrite, ensureDirs, getRouboDir } from "./state.js";

// Issue #615 / CP-FR-011, CP-FR-012, CP-NFR-001: persistent per-plugin consent
// records. See:
//   .specifications/component-plugins/prd.md (CP-FR-011, CP-FR-012, CP-NFR-001)
//   .specifications/component-plugins/architecture.md ('Data model', endpoints)
//
// Pure persistence module mirroring plugin-enable-state.ts. Reads/writes
// ~/.roubo/plugins-consent.json via the same atomicWrite discipline used by
// state.json, projects.json, and plugins-state.json. Living in its own sibling
// file (rather than widening the strict enable-state schema) keeps the consent
// ledger structurally separate from the enable ledger.

const FILE_NAME = "plugins-consent.json";

function filePath(): string {
  return path.join(getRouboDir(), FILE_NAME);
}

// Last successfully loaded or saved state, kept in-process so a corrupted file
// mid-session can fall back to "what we knew last" instead of resetting. Reset
// by `__test.reset()`.
let lastKnown: PluginConsentState | null = null;

/**
 * Loads `~/.roubo/plugins-consent.json`. Returns `null` when the file is absent:
 * callers interpret this as "no plugin has been consented yet".
 *
 * On JSON.parse failure or schema rejection, the bad file is renamed to
 * `plugins-consent.json.broken-<ISO-timestamp>` and the function returns the
 * last successful in-memory snapshot if one exists, otherwise `null`.
 */
export function loadConsentState(): PluginConsentState | null {
  ensureDirs();
  const p = filePath();
  if (!fs.existsSync(p)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (err) {
    console.warn(`plugin-consent-state: failed to read ${p}:`, (err as Error).message);
    return lastKnown;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return backupAndRecover(p, `invalid JSON: ${(err as Error).message}`);
  }
  const result = PluginConsentStateSchema.safeParse(parsed);
  if (!result.success) {
    return backupAndRecover(p, `schema rejected: ${result.error.message}`);
  }
  lastKnown = result.data;
  return result.data;
}

/**
 * Writes the state via atomicWrite (tmp + rename) and updates the in-process
 * `lastKnown` cache.
 */
export function saveConsentState(state: PluginConsentState): void {
  ensureDirs();
  // Validate before persisting so a buggy caller can't write a file the next
  // load will reject and back up.
  const validated = PluginConsentStateSchema.parse(state);
  atomicWrite(filePath(), JSON.stringify(validated, null, 2));
  lastKnown = validated;
}

/**
 * Returns the persisted ConsentRecord for `pluginId`, or `null` if the plugin
 * has not been consented.
 */
export function getConsent(pluginId: string): ConsentRecord | null {
  const current = loadConsentState();
  if (!current) return null;
  if (!Object.prototype.hasOwnProperty.call(current.plugins, pluginId)) return null;
  return current.plugins[pluginId];
}

/**
 * True when a ConsentRecord exists for `pluginId`. The consent gate at the
 * component-start seam reads this: no record => the server refuses to start the
 * component (CP-FR-012, AC5).
 */
export function hasConsent(pluginId: string): boolean {
  return getConsent(pluginId) !== null;
}

/**
 * Read-modify-write helper used by the POST /consent route. Seeds an empty
 * document on a legacy/absent file, then persists the record under `pluginId`.
 * Always returns the freshly persisted record.
 */
export function upsertConsent(pluginId: string, acknowledgedCategories: string[]): ConsentRecord {
  const current = loadConsentState() ?? {
    schemaVersion: PLUGIN_CONSENT_STATE_SCHEMA_VERSION,
    plugins: {},
  };
  const record: ConsentRecord = {
    pluginId,
    acknowledgedCategories,
    consentedAt: new Date().toISOString(),
  };
  const next: PluginConsentState = {
    ...current,
    plugins: {
      ...current.plugins,
      [pluginId]: record,
    },
  };
  saveConsentState(next);
  return record;
}

/**
 * Removes a plugin id from the persisted map. Used so the file stays in sync
 * with what's actually installed (e.g. on uninstall).
 */
export function removeConsent(pluginId: string): void {
  const current = loadConsentState();
  if (!current || !Object.prototype.hasOwnProperty.call(current.plugins, pluginId)) return;
  const nextPlugins: Record<string, ConsentRecord> = {};
  for (const [id, value] of Object.entries(current.plugins)) {
    if (id !== pluginId) nextPlugins[id] = value;
  }
  saveConsentState({ ...current, plugins: nextPlugins });
}

function backupAndRecover(p: string, reason: string): PluginConsentState | null {
  const backup = `${p}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(p, backup);
    console.warn(
      `plugin-consent-state: ${path.basename(p)} corrupt (${reason}); backed up to ${path.basename(backup)}`,
    );
  } catch (err) {
    console.warn(
      `plugin-consent-state: ${path.basename(p)} corrupt (${reason}); backup to ${path.basename(backup)} failed: ${(err as Error).message}`,
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
  getLastKnown(): PluginConsentState | null {
    return lastKnown;
  },
};
