import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { IntegrationConfigUpdate, SourceSelection } from "@roubo/shared";
import * as api from "../lib/api";

export function useProjectIntegration(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-integration", projectId],
    queryFn: () => api.fetchProjectIntegration(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useSwitchProjectIntegration(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plugin: string) => api.switchProjectIntegration(projectId, plugin),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
      // Bench cards and bench detail derive the "Issue from previous integration"
      // badge from the project's active integration, so invalidate benches too.
      void queryClient.invalidateQueries({ queryKey: ["benches"] });
    },
  });
}

export function usePromoteProjectIntegration(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.promoteProjectIntegration(projectId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
      // Benches derive integration-related badges from the project's active
      // integration, so refresh them too (mirrors the switch mutation).
      void queryClient.invalidateQueries({ queryKey: ["benches"] });
    },
  });
}

export function useTestIntegrationConnection(projectId: string) {
  return useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      api.testIntegrationConnection(projectId, config),
  });
}

export function useSaveIntegrationConfig(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: IntegrationConfigUpdate) => api.saveIntegrationConfig(projectId, update),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
    },
  });
}

// Declarative source picker (FR-019). Candidates are fetched lazily (only when
// the Configure dialog is open and connected) since they require a live plugin
// connection.
export function useSourceCandidates(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["integration-source-candidates", projectId],
    queryFn: () => api.fetchSourceCandidates(projectId),
    enabled: enabled && !!projectId,
    staleTime: 30_000,
  });
}

export function useSaveIntegrationSources(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sources: SourceSelection) => api.saveIntegrationSources(projectId, sources),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
    },
  });
}
