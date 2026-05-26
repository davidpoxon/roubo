import type { SourceSelection, SourceEntry } from "@roubo/shared";

/**
 * The shape every integration plugin expects under `config.sources`: a flat
 * list of `{ kind, externalId }` entries. Plugins translate this internally
 * into per-source API calls.
 *
 * The optional per-source alert-category booleans (FR-074) are passed through
 * verbatim when present on an object-form source entry. Plugins that do not
 * implement security alerts (i.e. anything outside the GitHub family) ignore
 * them; the host treats them as plugin-defined per-source config.
 */
export interface PluginSourceEntry {
  kind: string;
  externalId: string;
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

/**
 * Map from a `SourceSelection` category id (as returned by the plugin's
 * `listSourceCandidates`, e.g. `"Repository"`, `"Project"`, `"boards"`)
 * to the `kind` string the plugin expects under each `ConfiguredSource.kind`
 * (e.g. `"repo"`, `"project"`, `"filter"`).
 *
 * Still hard-coded centrally; the longer-term direction is to let each
 * plugin advertise its own mapping in `roubo-plugin.yaml`. Until then,
 * adding a new plugin family means adding its categories here.
 *
 * Jira: the source picker returns `boards`, `epics`, and `filters`
 * categories; boards are resolved to backing filter ids before they reach
 * the host (see `plugins/jira-self-hosted/src/source-picker.ts`), so both
 * `boards` and `filters` map to plugin-internal kind `"filter"`.
 */
const CATEGORY_TO_KIND: Record<string, string> = {
  Repository: "repo",
  Project: "project",
  boards: "filter",
  epics: "epic",
  filters: "filter",
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
 * thrown; a forward-compatible config that mentions a not-yet-known
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
      if (asString.length === 0) continue;
      const translated: PluginSourceEntry = { kind, externalId: asString };
      if (typeof entry === "object" && entry !== null) {
        if (entry.includeCodeQLAlerts !== undefined) {
          translated.includeCodeQLAlerts = entry.includeCodeQLAlerts;
        }
        if (entry.includeSecretScanningAlerts !== undefined) {
          translated.includeSecretScanningAlerts = entry.includeSecretScanningAlerts;
        }
        if (entry.includeDependabotAlerts !== undefined) {
          translated.includeDependabotAlerts = entry.includeDependabotAlerts;
        }
      }
      out.push(translated);
    }
  }
  return out;
}
