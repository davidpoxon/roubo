import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useContainers() {
  return useQuery({
    queryKey: ["containers"],
    queryFn: api.fetchContainers,
  });
}

export function useAssignContainer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      containerId,
      component,
    }: {
      projectId: string;
      benchId: number;
      containerId: string;
      component: string;
    }) => api.assignContainer(projectId, benchId, containerId, component),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useUnassignContainer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      component,
    }: {
      projectId: string;
      benchId: number;
      component: string;
    }) => api.unassignContainer(projectId, benchId, component),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}
