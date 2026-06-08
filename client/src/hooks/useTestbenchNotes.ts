import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Note } from "@roubo/shared/testbench-contracts";
import * as api from "../lib/api";
import { testbenchPlanQueryKey } from "./useTestbenchPlan";

// Append-only note mutation (#421). Posts to the case notes route and returns
// the server-stamped Note (author + timestamp + status-at-write). On success it
// invalidates the testbench plan query (plan + per-case results, including each
// case's notes timeline) so the case-detail notes rail refetches and renders the
// appended note. The rail reads `result.notes` from that single plan query, the
// same key the mark/override mutations invalidate, so notes must invalidate it
// too. The 400 path (blank/whitespace text) surfaces as an ApiError to the
// caller via the mutation's error state.
export function useAppendNote() {
  const queryClient = useQueryClient();
  return useMutation<
    Note,
    Error,
    { projectId: string; benchId: number; caseId: string; text: string }
  >({
    mutationFn: ({ projectId, benchId, caseId, text }) =>
      api.appendNote(projectId, benchId, caseId, text),
    onSuccess: (_note, vars) => {
      queryClient.invalidateQueries({
        queryKey: testbenchPlanQueryKey(vars.projectId, vars.benchId),
      });
    },
  });
}
