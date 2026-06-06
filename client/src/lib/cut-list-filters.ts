import type { NormalizedIssue } from "@roubo/shared";

/**
 * Generic, plugin-facet-driven filter state for the cut list. `facetValues`
 * holds one selection set per facet id returned by the active plugin's
 * `filterFacets` RPC (host-API 1.1.0+). Selections are uniformly multi-valued
 * sets even for single-select facets, so the same matching logic works for
 * `enum`, `enum-async`, and `multi-enum` shapes.
 *
 * Status exclusion is no longer a client concern: it is applied in the query
 * (FR-009, e.g. the Jira plugin's `statusCategory not in (...)` JQL), so
 * excluded issues never reach a page and there is nothing to hide or reveal here.
 */
export interface FilterState {
  search: string;
  facetValues: Record<string, Set<string>>;
}

export function createEmptyFilters(): FilterState {
  return { search: "", facetValues: {} };
}

/** Read the current selection set for one facet without mutating state. */
export function getFacetSelection(filters: FilterState, facetId: string): Set<string> {
  return filters.facetValues[facetId] ?? new Set<string>();
}

/**
 * Return a new FilterState with `selection` set for `facetId`. Empty sets are
 * removed from the map so `isFiltersEmpty` / `activeFilterCount` see them as
 * unset.
 */
export function setFacetSelection(
  filters: FilterState,
  facetId: string,
  selection: Set<string>,
): FilterState {
  const next: Record<string, Set<string>> = {};
  for (const [k, v] of Object.entries(filters.facetValues)) {
    if (k !== facetId) next[k] = v;
  }
  if (selection.size > 0) next[facetId] = selection;
  return { ...filters, facetValues: next };
}

export function isFiltersEmpty(filters: FilterState): boolean {
  if (filters.search) return false;
  for (const set of Object.values(filters.facetValues)) {
    if (set.size > 0) return false;
  }
  return true;
}

/**
 * Count of structured selections currently active. Powers the trigger-button
 * badge: one increment per non-empty facet selection.
 *
 * Search is intentionally excluded; it has its own input affordance.
 */
export function activeFilterCount(filters: FilterState): number {
  let count = 0;
  for (const set of Object.values(filters.facetValues)) {
    if (set.size > 0) count++;
  }
  return count;
}

/**
 * Filter a list of normalized issues by the current FilterState. Pure: no
 * network, no caching, no side effects. Designed to run on every keystroke
 * for ~500 issues well under the 50 ms p95 budget (TC-139).
 */
export function applyFilters(issues: NormalizedIssue[], filters: FilterState): NormalizedIssue[] {
  const facetEntries = Object.entries(filters.facetValues).filter(([, set]) => set.size > 0);
  const search = filters.search.trim().toLowerCase();

  if (facetEntries.length === 0 && !search) return issues;

  return issues.filter((issue) => {
    for (const [facetId, selection] of facetEntries) {
      const values = issueFacetValues(issue, facetId);
      if (values.length === 0) return false;
      let matched = false;
      for (const v of values) {
        if (selection.has(v)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }

    if (search) {
      const titleMatch = issue.title.toLowerCase().includes(search);
      const idMatch = issue.externalId.toLowerCase().includes(search);
      if (!titleMatch && !idMatch) return false;
    }
    return true;
  });
}

/**
 * Resolve an issue's value(s) for one facet id. Prefers `facetValues[facetId]`
 * (plugins built against host-API 1.1.0+ populate this), falling back to the
 * canonical NormalizedIssue field for the four common facets so plugins that
 * still rely on the COMMON_FACET_FALLBACK set keep working unchanged.
 */
export function issueFacetValues(issue: NormalizedIssue, facetId: string): string[] {
  const raw = issue.facetValues?.[facetId];
  if (raw !== undefined) {
    return Array.isArray(raw) ? raw : [raw];
  }
  switch (facetId) {
    case "type":
      return issue.issueType ? [issue.issueType] : [];
    case "label":
    case "labels":
      return issue.labels;
    case "assignee":
      return issue.assignees.map((a) => a.externalId);
    case "status":
      return issue.currentState ? [issue.currentState] : [];
    default:
      return [];
  }
}
