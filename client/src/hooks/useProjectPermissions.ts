import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { ProjectPermissions } from "@roubo/shared";

export function useProjectPermissions(projectId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["project-permissions", projectId],
    queryFn: () => api.fetchProjectPermissions(projectId),
    enabled: !!projectId,
  });

  const mutation = useMutation({
    mutationFn: (permissions: ProjectPermissions) =>
      api.updateProjectPermissions(projectId, permissions),
    onMutate: async (newPermissions) => {
      await queryClient.cancelQueries({
        queryKey: ["project-permissions", projectId],
      });
      const previous = queryClient.getQueryData<ProjectPermissions>([
        "project-permissions",
        projectId,
      ]);
      queryClient.setQueryData(["project-permissions", projectId], newPermissions);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["project-permissions", projectId], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["project-permissions", projectId],
      });
    },
  });

  const resyncMutation = useMutation({
    mutationFn: () => api.resyncProjectPermissions(projectId),
  });

  return {
    permissions: query.data,
    isLoading: query.isLoading,
    updatePermissions: mutation.mutate,
    isError: mutation.isError || query.isError,
    error: mutation.error ?? query.error,
    resyncBenches: resyncMutation.mutate,
    isResyncing: resyncMutation.isPending,
  };
}
