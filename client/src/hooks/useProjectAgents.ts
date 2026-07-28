import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

/**
 * One project's agent plugins with their app defaults, override subsets, and
 * resolved effective configs (AP-FR-004, issue #509).
 *
 * Keyed by project id so two projects' override screens never share a cache
 * entry. One query for the whole list, mirroring `useAgentPlugins`: every
 * card's rows paint from a single fetch.
 */
export function useProjectAgents(projectId: string) {
  return useQuery({
    queryKey: ["project-agents", projectId],
    queryFn: () => api.fetchProjectAgents(projectId),
    staleTime: 30_000,
  });
}

/**
 * Save the override subset for one plugin in one project. Invalidating the
 * project's query is what makes an inherited field pick up the new effective
 * config after a save, without the component recomputing the overlay itself.
 */
export function useSaveProjectAgentOverride(projectId: string, pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      api.saveProjectAgentOverride(projectId, pluginId, config),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-agents", projectId] });
    },
  });
}
