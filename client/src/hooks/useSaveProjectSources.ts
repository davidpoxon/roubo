import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SourceSelection } from "@roubo/shared";
import * as api from "../lib/api";

export function useSaveProjectSources(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sources: SourceSelection) => api.saveProjectSources(projectId, sources),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
    },
  });
}
