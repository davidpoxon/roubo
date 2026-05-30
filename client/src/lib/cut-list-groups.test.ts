import { describe, it, expect } from "vitest";
import { groupItems, createEmptyGrouping, isGroupingActive } from "./cut-list-groups";
import type { NormalizedIssue } from "@roubo/shared";

function issue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId: "1",
    externalUrl: "https://example.com/1",
    title: "Test",
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2024-01-01T00:00:00Z",
    raw: {},
    ...overrides,
  };
}

describe("cut-list-groups", () => {
  describe("createEmptyGrouping", () => {
    it("returns none dimension", () => {
      expect(createEmptyGrouping()).toEqual({ groupBy: "none" });
    });
  });

  describe("isGroupingActive", () => {
    it("is false for none", () => {
      expect(isGroupingActive(createEmptyGrouping())).toBe(false);
    });
    it("is true for a real dimension", () => {
      expect(isGroupingActive({ groupBy: "type" })).toBe(true);
    });
  });

  describe("groupItems", () => {
    it("returns [] for none dimension", () => {
      expect(groupItems([], "none", "")).toEqual([]);
    });

    it("returns [] when there are no issues", () => {
      expect(groupItems([], "type", "Type")).toEqual([]);
    });

    it("groups by type with a 'No type' bucket last", () => {
      const issues = [
        issue({ externalId: "1", issueType: "Bug" }),
        issue({ externalId: "2", issueType: "Feature" }),
        issue({ externalId: "3", issueType: null }),
      ];
      const groups = groupItems(issues, "type", "Type");
      expect(groups.map((g) => g.label)).toEqual(["Bug", "Feature", "No type"]);
      expect(groups[2].items).toHaveLength(1);
    });

    it("groups by label, an issue in multiple buckets, empty bucket last", () => {
      const issues = [
        issue({ externalId: "1", labels: ["a", "b"] }),
        issue({ externalId: "2", labels: ["a"] }),
        issue({ externalId: "3", labels: [] }),
      ];
      const groups = groupItems(issues, "label", "Label");
      const a = groups.find((g) => g.key === "a");
      const b = groups.find((g) => g.key === "b");
      expect(a?.items).toHaveLength(2);
      expect(b?.items).toHaveLength(1);
      expect(groups[groups.length - 1].label).toBe("No label");
      expect(groups.find((g) => g.label === "No label")?.items).toHaveLength(1);
    });

    it("groups by milestone from facetValues", () => {
      const issues = [
        issue({ externalId: "1", facetValues: { milestone: "v1.0" } }),
        issue({ externalId: "2", facetValues: { milestone: "v2.0" } }),
        issue({ externalId: "3" }),
      ];
      const groups = groupItems(issues, "milestone", "Milestone");
      expect(groups.map((g) => g.label)).toEqual(["v1.0", "v2.0", "No milestone"]);
      expect(groups.find((g) => g.label === "No milestone")?.items).toHaveLength(1);
    });
  });
});
