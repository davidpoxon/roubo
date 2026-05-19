import type { GitHubProjectItem } from "@roubo/shared";

export interface FilterState {
  milestone: string;
  type: string;
  labels: Set<string>;
  search: string;
}

export function createEmptyFilters(): FilterState {
  return { milestone: "", type: "", labels: new Set(), search: "" };
}

export function isFiltersEmpty(filters: FilterState): boolean {
  return !filters.milestone && !filters.type && filters.labels.size === 0 && !filters.search;
}

export function activeFilterCount(filters: FilterState): number {
  let count = 0;
  if (filters.milestone) count++;
  if (filters.type) count++;
  if (filters.labels.size > 0) count++;
  return count;
}

export function applyFilters(
  items: GitHubProjectItem[],
  filters: FilterState,
): GitHubProjectItem[] {
  if (isFiltersEmpty(filters)) return items;
  return items.filter((item) => {
    if (filters.milestone) {
      if (item.issue.milestone !== filters.milestone) return false;
    }
    if (filters.type) {
      if (item.issue.type !== filters.type) return false;
    }
    if (filters.labels.size > 0) {
      if (!item.issue.labels.some((l) => filters.labels.has(l))) return false;
    }
    if (filters.search.trim()) {
      const q = filters.search.trim().toLowerCase();
      const titleMatch = item.issue.title.toLowerCase().includes(q);
      const numberMatch = String(item.issue.number).includes(filters.search.trim());
      if (!titleMatch && !numberMatch) return false;
    }
    return true;
  });
}
