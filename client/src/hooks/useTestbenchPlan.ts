import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

// Load the TestBench source plan + this bench's recorded results, plus the
// server-computed `stale` flag (FR-016). The UI renders staleness and
// classification as the server reports them; it computes neither.
export function testbenchPlanQueryKey(projectId: string, benchId: number) {
  return ["testbenchPlan", projectId, benchId] as const;
}

export function useTestbenchPlan(projectId: string, benchId: number) {
  return useQuery({
    queryKey: testbenchPlanQueryKey(projectId, benchId),
    queryFn: () => api.fetchTestbenchPlan(projectId, benchId),
    retry: false,
  });
}
