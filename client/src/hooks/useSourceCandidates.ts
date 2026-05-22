import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

/**
 * Fetches `listSourceCandidates` for the active integration plugin on a
 * project. Keyed by `pluginId` so switching the active integration triggers a
 * refetch instead of serving stale candidates from a different plugin.
 */
export function useSourceCandidates(projectId: string | undefined, pluginId: string | null) {
  return useQuery({
    queryKey: ["source-candidates", projectId, pluginId],
    queryFn: () => api.fetchSourceCandidates(projectId as string),
    enabled: !!projectId && !!pluginId,
    staleTime: 60_000,
  });
}
