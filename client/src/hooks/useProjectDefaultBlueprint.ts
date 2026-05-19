import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { ProjectDefaultBlueprintResponse } from "@roubo/shared";

export function useProjectDefaultBlueprint(projectId: string | undefined) {
  return useQuery({
    queryKey: ["blueprint-default", projectId],
    queryFn: () => api.fetchProjectDefaultBlueprint(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useUpdateProjectDefaultBlueprint(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (blueprintId: string | null) =>
      api.updateProjectDefaultBlueprint(projectId, blueprintId),
    onMutate: async (blueprintId) => {
      await queryClient.cancelQueries({
        queryKey: ["blueprint-default", projectId],
      });
      const previousDefault = queryClient.getQueryData<ProjectDefaultBlueprintResponse>([
        "blueprint-default",
        projectId,
      ]);
      if (previousDefault && blueprintId !== null) {
        queryClient.setQueryData<ProjectDefaultBlueprintResponse>(
          ["blueprint-default", projectId],
          { blueprintId, source: "project" },
        );
      }
      return { previousDefault };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousDefault !== undefined) {
        queryClient.setQueryData(["blueprint-default", projectId], context.previousDefault);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprint-default", projectId],
      });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
