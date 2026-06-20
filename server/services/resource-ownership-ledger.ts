import type { ResourceOwnershipEntry } from "@roubo/shared";
import { loadState, saveState } from "./state.js";

/**
 * ResourceOwnershipLedger (FR-015, issue #607).
 *
 * Records, per plugin and per bench, the processes and compose projects the
 * host started on the plugin's behalf. Because the host owns every handle, the
 * ledger is the only way the startup orphan sweep (issue #613) can reap
 * resources that escaped a plugin crash or a host restart, satisfying the
 * zero-orphaned-resources invariant (NFR-003).
 *
 * Persistence rides on the existing `loadState` / `saveState` pair, so the
 * ledger lives alongside benches in `~/.roubo/state.json`. Every mutating call
 * loads the whole state, applies its change, and saves, so the rest of
 * state.json (benches, notices, migration record) is preserved untouched. The
 * `resourceOwnership` field is optional and additive: a state.json written
 * before it existed loads unchanged with no migration.
 *
 * The ledger is stored as a flat array keyed on (pluginId, benchId) rather than
 * a nested `Record<pluginId, ...>` so a plugin-supplied `pluginId` is never used
 * as an object key, keeping the persisted shape off the CodeQL prototype-
 * pollution surface.
 *
 * Out of scope here: the cleanup sweep that consumes the ledger (issue #613)
 * and the LifecycleEngine wiring that calls these methods (issue #606). This
 * module is the callable data-store the engine and the sweep build on.
 */

function sameKey(entry: ResourceOwnershipEntry, pluginId: string, benchId: number): boolean {
  return entry.pluginId === pluginId && entry.benchId === benchId;
}

/**
 * Appends `value` to `list` only if it is not already present, so repeated
 * records of the same process id or compose project are idempotent.
 */
function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

/**
 * Finds the existing entry for (pluginId, benchId) in `entries`, or creates,
 * appends, and returns a fresh empty one. Mutates `entries` in place.
 */
function getOrCreateEntry(
  entries: ResourceOwnershipEntry[],
  pluginId: string,
  benchId: number,
): ResourceOwnershipEntry {
  let entry = entries.find((e) => sameKey(e, pluginId, benchId));
  if (!entry) {
    entry = { pluginId, benchId, processIds: [], composeProjects: [] };
    entries.push(entry);
  }
  return entry;
}

/**
 * Records a host-spawned process id under (pluginId, benchId). Idempotent: a
 * process id already recorded for the entry is not duplicated.
 */
export function recordProcess(pluginId: string, benchId: number, processId: string): void {
  const data = loadState();
  const entries = data.resourceOwnership ?? [];
  const entry = getOrCreateEntry(entries, pluginId, benchId);
  addUnique(entry.processIds, processId);
  data.resourceOwnership = entries;
  saveState(data);
}

/**
 * Records a compose project name under (pluginId, benchId). Idempotent: a
 * compose project already recorded for the entry is not duplicated.
 */
export function recordComposeProject(
  pluginId: string,
  benchId: number,
  composeProject: string,
): void {
  const data = loadState();
  const entries = data.resourceOwnership ?? [];
  const entry = getOrCreateEntry(entries, pluginId, benchId);
  addUnique(entry.composeProjects, composeProject);
  data.resourceOwnership = entries;
  saveState(data);
}

/**
 * Removes the ledger entry for (pluginId, benchId) entirely. Called when a
 * component is stopped or a bench is torn down. A no-op (still persisted) when
 * no matching entry exists, so callers need not check first.
 */
export function clearEntry(pluginId: string, benchId: number): void {
  const data = loadState();
  const entries = data.resourceOwnership ?? [];
  data.resourceOwnership = entries.filter((e) => !sameKey(e, pluginId, benchId));
  saveState(data);
}

/**
 * Returns the ledger entry for (pluginId, benchId), or undefined when none
 * exists. The returned object is the live in-memory copy from this load; treat
 * it as read-only and re-load before mutating.
 */
export function getEntry(pluginId: string, benchId: number): ResourceOwnershipEntry | undefined {
  const data = loadState();
  return (data.resourceOwnership ?? []).find((e) => sameKey(e, pluginId, benchId));
}

/**
 * Returns every ledger entry. The primary input to the F1.12 startup sweep,
 * which replays the ledger to reap escaped resources after a host restart.
 */
export function getAllEntries(): ResourceOwnershipEntry[] {
  const data = loadState();
  return data.resourceOwnership ?? [];
}
