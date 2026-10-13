import type { QueryClient } from "@tanstack/react-query";

/**
 * Refetch every cached view of the github-com credential after GitHub sign-in
 * completes, so the Configure dialog reflects the new token without a manual
 * Verify click. Also busts the cut list and per-source warnings so a re-consent
 * flow (IP-WU-039) immediately hides the inline affordance and surfaces
 * freshly-permitted alerts.
 *
 * The live connection-status query uses staleTime: Infinity and only refetches
 * when its key is invalidated. Without this, a disconnect-then-reconnect keeps
 * serving the stale "disconnected" status, so the Configure dialog stays on
 * "Connect GitHub" even though the token was saved.
 */
export function invalidateGithubConnectionQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["plugin-connection-status", "github-com"] });
  void queryClient.invalidateQueries({ queryKey: ["global-plugin-integration", "github-com"] });
  void queryClient.invalidateQueries({ queryKey: ["project-integration"] });
  void queryClient.invalidateQueries({ queryKey: ["source-candidates"] });
  void queryClient.invalidateQueries({ queryKey: ["issues"] });
  void queryClient.invalidateQueries({ queryKey: ["integration-warnings"] });
}
