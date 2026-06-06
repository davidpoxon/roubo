/**
 * Declarative source-picker payloads returned by an integration plugin's
 * `listSourceCandidates` RPC. Roubo's host renders the UI; plugins ship no
 * React. See `.specifications/integration-plugins/architecture.md` (FR-019).
 */

export type SourceCandidateIcon = "repo" | "project" | "board" | "epic" | "filter";

export interface SourceCandidateItem {
  externalId: string;
  label: string;
  sublabel?: string;
  icon?: SourceCandidateIcon;
}

export interface SourceCandidateCategory {
  id: string;
  label: string;
  items: SourceCandidateItem[];
}

export type SourceCandidatesShape =
  | "multi-list"
  | "categorized-multi-list"
  | "searchable-categorized";

// One selectable mode within a synthetic category (e.g. "assigned to me":
// in-project vs anywhere). Distinct from a SourceCandidateItem in that it has
// no externalId and is not fetched via search; the host renders it inline.
export interface SourceCategoryOption {
  id: string;
  label: string;
}

// A category declared by the "searchable-categorized" shape. The plugin ships
// no items here; it only declares which categories exist, their icon, and
// whether each is gated behind a parent selection. Items arrive later via the
// host's source-options search RPC.
export interface SearchableSourceCategory {
  id: "project" | "board" | "filter" | "epic" | "mine";
  label: string;
  icon?: SourceCandidateIcon;
  // Gate: the category is disabled until the named parent selection exists.
  scopedBy?: "project";
  // Inline modes for synthetic categories like "mine".
  options?: SourceCategoryOption[];
}

export interface SourceCandidatesResponse {
  shape: SourceCandidatesShape;
  // Present iff shape === "multi-list".
  items?: SourceCandidateItem[];
  // Present iff shape === "categorized-multi-list".
  categories?: SourceCandidateCategory[];
  // Present iff shape === "searchable-categorized".
  searchableCategories?: SearchableSourceCategory[];
  // Reserved for future pagination; v1 plugins return undefined.
  nextCursor?: string | null;
}

/**
 * Params for the scoped, paginated source-option search (`getSourceOptions`).
 * Generalizes facet-option search with a parent `scope` (the Jira project keys a
 * board/filter/epic search is confined to) and an opaque `cursor`. `search` is
 * the optional user-typed term (debounced client-side). Scoped categories with
 * no `scope.project` return an empty page.
 */
export interface GetSourceOptionsParams {
  category: "project" | "board" | "filter" | "epic";
  scope?: { project?: string[] };
  search?: string;
  cursor?: string | null;
}

/**
 * One page of source options returned by `getSourceOptions`. `nextCursor` is an
 * opaque token the host passes back verbatim to fetch the next page; `null`
 * means exhausted (NFR-004: every item reachable, no page dropped or duplicated).
 */
export interface SourceOptionsResult {
  items: SourceCandidateItem[];
  nextCursor: string | null;
}

/**
 * One persisted source entry. The primitive `string` form is the externalId;
 * the object form carries per-source toggles (currently only the GitHub-family
 * Code Scanning / Secret Scanning / Dependabot booleans, ignored by other
 * plugins). The two forms are interchangeable on disk: a writer collapses to
 * the primitive form when no toggles are set, and expands to the object form
 * the moment any toggle turns on.
 */
export type SourceSelectionEntry =
  | string
  | {
      externalId: string;
      includeCodeQLAlerts?: boolean;
      includeSecretScanningAlerts?: boolean;
      includeDependabotAlerts?: boolean;
    };

/**
 * Persisted selection for a project. Keys are plugin-defined category ids
 * (or the literal `"items"` for the multi-list shape). Values are arrays of
 * source entries (string externalIds or objects with per-source toggles).
 * Stored verbatim in `integration.sources` of the per-user override and
 * treated as opaque-to-Roubo elsewhere.
 */
export type SourceSelection = Record<string, SourceSelectionEntry[]>;
