import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useProjectItems(projectId: string, projectNumber: number | undefined) {
  return useQuery({
    queryKey: ["project-items", projectId, projectNumber],
    queryFn: () => api.fetchProjectItems(projectId, projectNumber as number),
    enabled: !!projectNumber,
    staleTime: 30_000,
    refetchInterval: false,
    retry: false,
  });
}

export function useRefreshProjectItems() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["project-items"] });
}
