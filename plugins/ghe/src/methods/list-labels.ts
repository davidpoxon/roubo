import type { ListLabelsParams } from "@roubo/plugin-sdk";
import { requirePrimarySource } from "../sources.js";
import { fetchLabels } from "../github-fetchers.js";

export async function listLabels(params: ListLabelsParams): Promise<string[]> {
  const source = requirePrimarySource(params.sources);
  if (source.kind !== "repo") return [];
  return fetchLabels(source.externalId);
}
