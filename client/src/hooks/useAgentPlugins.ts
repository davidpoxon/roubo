import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentPluginsResponse } from "@roubo/shared";
import * as api from "../lib/api";

/** How often the list is re-read while any choice probe is still loading. */
export const PROBE_POLL_INTERVAL_MS = 1_000;

/** True while any agent's choice probe has not produced an outcome yet. */
function anyProbeLoading(data: AgentPluginsResponse | undefined): boolean {
  return (
    data?.agents.some((agent) =>
      Object.values(agent.choiceProbes ?? {}).some((probe) => probe.state === "loading"),
    ) ?? false
  );
}

/**
 * The installed agent plugins and their app-level configuration (issue #508).
 *
 * One query for the whole list, mirroring `usePlugins`. Each plugin's saved
 * config rides along in the list payload, so the AI Agents screen paints every
 * card's form from a single fetch and never has to fan out per plugin.
 *
 * A choice probe runs asynchronously on the server, so the first read can serve
 * a probed field as `loading` (#852). While any field is loading, the list is
 * re-read every second until each probe settles, and polling then stops. The
 * server kills a probe at 5s, so a field leaves its loading state within that
 * window without the user reopening the screen (#853, APCC-TC-019).
 */
export function useAgentPlugins() {
  return useQuery({
    queryKey: ["agent-plugins"],
    queryFn: api.fetchAgentPlugins,
    staleTime: 30_000,
    refetchInterval: (query) =>
      anyProbeLoading(query.state.data) ? PROBE_POLL_INTERVAL_MS : false,
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
