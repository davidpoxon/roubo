import type { SourceSelectionEntry } from "@roubo/shared";

/**
 * The externalId of a persisted source entry, whether it is stored in its
 * primitive (string) or object form. Shared by the source picker arms.
 */
export function entryExternalId(entry: SourceSelectionEntry): string {
  return typeof entry === "object" ? entry.externalId : String(entry);
}
