import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { BenchOverrides } from "../lib/api";
import type { RegisteredProject } from "@roubo/shared";

export function useUpdateProjectBenchOverrides(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<BenchOverrides>) =>
      api.updateProjectBenchOverrides(projectId, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ["projects"] });
      const previousProjects = queryClient.getQueryData<RegisteredProject[]>(["projects"]);
      if (previousProjects) {
        queryClient.setQueryData<RegisteredProject[]>(
          ["projects"],
          previousProjects.map((p) => {
            if (p.id !== projectId || !p.config) return p;
            const benchesPatch: Record<string, boolean | undefined> = {};
            if ("enforceIssueDependencies" in patch) {
              benchesPatch.enforceIssueDependencies =
                patch.enforceIssueDependencies === null
                  ? undefined
                  : patch.enforceIssueDependencies;
            }
            return {
              ...p,
              config: {
                ...p.config,
                benches: {
                  ...p.config.benches,
                  ...benchesPatch,
                },
              },
            };
          }),
        );
      }
      return { previousProjects };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousProjects !== undefined) {
        queryClient.setQueryData(["projects"], context.previousProjects);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
