import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import { PROJECT_SET_QUERY_KEYS } from "../lib/input-changed";

/** Refresh every view that reads the project set, after a register or an unregister. */
function invalidateProjectSet(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const queryKey of PROJECT_SET_QUERY_KEYS) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

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
    onSuccess: () => invalidateProjectSet(queryClient),
  });
}

export function useUnregisterProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, force }: { projectId: string; force?: boolean }) =>
      api.unregisterProject(projectId, { force }),
    // The cut list, the bench views and the settings screens drop the project
    // too, not only the project list (HR-TC-033).
    onSuccess: () => invalidateProjectSet(queryClient),
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
