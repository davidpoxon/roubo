import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Note } from "@roubo/shared/testbench-contracts";
import * as api from "../lib/api";

// Append-only note mutation (#421). Posts to the case notes route and returns
// the server-stamped Note (author + timestamp + status-at-write). On success it
// invalidates the case query so a host case-detail view (#16) refetches the
// updated notes timeline. The 400 path (blank/whitespace text) surfaces as an
// ApiError to the caller via the mutation's error state.
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
        queryKey: ["testbenchCase", vars.projectId, vars.benchId, vars.caseId],
      });
    },
  });
}
