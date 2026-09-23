import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentPluginState } from "@roubo/shared";
import * as api from "../lib/api";

/** How often the list is re-read while any choice probe is still loading. */
export const PROBE_POLL_INTERVAL_MS = 1_000;

/**
 * The most reads one loading episode makes before polling gives up. The server
 * kills a probe at 5s, so a warm that answers settles well inside this; the cap
 * only stops a warm that never writes an outcome from polling for as long as the
 * screen is open.
 */
export const PROBE_POLL_MAX_READS = 10;

/** The slice of an agent list the probe poll reads: app-level and project-level alike. */
interface ProbedAgentList {
  agents: Array<Pick<AgentPluginState, "unavailable" | "choiceProbes">>;
}

/**
 * True while any runnable agent's choice probe has not produced an outcome yet.
 * An unavailable agent is skipped: the server never warms its probes, so its
 * fields report `loading` on every read and polling would never settle.
 */
function anyProbeLoading(data: ProbedAgentList | undefined): boolean {
  return (
    data?.agents.some(
      (agent) =>
        !agent.unavailable &&
        Object.values(agent.choiceProbes ?? {}).some((probe) => probe.state === "loading"),
    ) ?? false
  );
}

/**
 * A `refetchInterval` for any query whose agents carry a `choiceProbes` map:
 * re-read every second while a field is `loading`, for at most
 * `PROBE_POLL_MAX_READS` reads per loading episode, and stop once every probe
 * settles. A field reads `loading` on the first read after the server starts,
 * and again on the first read after its last result aged out of the one-minute
 * cache window (APCC-TC-024), so every screen that draws probed choices needs
 * it or it keeps the bare declared field until the next reopen.
 */
export function useChoiceProbePoll() {
  // The read count at which the current loading episode began, so the cap
  // counts only this episode's reads and never earlier saves or refetches.
  const loadingSince = useRef<number | null>(null);
  return (query: {
    state: { data: ProbedAgentList | undefined; dataUpdateCount: number };
  }): number | false => {
    if (!anyProbeLoading(query.state.data)) {
      loadingSince.current = null;
      return false;
    }
    loadingSince.current ??= query.state.dataUpdateCount;
    return query.state.dataUpdateCount - loadingSince.current < PROBE_POLL_MAX_READS
      ? PROBE_POLL_INTERVAL_MS
      : false;
  };
}

/**
 * The installed agent plugins and their app-level configuration (#1032).
 *
 * One query for the whole list, mirroring `usePlugins`. Each plugin's saved
 * config rides along in the list payload, so the AI Agents screen paints every
 * card's form from a single fetch and never has to fan out per plugin.
 *
 * A choice probe runs asynchronously on the server, so the first read can serve
 * a probed field as `loading` (#1268). While any field is loading, the list is
 * re-read every second until each probe settles, and polling then stops. The
 * server kills a probe at 5s, so a field leaves its loading state within that
 * window without the user reopening the screen (#1274, APCC-TC-019).
 */
export function useAgentPlugins() {
  const refetchInterval = useChoiceProbePoll();
  return useQuery({
    queryKey: ["agent-plugins"],
    queryFn: api.fetchAgentPlugins,
    staleTime: 30_000,
    refetchInterval,
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
