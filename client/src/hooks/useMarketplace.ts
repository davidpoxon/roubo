import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { MarketplaceKind } from "../lib/api";

// React Query hooks for the marketplace catalog (CP-FR-020 / CP-US-010, issue
// #621). The catalog query is keyed on the q/kind params. Install and update
// stage a preview (returning a staging token); the confirm/cancel mutations
// reuse the existing plugin install endpoints and invalidate BOTH the
// marketplace catalog and the installed plugin list so the cards re-annotate
// their installed/update state.

const MARKETPLACE_KEY = "marketplace";
const PLUGINS_KEY = ["plugins"] as const;

export function marketplaceQueryKey(params: {
  q?: string;
  kind?: MarketplaceKind;
}): readonly [string, string, string] {
  return [MARKETPLACE_KEY, params.q ?? "", params.kind ?? "all"];
}

export function useMarketplaceCatalog(params: { q?: string; kind?: MarketplaceKind }) {
  return useQuery({
    queryKey: marketplaceQueryKey(params),
    queryFn: () => api.fetchMarketplaceCatalog(params),
    refetchOnWindowFocus: false,
  });
}

export function useMarketplaceInstallPreview() {
  return useMutation({
    mutationFn: (id: string) => api.installFromMarketplace(id),
  });
}

export function useMarketplaceUpdatePreview() {
  return useMutation({
    mutationFn: (id: string) => api.updateFromMarketplace(id),
  });
}

export function useMarketplaceInstallConfirm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stagingToken: string) => api.confirmInstallPlugin(stagingToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MARKETPLACE_KEY] });
      void queryClient.invalidateQueries({ queryKey: PLUGINS_KEY });
    },
  });
}

export function useMarketplaceInstallCancel() {
  return useMutation({
    mutationFn: (stagingToken: string) => api.cancelInstallPlugin(stagingToken),
  });
}
