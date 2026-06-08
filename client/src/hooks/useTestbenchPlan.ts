import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

// The cached shape under the testbench-plan query key. Aliased so mutation hooks
// (#420) and the case detail pane can type their optimistic cache updates.
export type TestbenchPlanData = api.TestbenchPlanResponse;

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
