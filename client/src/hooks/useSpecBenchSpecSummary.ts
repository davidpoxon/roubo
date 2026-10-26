import { useQuery } from "@tanstack/react-query";
import type { SpecBenchSpecSummary } from "@roubo/shared/delivery-bench";
import * as api from "../lib/api";

// The units and gates of the spec the Set up Spec Bench dialog has picked
// (SB-FR-001). Read only while a spec is picked; a read error surfaces in the
// dialog rather than being retried.
export function useSpecBenchSpecSummary(projectId: string, slug: string | null) {
  return useQuery<SpecBenchSpecSummary, Error>({
    queryKey: ["specbenchSpecSummary", projectId, slug],
    queryFn: () => api.fetchSpecBenchSpecSummary(projectId, slug ?? ""),
    enabled: projectId.length > 0 && slug !== null,
    retry: false,
  });
}
