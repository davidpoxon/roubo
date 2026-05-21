import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: api.fetchProjects,
  });
}

export function useCheckConfig(repoPath: string) {
  const trimmed = repoPath.trim();
  return useQuery({
    queryKey: ["check-config", trimmed],
    queryFn: () => api.checkConfig(trimmed),
    enabled: trimmed.length > 0,
    staleTime: 5000,
  });
}

export function useRegisterProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repoPath: string) => api.registerProject(repoPath),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useUnregisterProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, force }: { projectId: string; force?: boolean }) =>
      api.unregisterProject(projectId, { force }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useReloadProjectConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.reloadProjectConfig(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
