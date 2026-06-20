import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FilterFacet } from "@roubo/shared";
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
 * Fetches the active integration plugin's declared cut-list sort fields via
 * `getSortFields` (CLI-FR-009). Keyed by `pluginId` so switching the active
 * integration triggers a refetch and old sort fields never bleed across.
 * Returns an empty array when the plugin omits the method (server maps
 * `MethodNotFound` to `[]`); the panel then renders no sort picker
 * (CLI-FR-011).
 */
export function useSortFields(projectId: string | undefined, pluginId: string | null) {
  return useQuery({
    queryKey: ["sort-fields", projectId, pluginId],
    queryFn: () => api.fetchSortFields(projectId as string),
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

/**
 * Warm the option cache for every `enum-async` facet as soon as the facet
 * descriptors are known, so the filter popover shows options immediately
 * instead of behind a "Load options" click. Uses the exact same query key /
 * fn / staleTime as `useFacetOptions`, so the popover's own queries dedupe
 * against these and resolve from cache.
 */
export function usePrefetchFacetOptions(
  projectId: string | undefined,
  pluginId: string | null,
  facets: FilterFacet[],
) {
  const queryClient = useQueryClient();
  // Stable dependency: the ids of the async facets to prefetch.
  const asyncFacetIds = facets
    .filter((f) => f.type === "enum-async")
    .map((f) => f.id)
    .join(",");

  useEffect(() => {
    if (!projectId || !pluginId || asyncFacetIds.length === 0) return;
    for (const facetId of asyncFacetIds.split(",")) {
      void queryClient.prefetchQuery({
        queryKey: ["facet-options", projectId, pluginId, facetId],
        queryFn: () => api.fetchFacetOptions(projectId, facetId),
        staleTime: 5 * 60_000,
      });
    }
  }, [queryClient, projectId, pluginId, asyncFacetIds]);
}
