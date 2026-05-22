import { describe, it, expect } from "vitest";
import type { NormalizedIssue } from "@roubo/shared";
import { createEmptyGrouping, isGroupingActive, groupItems } from "./cut-list-groups";

function makeIssue(
  externalId: string,
  overrides: { issueType?: string | null; labels?: string[] } = {},
): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId,
    externalUrl: `https://github.com/org/repo/issues/${externalId}`,
    title: `Issue ${externalId}`,
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: overrides.labels ?? [],
    issueType: overrides.issueType ?? null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2024-01-01T00:00:00Z",
    raw: null,
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

  it("returns true for type and labels", () => {
    expect(isGroupingActive({ groupBy: "type" })).toBe(true);
    expect(isGroupingActive({ groupBy: "labels" })).toBe(true);
  });
});

describe("groupItems", () => {
  it("returns [] for none dimension", () => {
    expect(groupItems([makeIssue("1", { issueType: "bug" })], "none")).toEqual([]);
  });

  it("returns [] for empty issues", () => {
    expect(groupItems([], "type")).toEqual([]);
    expect(groupItems([], "labels")).toEqual([]);
  });

  describe("type", () => {
    it("buckets issues by issueType", () => {
      const issues = [
        makeIssue("1", { issueType: "Bug" }),
        makeIssue("2", { issueType: "Feature" }),
        makeIssue("3", { issueType: "Bug" }),
      ];
      const groups = groupItems(issues, "type");
      const byLabel = Object.fromEntries(
        groups.map((g) => [g.label, g.items.map((i) => i.externalId)]),
      );
      expect(byLabel["Bug"]).toEqual(["1", "3"]);
      expect(byLabel["Feature"]).toEqual(["2"]);
    });

    it('routes null issueType to sentinel labelled "No type"', () => {
      const groups = groupItems([makeIssue("1")], "type");
      expect(groups[0]).toMatchObject({ key: "__none__", label: "No type" });
    });

    it("places sentinel bucket last", () => {
      const issues = [makeIssue("1"), makeIssue("2", { issueType: "Zeta" })];
      const groups = groupItems(issues, "type");
      expect(groups[0].label).toBe("Zeta");
      expect(groups[1].key).toBe("__none__");
    });
  });

  describe("labels", () => {
    it("places issues with N labels in N buckets", () => {
      const groups = groupItems([makeIssue("1", { labels: ["frontend", "backend"] })], "labels");
      expect(groups).toHaveLength(2);
      const keys = groups.map((g) => g.key).sort();
      expect(keys).toEqual(["backend", "frontend"]);
      for (const g of groups) expect(g.items[0].externalId).toBe("1");
    });

    it('routes issues with zero labels to "Unlabeled" bucket', () => {
      const groups = groupItems([makeIssue("1", { labels: [] })], "labels");
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ key: "__none__", label: "Unlabeled" });
    });

    it("sorts named label groups alphabetically", () => {
      const groups = groupItems([makeIssue("1", { labels: ["gamma", "Alpha", "beta"] })], "labels");
      const namedGroups = groups.filter((g) => g.key !== "__none__");
      expect(namedGroups.map((g) => g.label)).toEqual(["Alpha", "beta", "gamma"]);
    });
  });
});
