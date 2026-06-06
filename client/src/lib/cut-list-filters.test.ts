import { describe, it, expect } from "vitest";
import type { NormalizedIssue } from "@roubo/shared";
import {
  applyFilters,
  activeFilterCount,
  createEmptyFilters,
  getFacetSelection,
  isFiltersEmpty,
  setFacetSelection,
} from "./cut-list-filters";

function makeIssue(externalId: string, overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId,
    externalUrl: `https://github.com/org/repo/issues/${externalId}`,
    title: `Issue ${externalId}`,
    body: null,
    currentState: "Open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2024-01-01T00:00:00Z",
    raw: null,
    ...overrides,
  };
}

describe("createEmptyFilters", () => {
  it("returns an empty, fresh state", () => {
    const f = createEmptyFilters();
    expect(f.search).toBe("");
    expect(Object.keys(f.facetValues)).toHaveLength(0);
  });
});

describe("isFiltersEmpty", () => {
  it("is empty when no facets and no search", () => {
    expect(isFiltersEmpty(createEmptyFilters())).toBe(true);
  });

  it("is non-empty when a facet selection exists", () => {
    const f = setFacetSelection(createEmptyFilters(), "type", new Set(["Bug"]));
    expect(isFiltersEmpty(f)).toBe(false);
  });

  it("is non-empty when search is set", () => {
    expect(isFiltersEmpty({ ...createEmptyFilters(), search: "fix" })).toBe(false);
  });
});

describe("activeFilterCount", () => {
  it("counts each non-empty facet selection", () => {
    let f = createEmptyFilters();
    expect(activeFilterCount(f)).toBe(0);
    f = setFacetSelection(f, "type", new Set(["Bug"]));
    expect(activeFilterCount(f)).toBe(1);
    f = setFacetSelection(f, "label", new Set(["frontend", "backend"]));
    expect(activeFilterCount(f)).toBe(2);
  });

  it("does not count the search field", () => {
    expect(activeFilterCount({ ...createEmptyFilters(), search: "x" })).toBe(0);
  });
});

describe("setFacetSelection / getFacetSelection", () => {
  it("set then get returns the same set", () => {
    const f = setFacetSelection(createEmptyFilters(), "type", new Set(["Bug", "Feature"]));
    expect(getFacetSelection(f, "type")).toEqual(new Set(["Bug", "Feature"]));
  });

  it("setting an empty set removes the facet entry", () => {
    let f = setFacetSelection(createEmptyFilters(), "type", new Set(["Bug"]));
    f = setFacetSelection(f, "type", new Set());
    expect(f.facetValues.type).toBeUndefined();
  });

  it("getFacetSelection returns an empty set for unknown facet ids", () => {
    expect(getFacetSelection(createEmptyFilters(), "milestone").size).toBe(0);
  });
});

describe("applyFilters", () => {
  const issues = [
    makeIssue("1", { issueType: "Bug", labels: ["frontend", "api"], currentState: "Open" }),
    makeIssue("2", { issueType: "Feature", labels: ["backend"], currentState: "In progress" }),
    makeIssue("3", { issueType: "Bug", labels: ["frontend"], currentState: "Closed" }),
    makeIssue("4", { labels: [], currentState: "Done" }),
  ];

  it("returns all issues when filters are empty and no exclusions apply", () => {
    expect(applyFilters(issues, createEmptyFilters())).toHaveLength(4);
  });

  it("matches a facet selection against issue.facetValues when present (TC-127)", () => {
    const withMilestone = [
      makeIssue("10", { facetValues: { milestone: "v1.0" } }),
      makeIssue("11", { facetValues: { milestone: "v2.0" } }),
      makeIssue("12", { facetValues: { milestone: ["v1.0", "v2.0"] } }),
      makeIssue("13"),
    ];
    const filters = setFacetSelection(createEmptyFilters(), "milestone", new Set(["v1.0"]));
    const out = applyFilters(withMilestone, filters);
    expect(out.map((i) => i.externalId)).toEqual(["10", "12"]);
  });

  it("falls back to canonical fields for the four common facets when facetValues is absent", () => {
    const filters = setFacetSelection(createEmptyFilters(), "type", new Set(["Bug"]));
    const out = applyFilters(issues, filters);
    expect(out.map((i) => i.externalId)).toEqual(["1", "3"]);
  });

  it("does not exclude any status client-side (exclusion is applied in the query)", () => {
    // Status exclusion moved into the query (FR-009): every fetched issue is
    // shown, so a Closed/Done issue that reaches the client is rendered rather
    // than silently dropped. The query is now the single source of truth.
    const out = applyFilters(issues, createEmptyFilters());
    expect(out.map((i) => i.externalId)).toEqual(["1", "2", "3", "4"]);
  });

  it("search filters by title and externalId", () => {
    const out = applyFilters(
      [
        makeIssue("10", { title: "Add dark mode support" }),
        makeIssue("123", { title: "Fix login bug" }),
      ],
      { ...createEmptyFilters(), search: "LOGIN" },
    );
    expect(out.map((i) => i.externalId)).toEqual(["123"]);
  });

  it("status facet selection uses issue.currentState when facetValues.status is absent", () => {
    const filters = setFacetSelection(createEmptyFilters(), "status", new Set(["Open"]));
    const out = applyFilters(issues, filters);
    expect(out.map((i) => i.externalId)).toEqual(["1"]);
  });

  it("recompute over 500 issues finishes well under the 50ms p95 budget (TC-139)", () => {
    const big: NormalizedIssue[] = [];
    for (let i = 0; i < 500; i++) {
      big.push(
        makeIssue(String(i), {
          issueType: i % 2 === 0 ? "Bug" : "Feature",
          labels: [`label-${i % 7}`],
          currentState: i % 5 === 0 ? "Closed" : "Open",
          title: `Issue number ${i}`,
          facetValues: { milestone: `v${(i % 10) + 1}.0` },
        }),
      );
    }
    const filters = setFacetSelection(
      setFacetSelection(createEmptyFilters(), "type", new Set(["Bug"])),
      "milestone",
      new Set(["v1.0", "v3.0", "v5.0"]),
    );
    const samples: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      applyFilters(big, filters);
      samples.push(performance.now() - t0);
    }
    const worst = Math.max(...samples);
    // 50ms is the spec budget; assert a generous 25ms cap so CI noise doesn't
    // flake the test while still catching genuine regressions.
    expect(worst).toBeLessThan(25);
  });
});
