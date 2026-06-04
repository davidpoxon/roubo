import fs from "node:fs";
import path from "node:path";
import {
  PLUGIN_ENABLE_STATE_SCHEMA_VERSION,
  PluginEnableStateSchema,
  type PluginEnableState,
  type PluginEnableStateValue,
} from "@roubo/shared";
import { atomicWrite, ensureDirs, getRouboDir } from "./state.js";

// WU-046 / issue #137: persistent per-plugin enable state. See:
//   .specifications/integration-plugins/prd.md (FR-059, FR-060, NFR-019)
//   .specifications/integration-plugins/architecture.md (lines 1027, 1064-1097, 1218)
//
// Pure persistence module. Reads/writes ~/.roubo/plugins-state.json via the
// same atomicWrite discipline used by state.json, projects.json, and the
// permissions/<id>.json files. Never serialised by routes or telemetry:
// living outside state.json keeps it structurally absent from any future
// state-snapshot endpoint (NFR-019).

const FILE_NAME = "plugins-state.json";

function filePath(): string {
  return path.join(getRouboDir(), FILE_NAME);
}

// Last successfully loaded or saved state, kept in-process so that a corrupted
// file mid-session can fall back to "what we knew last" instead of resetting
// to legacy behaviour. Reset by `__test.reset()`.
let lastKnown: PluginEnableState | null = null;

/**
 * Loads `~/.roubo/plugins-state.json`. Returns `null` when the file is
 * absent: callers interpret this as "legacy install, no opt-in seed has run
 * yet" and default missing plugin ids to `"enabled"` (see
 * architecture.md:1097).
 *
 * On `JSON.parse` failure or schema rejection, the bad file is renamed to
 * `plugins-state.json.broken-<ISO-timestamp>` and the function returns the
 * last successful in-memory snapshot if one exists, otherwise `null`.
 */
export function loadEnableState(): PluginEnableState | null {
  ensureDirs();
  const p = filePath();
  if (!fs.existsSync(p)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (err) {
    console.warn(`plugin-enable-state: failed to read ${p}:`, (err as Error).message);
    return lastKnown;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return backupAndRecover(p, `invalid JSON: ${(err as Error).message}`);
  }
  const result = PluginEnableStateSchema.safeParse(parsed);
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
export function saveEnableState(state: PluginEnableState): void {
  ensureDirs();
  // Validate before persisting so a buggy caller can't write a file that the
  // next load will reject and back up.
  const validated = PluginEnableStateSchema.parse(state);
  atomicWrite(filePath(), JSON.stringify(validated, null, 2));
  lastKnown = validated;
}

/**
 * Read-modify-write helper used by `plugin-manager.enable()` /
 * `plugin-manager.disable()`. If the file is missing (legacy install), seeds
 * an `installInitialized: false` document so subsequent loads have a baseline
 * to merge against. Always returns the freshly persisted state.
 */
export function setPluginEnabled(pluginId: string, enabled: boolean): PluginEnableState {
  const current = loadEnableState() ?? {
    schemaVersion: PLUGIN_ENABLE_STATE_SCHEMA_VERSION,
    installInitialized: false,
    plugins: {},
  };
  const next: PluginEnableState = {
    ...current,
    plugins: {
      ...current.plugins,
      [pluginId]: enabled ? "enabled" : "disabled",
    },
  };
  saveEnableState(next);
  return next;
}

/**
 * Removes a plugin id from the persisted map. Used by `plugin-manager.uninstall()`
 * so the file stays in sync with what's actually discoverable.
 */
export function removePlugin(pluginId: string): void {
  const current = loadEnableState();
  if (!current || !(pluginId in current.plugins)) return;
  const nextPlugins: Record<string, PluginEnableStateValue> = {};
  for (const [id, value] of Object.entries(current.plugins)) {
    if (id !== pluginId) nextPlugins[id] = value;
  }
  saveEnableState({ ...current, plugins: nextPlugins });
}

function backupAndRecover(p: string, reason: string): PluginEnableState | null {
  const backup = `${p}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(p, backup);
    console.warn(
      `plugin-enable-state: ${path.basename(p)} corrupt (${reason}); backed up to ${path.basename(backup)}`,
    );
  } catch (err) {
    console.warn(
      `plugin-enable-state: ${path.basename(p)} corrupt (${reason}); backup to ${path.basename(backup)} failed: ${(err as Error).message}`,
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
  getLastKnown(): PluginEnableState | null {
    return lastKnown;
  },
};
