import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

// Load the replacement picker's candidate closure (#774, SATCA-FR-028/FR-029):
// the chosen specification's cases plus every spec its pointers transitively
// reach, so the picker can preview a candidate pointer with the SAME shared
// resolver the gate uses rather than a second implementation of the rules.
//
// Follows useTestbenchPlan's conventions: `retry: false` (a 404 for a bench with
// no focused spec is an answer, not a flake) and an `enabled` gate so nothing is
// fetched until the picker is actually open.
//
// `slug` is part of the key, so switching the specification selector refetches
// that spec's closure rather than reusing the previous spec's cases. `undefined`
// asks the server for the bench's own focused spec.
export function replacementCandidatesQueryKey(
  projectId: string,
  benchId: number,
  slug: string | undefined,
) {
  return ["replacementCandidates", projectId, benchId, slug ?? null] as const;
}

export function useReplacementCandidates(
  projectId: string,
  benchId: number,
  slug: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: replacementCandidatesQueryKey(projectId, benchId, slug),
    queryFn: () => api.fetchReplacementCandidates(projectId, benchId, slug),
    retry: false,
    enabled,
  });
}
