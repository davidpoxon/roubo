import type { NormalizedIssue } from "@roubo/shared";
import { issueFacetValues } from "./cut-list-filters";

/**
 * The active group-by dimension is a facet id (e.g. "type", "label",
 * "milestone") or the "none" sentinel when grouping is off. Dimensions are
 * facet-driven: any facet the active plugin exposes can be grouped on, reusing
 * the same value resolver the filters use.
 */
export type GroupByDimension = string;

const NONE = "none";

export interface GroupingState {
  groupBy: GroupByDimension;
}

export interface CutListGroup {
  key: string;
  label: string;
  items: NormalizedIssue[];
}

export function createEmptyGrouping(): GroupingState {
  return { groupBy: NONE };
}

export function isGroupingActive(grouping: GroupingState): boolean {
  return grouping.groupBy !== NONE;
}

const NONE_KEY = "__none__";

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * Bucket issues by the values they resolve for `facetId`. Multi-valued facets
 * (e.g. labels, assignees) place an issue in every matching bucket; issues with
 * no value fall into a single "No {facetLabel}" bucket sorted last. `facetLabel`
 * is the facet's display label, used only to name that empty bucket.
 */
export function groupItems(
  issues: NormalizedIssue[],
  facetId: GroupByDimension,
  facetLabel: string,
): CutListGroup[] {
  if (facetId === NONE) return [];
  if (issues.length === 0) return [];

  const emptyLabel = `No ${facetLabel.toLowerCase()}`;
  const buckets = new Map<string, CutListGroup>();

  for (const issue of issues) {
    const values = issueFacetValues(issue, facetId);
    if (values.length === 0) {
      let bucket = buckets.get(NONE_KEY);
      if (!bucket) {
        bucket = { key: NONE_KEY, label: emptyLabel, items: [] };
        buckets.set(NONE_KEY, bucket);
      }
      bucket.items.push(issue);
    } else {
      for (const value of values) {
        let bucket = buckets.get(value);
        if (!bucket) {
          bucket = { key: value, label: value, items: [] };
          buckets.set(value, bucket);
        }
        bucket.items.push(issue);
      }
    }
  }

  const noneBucket = buckets.get(NONE_KEY);
  const named: CutListGroup[] = [];
  for (const [key, bucket] of buckets) {
    if (key !== NONE_KEY) named.push(bucket);
  }

  named.sort((a, b) => collator.compare(a.label, b.label));
  if (noneBucket) named.push(noneBucket);

  return named;
}
