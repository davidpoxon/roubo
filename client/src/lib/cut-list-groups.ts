import type { NormalizedIssue } from "@roubo/shared";

export type GroupByDimension = "none" | "type" | "labels";

export interface GroupingState {
  groupBy: GroupByDimension;
}

export interface CutListGroup {
  key: string;
  label: string;
  items: NormalizedIssue[];
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
    case "type":
      return "No type";
    case "labels":
      return "Unlabeled";
    case "none":
      return "";
  }
}

export function groupItems(issues: NormalizedIssue[], dim: GroupByDimension): CutListGroup[] {
  if (dim === "none") return [];
  if (issues.length === 0) return [];

  const buckets = new Map<string, CutListGroup>();

  for (const issue of issues) {
    if (dim === "labels") {
      const labels = issue.labels;
      if (labels.length === 0) {
        let bucket = buckets.get(NONE_KEY);
        if (!bucket) {
          bucket = { key: NONE_KEY, label: "Unlabeled", items: [] };
          buckets.set(NONE_KEY, bucket);
        }
        bucket.items.push(issue);
      } else {
        for (const label of labels) {
          let bucket = buckets.get(label);
          if (!bucket) {
            bucket = { key: label, label, items: [] };
            buckets.set(label, bucket);
          }
          bucket.items.push(issue);
        }
      }
    } else {
      const raw = dim === "type" ? issue.issueType : undefined;

      if (!raw) {
        let bucket = buckets.get(NONE_KEY);
        if (!bucket) {
          bucket = { key: NONE_KEY, label: dimensionLabel(dim), items: [] };
          buckets.set(NONE_KEY, bucket);
        }
        bucket.items.push(issue);
      } else {
        let bucket = buckets.get(raw);
        if (!bucket) {
          bucket = { key: raw, label: raw, items: [] };
          buckets.set(raw, bucket);
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
