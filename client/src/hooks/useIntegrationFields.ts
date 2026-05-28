import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { IntegrationFieldsUpdate } from "@roubo/shared";
import * as api from "../lib/api";

export function useIntegrationFields(projectId: string | undefined) {
  return useQuery({
    queryKey: ["integration-fields", projectId],
    queryFn: () => api.fetchIntegrationFields(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useSaveIntegrationFields(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: IntegrationFieldsUpdate) => api.saveIntegrationFields(projectId, update),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integration-fields", projectId] });
      // The fields live in roubo.yaml, so anything reading the parsed project
      // config (settings tile, source picker, GitHub project hook) needs to
      // re-fetch as well.
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
      // Server re-derives github-com sources from the new repo/submodules in a
      // best-effort hook, so the preview the Configure modal renders needs to
      // re-fetch alongside the fields it was driven from.
      void queryClient.invalidateQueries({ queryKey: ["github-derived-sources", projectId] });
    },
  });
}
