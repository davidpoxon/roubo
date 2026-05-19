import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { GitHubAuthStatus } from "@roubo/shared";

export function computeRefetchInterval(
  polling: boolean | undefined,
  connected: boolean | undefined,
): number | false {
  if (!polling) return false;
  return connected ? false : 2000;
}

export function useGitHubAuth(options?: { polling?: boolean }) {
  const query = useQuery({
    queryKey: ["github-auth-status"],
    queryFn: api.fetchGitHubAuthStatus,
    staleTime: 30_000,
    // Re-check status when the user returns to the window after completing OAuth
    refetchOnWindowFocus: true,
    // Poll every 2s while the OAuth flow is in progress
    refetchInterval: (query) =>
      computeRefetchInterval(options?.polling, query.state.data?.connected),
  });

  return {
    status: query.data as GitHubAuthStatus | undefined,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useConnectGitHub() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.fetchGitHubAuthUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });
}

export function useDisconnectGitHub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.disconnectGitHub,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-auth-status"] });
    },
  });
}
