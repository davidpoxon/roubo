import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

/**
 * Read-only preview of the sources Roubo will derive from the project's repo
 * (root + every resolvable submodule). Drives the small "Roubo will pull from"
 * line rendered under the Repository field in the github-com Configure modal.
 *
 * The server hits GitHub on each call but the response shape is small, so the
 * hook stays in cache for 30s; React Query will revalidate in the background
 * when the user re-opens the modal or after a successful field save (which
 * invalidates the `["integration-fields", projectId]` key).
 */
export function useDerivedGithubSources(projectId: string | undefined) {
  return useQuery({
    queryKey: ["github-derived-sources", projectId],
    queryFn: () => api.fetchDerivedGithubSources(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}
