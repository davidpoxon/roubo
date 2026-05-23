import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { ProjectDefaultJigResponse } from "@roubo/shared";

export function useProjectDefaultJig(projectId: string | undefined) {
  return useQuery({
    queryKey: ["jig-default", projectId],
    queryFn: () => api.fetchProjectDefaultJig(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useUpdateProjectDefaultJig(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jigId: string | null) => api.updateProjectDefaultJig(projectId, jigId),
    onMutate: async (jigId) => {
      await queryClient.cancelQueries({
        queryKey: ["jig-default", projectId],
      });
      const previousDefault = queryClient.getQueryData<ProjectDefaultJigResponse>([
        "jig-default",
        projectId,
      ]);
      if (previousDefault && jigId !== null) {
        queryClient.setQueryData<ProjectDefaultJigResponse>(["jig-default", projectId], {
          jigId,
          source: "project",
        });
      }
      return { previousDefault };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousDefault !== undefined) {
        queryClient.setQueryData(["jig-default", projectId], context.previousDefault);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["jig-default", projectId],
      });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
