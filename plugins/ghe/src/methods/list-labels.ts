import { getPrimarySource } from "../active-config.js";
import { fetchLabels } from "../github-fetchers.js";

export async function listLabels(): Promise<string[]> {
  const source = getPrimarySource();
  if (source.kind !== "repo") return [];
  return fetchLabels(source.externalId);
}
