import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useInspectionRun(projectId: string, benchId: number) {
  return useQuery({
    queryKey: ["inspectionRun", projectId, benchId],
    queryFn: () => api.fetchInspectionRun(projectId, benchId),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "running" ? 1000 : false;
    },
    retry: false,
  });
}

export function useStartInspection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      filter,
    }: {
      projectId: string;
      benchId: number;
      filter?: string;
    }) => api.startInspection(projectId, benchId, filter),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["inspectionRun", vars.projectId, vars.benchId] });
    },
  });
}

export function useAbortInspection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, benchId }: { projectId: string; benchId: number }) =>
      api.abortInspection(projectId, benchId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["inspectionRun", vars.projectId, vars.benchId] });
    },
  });
}
