import type { SourceSelection, SourceEntry } from "@roubo/shared";

/**
 * The shape every integration plugin expects under `config.sources`: a flat
 * list of `{ kind, externalId }` entries. Plugins translate this internally
 * into per-source API calls.
 */
export interface PluginSourceEntry {
  kind: string;
  externalId: string;
}

/**
 * Map from a `SourceSelection` category id (as returned by the plugin's
 * `listSourceCandidates`, e.g. `"Repository"`, `"Project"`) to the `kind`
 * string the plugin expects under `config.sources[*].kind` (e.g. `"repo"`,
 * `"project"`).
 *
 * Currently hard-coded for GitHub-shaped plugins. When non-GitHub plugins
 * grow per-call activation this should move into the plugin manifest so
 * each plugin advertises its own mapping; see the follow-up issue
 * "Adopt setActiveConfig per-call activation across all integration plugins".
 */
const CATEGORY_TO_KIND: Record<string, string> = {
  Repository: "repo",
  Project: "project",
};

export interface TranslateSourcesOptions {
  /**
   * Optional callback used to surface categories we did not recognise. The
   * caller is the right place to format the warning with plugin/project
   * context; this module only knows the category name.
   */
  onUnknownCategory?: (category: string, externalIds: readonly string[]) => void;
}

/**
 * Flatten a project's `SourceSelection` (keyed by category id, values are
 * externalId arrays) into the `{ kind, externalId }[]` shape plugins expect.
 *
 * Unknown categories are dropped (with an optional callback) rather than
 * thrown — a forward-compatible config that mentions a not-yet-known
 * category should not break source-bound calls for the categories we do
 * understand. A `null`/`undefined` selection becomes `[]`.
 */
/**
 * The schema for IntegrationConfig.sources allows numeric externalIds (e.g.
 * `Project: [1, 2]`) for plugins that use numeric ids natively, and (per
 * FR-062/FR-063) object entries that carry per-source overrides like
 * `excludedStatuses`. The declared `SourceSelection` type only mentions
 * strings; accept the looser shape and stringify/unwrap as needed.
 */
type LooseSourceSelection = Record<string, ReadonlyArray<SourceEntry>>;

function entryToExternalId(entry: SourceEntry): string {
  const raw = typeof entry === "object" ? entry.externalId : entry;
  return typeof raw === "string" ? raw : String(raw);
}

export function translateSources(
  selection: SourceSelection | LooseSourceSelection | null | undefined,
  options: TranslateSourcesOptions = {},
): PluginSourceEntry[] {
  if (!selection) return [];
  const out: PluginSourceEntry[] = [];
  for (const [category, entries] of Object.entries(selection)) {
    const kind = CATEGORY_TO_KIND[category];
    if (!kind) {
      options.onUnknownCategory?.(category, entries.map(entryToExternalId));
      continue;
    }
    for (const entry of entries) {
      const asString = entryToExternalId(entry);
      if (asString.length > 0) {
        out.push({ kind, externalId: asString });
      }
    }
  }
  return out;
}
