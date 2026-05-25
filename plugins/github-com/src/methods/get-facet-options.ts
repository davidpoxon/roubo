import type { FilterFacetOption, GetFacetOptionsParams } from "@roubo/plugin-sdk";
import { requirePrimarySource } from "../sources.js";
import { fetchMilestones } from "../github-fetchers.js";

export async function getFacetOptions(params: GetFacetOptionsParams): Promise<FilterFacetOption[]> {
  if (params.facetId !== "milestone") return [];

  const source = requirePrimarySource(params.sources);
  if (source.kind !== "repo") return [];

  const titles = await fetchMilestones(source.externalId);
  const options: FilterFacetOption[] = titles.map((title) => ({ value: title, label: title }));

  if (!params.search) return options;
  const needle = params.search.toLowerCase();
  return options.filter((o) => o.label.toLowerCase().includes(needle));
}
