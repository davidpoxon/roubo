import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { ProjectSettings, ProjectSettingsResponse } from "@roubo/shared";

export function useProjectSettings(projectId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: () => api.fetchProjectSettings(projectId),
    enabled: !!projectId,
  });

  const mutation = useMutation({
    mutationFn: (settings: ProjectSettings) => api.updateProjectSettings(projectId, settings),
    onMutate: async (newSettings) => {
      await queryClient.cancelQueries({ queryKey: ["project-settings", projectId] });
      const previous = queryClient.getQueryData<ProjectSettingsResponse>([
        "project-settings",
        projectId,
      ]);
      queryClient.setQueryData<ProjectSettingsResponse>(["project-settings", projectId], (old) => ({
        ...(old ?? {}),
        ...newSettings,
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["project-settings", projectId], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["project-settings", projectId] });
    },
  });

  return {
    settings: query.data,
    isLoading: query.isLoading,
    updateSettings: mutation.mutate,
    updateSettingsAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isError: mutation.isError,
    error: mutation.error,
    isFetchError: query.isError,
    fetchError: query.error,
  };
}
