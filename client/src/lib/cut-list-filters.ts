import type { NormalizedIssue } from "@roubo/shared";

export interface FilterState {
  /** Issue type from the active integration plugin (`NormalizedIssue.issueType`). */
  type: string;
  labels: Set<string>;
  search: string;
}

export function createEmptyFilters(): FilterState {
  return { type: "", labels: new Set(), search: "" };
}

export function isFiltersEmpty(filters: FilterState): boolean {
  return !filters.type && filters.labels.size === 0 && !filters.search;
}

export function activeFilterCount(filters: FilterState): number {
  let count = 0;
  if (filters.type) count++;
  if (filters.labels.size > 0) count++;
  return count;
}

export function applyFilters(issues: NormalizedIssue[], filters: FilterState): NormalizedIssue[] {
  if (isFiltersEmpty(filters)) return issues;
  return issues.filter((issue) => {
    if (filters.type) {
      if (issue.issueType !== filters.type) return false;
    }
    if (filters.labels.size > 0) {
      if (!issue.labels.some((l) => filters.labels.has(l))) return false;
    }
    if (filters.search.trim()) {
      const q = filters.search.trim().toLowerCase();
      const titleMatch = issue.title.toLowerCase().includes(q);
      const idMatch = issue.externalId.toLowerCase().includes(q);
      if (!titleMatch && !idMatch) return false;
    }
    return true;
  });
}
