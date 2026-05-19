import type { GitHubProjectItem } from "@roubo/shared";

export type GroupByDimension = "none" | "milestone" | "status" | "type" | "labels";

export interface GroupingState {
  groupBy: GroupByDimension;
}

export interface CutListGroup {
  key: string;
  label: string;
  items: GitHubProjectItem[];
}

export function createEmptyGrouping(): GroupingState {
  return { groupBy: "none" };
}

export function isGroupingActive(grouping: GroupingState): boolean {
  return grouping.groupBy !== "none";
}

const NONE_KEY = "__none__";

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function dimensionLabel(dim: GroupByDimension): string {
  switch (dim) {
    case "milestone":
      return "No milestone";
    case "status":
      return "No status";
    case "type":
      return "No type";
    case "labels":
      return "Unlabeled";
    case "none":
      return ""; // groupItems returns [] for 'none' before this is called
  }
}

export function groupItems(items: GitHubProjectItem[], dim: GroupByDimension): CutListGroup[] {
  if (dim === "none") return [];
  if (items.length === 0) return [];

  const buckets = new Map<string, CutListGroup>();

  for (const item of items) {
    if (dim === "labels") {
      const labels = item.issue.labels;
      if (labels.length === 0) {
        let bucket = buckets.get(NONE_KEY);
        if (!bucket) {
          bucket = { key: NONE_KEY, label: "Unlabeled", items: [] };
          buckets.set(NONE_KEY, bucket);
        }
        bucket.items.push(item);
      } else {
        for (const label of labels) {
          let bucket = buckets.get(label);
          if (!bucket) {
            bucket = { key: label, label, items: [] };
            buckets.set(label, bucket);
          }
          bucket.items.push(item);
        }
      }
    } else {
      const raw =
        dim === "milestone"
          ? item.issue.milestone
          : dim === "status"
            ? item.status
            : dim === "type"
              ? item.issue.type
              : undefined;

      if (!raw) {
        let bucket = buckets.get(NONE_KEY);
        if (!bucket) {
          bucket = { key: NONE_KEY, label: dimensionLabel(dim), items: [] };
          buckets.set(NONE_KEY, bucket);
        }
        bucket.items.push(item);
      } else {
        let bucket = buckets.get(raw);
        if (!bucket) {
          bucket = { key: raw, label: raw, items: [] };
          buckets.set(raw, bucket);
        }
        bucket.items.push(item);
      }
    }
  }

  // Separate the sentinel bucket from named ones
  const noneBucket = buckets.get(NONE_KEY);
  const named: CutListGroup[] = [];
  for (const [key, bucket] of buckets) {
    if (key !== NONE_KEY) named.push(bucket);
  }

  // Sort named groups alphabetically; sentinel always last
  named.sort((a, b) => collator.compare(a.label, b.label));
  if (noneBucket) named.push(noneBucket);

  return named;
}
