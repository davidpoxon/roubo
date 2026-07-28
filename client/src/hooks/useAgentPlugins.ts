import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

/**
 * The installed agent plugins and their app-level configuration (issue #508).
 *
 * One query for the whole list, mirroring `usePlugins`. Each plugin's saved
 * config rides along in the list payload, so the AI Agents screen paints every
 * card's form from a single fetch and never has to fan out per plugin.
 */
export function useAgentPlugins() {
  return useQuery({
    queryKey: ["agent-plugins"],
    queryFn: api.fetchAgentPlugins,
    staleTime: 30_000,
  });
}

/**
 * Save one agent plugin's app-level defaults. The mutation is scoped to a
 * single plugin id, so two cards editing at once issue two independent writes
 * against two independent files (AP-TC-009).
 */
export function useSaveAgentConfig(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: Record<string, unknown>) => api.saveAgentConfig(pluginId, config),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-plugins"] });
    },
  });
}
