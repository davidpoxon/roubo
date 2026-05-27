import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SourceSelection } from "@roubo/shared";
import * as api from "../lib/api";

export function useSaveProjectSources(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sources: SourceSelection) => api.saveProjectSources(projectId, sources),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
      // TC-165: toggling an alert flag on changes the set of categories the
      // plugin will probe on the next listIssues pull, so the cached issue
      // list and the integration warnings that drive the inline re-consent
      // chip both need to refetch. Mirrors the invalidation set in
      // OAuthReconsentDialog and useDeepLink.
      void queryClient.invalidateQueries({ queryKey: ["issues"] });
      void queryClient.invalidateQueries({ queryKey: ["integration-warnings"] });
    },
  });
}
