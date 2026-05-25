/**
 * Helpers for working with the widened SourceSelection shape: each category's
 * array is `SourceSelectionEntry[]` where an entry is either a plain string
 * (the externalId) or an object form carrying per-source alert booleans.
 *
 * The collapse-on-default rule keeps the persisted YAML minimal: an entry that
 * has all toggles off (or undefined) is written as the primitive string form;
 * the moment any toggle turns on it expands to the object form.
 */

import type { SourceSelection, SourceSelectionEntry } from "@roubo/shared";

export type AlertFlagKey =
  | "includeCodeQLAlerts"
  | "includeSecretScanningAlerts"
  | "includeDependabotAlerts";

export const ALERT_FLAG_KEYS: AlertFlagKey[] = [
  "includeCodeQLAlerts",
  "includeSecretScanningAlerts",
  "includeDependabotAlerts",
];

export function entryId(entry: SourceSelectionEntry): string {
  return typeof entry === "string" ? entry : entry.externalId;
}

export function entryFlag(entry: SourceSelectionEntry, key: AlertFlagKey): boolean {
  if (typeof entry === "string") return false;
  return entry[key] === true;
}

function hasAnyFlag(entry: Exclude<SourceSelectionEntry, string>): boolean {
  return ALERT_FLAG_KEYS.some((k) => entry[k] === true);
}

function stripUndefined(
  entry: Exclude<SourceSelectionEntry, string>,
): Exclude<SourceSelectionEntry, string> {
  const out: Exclude<SourceSelectionEntry, string> = { externalId: entry.externalId };
  if (entry.includeCodeQLAlerts === true) out.includeCodeQLAlerts = true;
  if (entry.includeSecretScanningAlerts === true) out.includeSecretScanningAlerts = true;
  if (entry.includeDependabotAlerts === true) out.includeDependabotAlerts = true;
  return out;
}

export function setEntryFlag(
  entry: SourceSelectionEntry,
  key: AlertFlagKey,
  value: boolean,
): SourceSelectionEntry {
  const id = entryId(entry);
  if (typeof entry === "string") {
    if (!value) return entry;
    return { externalId: id, [key]: true };
  }
  const next: Exclude<SourceSelectionEntry, string> = { ...entry };
  if (value) {
    next[key] = true;
  } else {
    // Reassign as undefined and reconstruct without the key — avoids
    // the eslint @typescript-eslint/no-dynamic-delete rule which forbids
    // `delete` on computed property keys.
    next[key] = undefined;
  }
  if (!hasAnyFlag(next)) return id;
  return stripUndefined(next);
}

export function entriesFor(value: SourceSelection, category: string): SourceSelectionEntry[] {
  return value[category] ?? [];
}

export function idsFor(value: SourceSelection, category: string): string[] {
  return entriesFor(value, category).map(entryId);
}

/**
 * Apply a Set<externalId> selection change to a category. Removes entries
 * whose ids dropped out of the set, adds new entries (as plain strings) for
 * ids that just appeared. Preserves any per-entry toggles on entries that
 * remain selected.
 */
export function applyIdSelection(
  value: SourceSelection,
  category: string,
  nextIds: Set<string>,
): SourceSelection {
  const current = entriesFor(value, category);
  const kept: SourceSelectionEntry[] = current.filter((e) => nextIds.has(entryId(e)));
  const keptIds = new Set(kept.map(entryId));
  const added: SourceSelectionEntry[] = [];
  for (const id of nextIds) {
    if (!keptIds.has(id)) added.push(id);
  }
  const merged = [...kept, ...added];
  if (merged.length === 0) {
    const { [category]: _removed, ...rest } = value;
    void _removed;
    return rest;
  }
  return { ...value, [category]: merged };
}

/**
 * Set a single per-entry toggle. If `externalId` is not currently selected,
 * returns `value` unchanged.
 */
export function setFlagForEntry(
  value: SourceSelection,
  category: string,
  externalId: string,
  key: AlertFlagKey,
  flagValue: boolean,
): SourceSelection {
  const current = entriesFor(value, category);
  let touched = false;
  const next = current.map((entry) => {
    if (entryId(entry) !== externalId) return entry;
    touched = true;
    return setEntryFlag(entry, key, flagValue);
  });
  if (!touched) return value;
  return { ...value, [category]: next };
}
