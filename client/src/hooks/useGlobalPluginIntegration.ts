import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntegrationConfigUpdate } from "@roubo/shared";
import * as api from "../lib/api";

export function useGlobalPluginIntegration(pluginId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["global-plugin-integration", pluginId],
    queryFn: () => api.fetchGlobalPluginIntegration(pluginId as string),
    enabled: !!pluginId && enabled,
    staleTime: 30_000,
  });
}

export function useTestGlobalPluginIntegration(pluginId: string) {
  return useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      api.testGlobalPluginIntegration(pluginId, config),
  });
}

export function useSaveGlobalPluginIntegration(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: Omit<IntegrationConfigUpdate, "sources">) =>
      api.saveGlobalPluginIntegration(pluginId, update),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["global-plugin-integration", pluginId] });
      // Any project whose active plugin is this one inherits the global
      // default, so its effective config may have changed; nudge them too.
      void queryClient.invalidateQueries({ queryKey: ["project-integration"] });
    },
  });
}
