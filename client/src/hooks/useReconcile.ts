import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import { testbenchPlanQueryKey } from "./useTestbenchPlan";

type ReconcileVars = { projectId: string; benchId: number };

// Preview reconcile: classify only, never writes (no `confirm`). Used to populate
// the reconcile dialog's Added / Changed / Orphan sections before the reviewer
// decides to apply.
export function useReconcilePreview() {
  return useMutation({
    mutationFn: ({ projectId, benchId }: ReconcileVars) =>
      api.reconcileTestbench(projectId, benchId, {}),
  });
}

// Apply reconcile: persists the non-destructive (orphan-not-delete) results and
// refreshes the plan hash. Orphans are retained, never purged. Invalidates the
// plan query so the banner clears once the stored hash matches the plan again.
export function useReconcileApply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, benchId }: ReconcileVars) =>
      api.reconcileTestbench(projectId, benchId, { confirm: true }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: testbenchPlanQueryKey(vars.projectId, vars.benchId),
      });
    },
  });
}

// Purge orphans: the separate, explicitly-confirmed destructive step (NFR-003).
// Physically drops orphaned results; gated behind its own confirmation in the UI.
export function useReconcilePurge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, benchId }: ReconcileVars) =>
      api.reconcileTestbench(projectId, benchId, { confirm: true, purgeOrphans: true }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: testbenchPlanQueryKey(vars.projectId, vars.benchId),
      });
    },
  });
}
