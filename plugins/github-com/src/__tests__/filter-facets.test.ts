import { describe, expect, it } from "vitest";
import { filterFacets } from "../methods/filter-facets.js";

describe("filterFacets", () => {
  it("returns the Milestone enum-async facet (FR-065)", () => {
    expect(filterFacets()).toEqual([{ id: "milestone", label: "Milestone", type: "enum-async" }]);
  });
});
