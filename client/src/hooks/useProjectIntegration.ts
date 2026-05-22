import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useProjectIntegration(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-integration", projectId],
    queryFn: () => api.fetchProjectIntegration(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useSwitchProjectIntegration(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plugin: string) => api.switchProjectIntegration(projectId, plugin),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
      // Bench cards and bench detail derive the "Issue from previous integration"
      // badge from the project's active integration, so invalidate benches too.
      void queryClient.invalidateQueries({ queryKey: ["benches"] });
    },
  });
}
