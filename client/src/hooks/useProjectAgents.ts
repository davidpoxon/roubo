import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import { useChoiceProbePoll } from "./useAgentPlugins";

/**
 * One project's agent plugins with their app defaults, override subsets, and
 * resolved effective configs (AP-FR-004, #1044).
 *
 * Keyed by project id so two projects' override screens never share a cache
 * entry. One query for the whole list, mirroring `useAgentPlugins`: every
 * card's rows paint from a single fetch.
 *
 * Polled like `useAgentPlugins` while any probed field is `loading`, so the
 * overrides section and the launch dialog pick up the choice list (or the
 * failure) on the same open instead of keeping the bare declared field.
 */
export function useProjectAgents(projectId: string) {
  const refetchInterval = useChoiceProbePoll();
  return useQuery({
    queryKey: ["project-agents", projectId],
    queryFn: () => api.fetchProjectAgents(projectId),
    staleTime: 30_000,
    refetchInterval,
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
