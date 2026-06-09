import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bench } from "@roubo/shared";
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

// `enabled` gates the fetch on bench readiness (#500). On first load `createBench`
// returns `status: "preparing"` and provisions the worktree (and its
// `.specifications/<slug>/test-cases.json`) asynchronously, so firing the plan
// query before the worktree exists 404s with MissingPlanError. The caller passes
// `enabled: ready` so the query only fires once the worktree is present; it
// defaults to `true` so the gate is opt-in and existing callers are unaffected.
export function useTestbenchPlan(
  projectId: string,
  benchId: number,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: testbenchPlanQueryKey(projectId, benchId),
    queryFn: () => api.fetchTestbenchPlan(projectId, benchId),
    retry: false,
    enabled,
  });
}

interface SetFocusVars {
  projectId: string;
  benchId: number;
  focusedSpecPath: string;
}

// Re-point an active TestBench to a different focused spec (#423, FR-024). The
// re-point is explicit (driven by the header action + spec-picker confirm, never
// silent). On success we invalidate the plan query so the panel reloads the newly
// focused plan, its independently preserved results, and the server-computed
// `stale` flag; we also invalidate the bench detail + list queries so
// bench.focusedSpecPath updates wherever the bench is rendered. Per-spec result
// isolation is enforced server-side, so the client only switches the path and
// refetches.
export function useSetTestbenchFocus() {
  const queryClient = useQueryClient();
  return useMutation<Bench, Error, SetFocusVars>({
    mutationFn: ({ projectId, benchId, focusedSpecPath }) =>
      api.setTestbenchFocus(projectId, benchId, focusedSpecPath),
    onSuccess: (_bench, vars) => {
      queryClient.invalidateQueries({
        queryKey: testbenchPlanQueryKey(vars.projectId, vars.benchId),
      });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
      queryClient.invalidateQueries({ queryKey: ["benches"] });
    },
  });
}
