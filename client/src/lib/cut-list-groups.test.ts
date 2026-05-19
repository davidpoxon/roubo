import { describe, it, expect } from "vitest";
import type { GitHubProjectItem } from "@roubo/shared";
import { createEmptyGrouping, isGroupingActive, groupItems } from "./cut-list-groups";

function makeItem(
  number: number,
  overrides: {
    milestone?: string;
    type?: string;
    labels?: string[];
    status?: string | null;
  } = {},
): GitHubProjectItem {
  return {
    issue: {
      number,
      title: `Issue ${number}`,
      body: null,
      state: "OPEN",
      labels: overrides.labels ?? [],
      milestone: overrides.milestone,
      type: overrides.type,
      assignee: undefined,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      commentsCount: 0,
      htmlUrl: `https://github.com/org/repo/issues/${number}`,
    },
    status: overrides.status ?? null,
  };
}

describe("createEmptyGrouping", () => {
  it("returns groupBy none", () => {
    expect(createEmptyGrouping()).toEqual({ groupBy: "none" });
  });
});

describe("isGroupingActive", () => {
  it("returns false for none", () => {
    expect(isGroupingActive({ groupBy: "none" })).toBe(false);
  });

  it("returns true for all non-none dimensions", () => {
    expect(isGroupingActive({ groupBy: "milestone" })).toBe(true);
    expect(isGroupingActive({ groupBy: "status" })).toBe(true);
    expect(isGroupingActive({ groupBy: "type" })).toBe(true);
    expect(isGroupingActive({ groupBy: "labels" })).toBe(true);
  });
});

describe("groupItems", () => {
  it("returns [] for none dimension", () => {
    const items = [makeItem(1, { milestone: "Sprint 1" })];
    expect(groupItems(items, "none")).toEqual([]);
  });

  it("returns [] for empty items", () => {
    expect(groupItems([], "milestone")).toEqual([]);
    expect(groupItems([], "status")).toEqual([]);
    expect(groupItems([], "type")).toEqual([]);
    expect(groupItems([], "labels")).toEqual([]);
  });

  describe("milestone", () => {
    it("buckets items by milestone", () => {
      const items = [
        makeItem(1, { milestone: "Sprint 2" }),
        makeItem(2, { milestone: "Sprint 1" }),
        makeItem(3, { milestone: "Sprint 1" }),
      ];
      const groups = groupItems(items, "milestone");
      expect(groups).toHaveLength(2);
      const labels = groups.map((g) => g.label);
      expect(labels).toEqual(["Sprint 1", "Sprint 2"]);
      expect(groups[0].items.map((i) => i.issue.number)).toEqual([2, 3]);
      expect(groups[1].items.map((i) => i.issue.number)).toEqual([1]);
    });

    it('routes null milestone to sentinel bucket labelled "No milestone"', () => {
      const items = [makeItem(1), makeItem(2, { milestone: "Sprint 1" })];
      const groups = groupItems(items, "milestone");
      expect(groups[groups.length - 1]).toMatchObject({
        key: "__none__",
        label: "No milestone",
      });
      expect(groups[groups.length - 1].items.map((i) => i.issue.number)).toEqual([1]);
    });

    it("places sentinel bucket last even when alphabetically first", () => {
      const items = [
        makeItem(1), // no milestone
        makeItem(2, { milestone: "Zeta" }),
      ];
      const groups = groupItems(items, "milestone");
      expect(groups[0].label).toBe("Zeta");
      expect(groups[1].key).toBe("__none__");
    });

    it("preserves source order within a bucket", () => {
      const items = [
        makeItem(5, { milestone: "Sprint 1" }),
        makeItem(3, { milestone: "Sprint 1" }),
        makeItem(7, { milestone: "Sprint 1" }),
      ];
      const groups = groupItems(items, "milestone");
      expect(groups[0].items.map((i) => i.issue.number)).toEqual([5, 3, 7]);
    });

    it("sorts named groups case-insensitively", () => {
      const items = [
        makeItem(1, { milestone: "beta" }),
        makeItem(2, { milestone: "Alpha" }),
        makeItem(3, { milestone: "GAMMA" }),
      ];
      const groups = groupItems(items, "milestone");
      expect(groups.map((g) => g.label)).toEqual(["Alpha", "beta", "GAMMA"]);
    });
  });

  describe("status", () => {
    it("buckets items by status", () => {
      const items = [
        makeItem(1, { status: "In Progress" }),
        makeItem(2, { status: "Done" }),
        makeItem(3, { status: "In Progress" }),
      ];
      const groups = groupItems(items, "status");
      const byLabel = Object.fromEntries(
        groups.map((g) => [g.label, g.items.map((i) => i.issue.number)]),
      );
      expect(byLabel["Done"]).toEqual([2]);
      expect(byLabel["In Progress"]).toEqual([1, 3]);
    });

    it('routes null status to sentinel labelled "No status"', () => {
      const items = [makeItem(1, { status: null })];
      const groups = groupItems(items, "status");
      expect(groups[0]).toMatchObject({ key: "__none__", label: "No status" });
    });
  });

  describe("type", () => {
    it("buckets items by type", () => {
      const items = [
        makeItem(1, { type: "Bug" }),
        makeItem(2, { type: "Feature" }),
        makeItem(3, { type: "Bug" }),
      ];
      const groups = groupItems(items, "type");
      const byLabel = Object.fromEntries(
        groups.map((g) => [g.label, g.items.map((i) => i.issue.number)]),
      );
      expect(byLabel["Bug"]).toEqual([1, 3]);
      expect(byLabel["Feature"]).toEqual([2]);
    });

    it('routes undefined type to sentinel labelled "No type"', () => {
      const items = [makeItem(1)];
      const groups = groupItems(items, "type");
      expect(groups[0]).toMatchObject({ key: "__none__", label: "No type" });
    });
  });

  describe("labels", () => {
    it("places items with N labels in N buckets", () => {
      const items = [makeItem(1, { labels: ["frontend", "backend"] })];
      const groups = groupItems(items, "labels");
      expect(groups).toHaveLength(2);
      const keys = groups.map((g) => g.key).sort();
      expect(keys).toEqual(["backend", "frontend"]);
      // Same item appears in both groups
      for (const g of groups) {
        expect(g.items[0].issue.number).toBe(1);
      }
    });

    it('routes items with zero labels to "Unlabeled" bucket', () => {
      const items = [makeItem(1, { labels: [] })];
      const groups = groupItems(items, "labels");
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ key: "__none__", label: "Unlabeled" });
    });

    it("distinct-item count is less than sum of group counts when multi-label", () => {
      const items = [makeItem(1, { labels: ["a", "b"] }), makeItem(2, { labels: ["a"] })];
      const groups = groupItems(items, "labels");
      const totalGroupCount = groups.reduce((sum, g) => sum + g.items.length, 0);
      const distinctItemCount = items.length;
      expect(totalGroupCount).toBe(3); // item 1 counted twice
      expect(distinctItemCount).toBe(2);
      expect(totalGroupCount).toBeGreaterThan(distinctItemCount);
    });

    it("places Unlabeled bucket last", () => {
      const items = [makeItem(1, { labels: [] }), makeItem(2, { labels: ["backend"] })];
      const groups = groupItems(items, "labels");
      expect(groups[groups.length - 1].key).toBe("__none__");
    });

    it("sorts named label groups alphabetically", () => {
      const items = [makeItem(1, { labels: ["gamma", "Alpha", "beta"] })];
      const groups = groupItems(items, "labels");
      const namedGroups = groups.filter((g) => g.key !== "__none__");
      expect(namedGroups.map((g) => g.label)).toEqual(["Alpha", "beta", "gamma"]);
    });
  });
});
