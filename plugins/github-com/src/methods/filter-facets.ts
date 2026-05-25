import type { FilterFacet } from "@roubo/plugin-sdk";

export function filterFacets(): FilterFacet[] {
  return [{ id: "milestone", label: "Milestone", type: "enum-async" }];
}
