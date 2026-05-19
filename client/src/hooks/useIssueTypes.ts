import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useIssueTypes(projectId: string | undefined) {
  return useQuery({
    queryKey: ["issue-types", projectId],
    queryFn: () => api.fetchIssueTypes(projectId as string),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

export function useIssueTypeMappings(projectId: string | undefined) {
  return useQuery({
    queryKey: ["issue-type-mappings", projectId],
    queryFn: () => api.fetchProjectIssueTypeMappings(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useUpdateIssueTypeMappings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mappings: Record<string, string>) =>
      api.updateProjectIssueTypeMappings(projectId, mappings),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["issue-type-mappings", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
