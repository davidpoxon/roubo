import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bench } from "@roubo/shared";
import type { CaseLifecycle } from "@roubo/shared/testbench-contracts";
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

interface SetCaseLifecycleVars {
  projectId: string;
  benchId: number;
  caseId: string;
  // The record to write, or null to restore (remove it), which is what makes
  // every lifecycle action reversible (SATCA-FR-021).
  lifecycle: CaseLifecycle | null;
}

// The message a caller shows when a lifecycle write was refused. A 409 means the
// case file moved under the request, and the only useful instruction is to
// reload (SATCA-TC-056); anything else surfaces the server's own message.
export function caseLifecycleErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (api.isCaseFileConflict(error)) return api.CASE_FILE_CONFLICT_MESSAGE;
  return error instanceof Error ? error.message : String(error);
}

// Retire, supersede, or restore one case (#772, SATCA-FR-019/FR-021). Follows
// the useSetTestbenchFocus pattern: the server owns the write, and the plan query
// is invalidated on success so the panel re-reads the case file rather than the
// client guessing what the rollup now looks like. There is deliberately NO
// optimistic update: this write can be refused (409), and showing a case as
// retired before the file says so is exactly the drift the conflict check exists
// to prevent.
//
// The `If-Match` precondition is read from the cached plan, which IS the view the
// reviewer acted on, so the fingerprint sent is always the one they were shown.
// A cache with no fingerprint (an older server, or a plan that never loaded)
// fails fast rather than writing unconditionally.
export function useSetCaseLifecycle() {
  const queryClient = useQueryClient();
  return useMutation<api.SetCaseLifecycleResponse, Error, SetCaseLifecycleVars>({
    mutationFn: ({ projectId, benchId, caseId, lifecycle }) => {
      const cached = queryClient.getQueryData<TestbenchPlanData>(
        testbenchPlanQueryKey(projectId, benchId),
      );
      const fingerprint = cached?.caseFileFingerprint;
      if (typeof fingerprint !== "string" || fingerprint.length === 0) {
        return Promise.reject(new Error(api.CASE_FILE_CONFLICT_MESSAGE));
      }
      return api.setCaseLifecycle(projectId, benchId, caseId, lifecycle, fingerprint);
    },
    onSuccess: (_result, vars) => {
      queryClient.invalidateQueries({
        queryKey: testbenchPlanQueryKey(vars.projectId, vars.benchId),
      });
    },
  });
}
