import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { RouboConfig } from "@roubo/shared";
import * as api from "../lib/api";

export function useEnvKeys() {
  return useQuery({
    queryKey: ["env-keys"],
    queryFn: () => api.fetchEnvKeys(),
    staleTime: 60_000,
  });
}

export function useScanRepo(repoPath: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo-scan", repoPath],
    queryFn: () => api.scanRepo(repoPath),
    enabled: enabled && !!repoPath,
    staleTime: 30_000,
  });
}

export function useValidateConfig() {
  return useMutation({
    mutationFn: ({
      config,
      currentProjectId,
    }: {
      config: RouboConfig;
      currentProjectId?: string;
    }) => api.validateConfig(config, currentProjectId),
  });
}

export function useSaveConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ repoPath, config }: { repoPath: string; config: RouboConfig }) =>
      api.saveConfig(repoPath, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useGitHubProjects(repo: string) {
  return useQuery({
    queryKey: ["github-projects", repo],
    queryFn: () => api.fetchGitHubProjects(repo),
    enabled: !!repo && repo.includes("/"),
    staleTime: 30_000,
    retry: false,
  });
}

export function useRawConfig(projectId: string | undefined) {
  return useQuery({
    queryKey: ["raw-config", projectId],
    queryFn: () => api.fetchRawConfig(projectId as string),
    enabled: !!projectId,
  });
}

export function useSaveRawConfig(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ yaml }: { yaml: string }) => api.saveRawConfig(projectId as string, yaml),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["raw-config", projectId] });
    },
  });
}
