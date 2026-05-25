import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

/**
 * Fetches the active integration plugin's filter-facet descriptors via
 * `filterFacets` (FR-065). Keyed by `pluginId` so switching the active
 * integration triggers a refetch and old facet shapes never bleed across.
 * Returns the COMMON_FACET_FALLBACK set when the plugin omits the method
 * (server handles the fallback; the client just consumes whatever it gets).
 */
export function useFilterFacets(projectId: string | undefined, pluginId: string | null) {
  return useQuery({
    queryKey: ["filter-facets", projectId, pluginId],
    queryFn: () => api.fetchFilterFacets(projectId as string),
    enabled: !!projectId && !!pluginId,
    staleTime: 5 * 60_000,
  });
}

/**
 * Lazy facet-option loader for `enum-async` facets. Disabled by default;
 * the consuming component sets `enabled` to true once the user opens the
 * facet section so the network call only fires on demand (TC-181). Keyed
 * separately per `facetId` so two open dropdowns don't trample each other.
 */
export function useFacetOptions(
  projectId: string | undefined,
  pluginId: string | null,
  facetId: string,
  opts: { enabled: boolean } = { enabled: false },
) {
  return useQuery({
    queryKey: ["facet-options", projectId, pluginId, facetId],
    queryFn: () => api.fetchFacetOptions(projectId as string, facetId),
    enabled: opts.enabled && !!projectId && !!pluginId && facetId.length > 0,
    staleTime: 5 * 60_000,
  });
}
