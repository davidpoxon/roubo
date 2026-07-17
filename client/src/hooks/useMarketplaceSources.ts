import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

// React Query hooks for the third-party marketplace source registry
// (CPHMTP-FR-001 / CPHMTP-US-001, issue #561). The list query backs the
// Marketplaces settings section; remove invalidates BOTH the source list and the
// merged catalog, because dropping a source changes which listings the Browse
// screen shows.
//
// Registration lives in useMarketplace.ts as `useRegisterMarketplaceSource`
// (issue #562), next to the consent dialog that is its only caller. It is not
// restated here: one POST /marketplace/sources deserves one mutation hook.

const MARKETPLACE_SOURCES_KEY = ["marketplace-sources"] as const;
const MARKETPLACE_KEY = ["marketplace"] as const;

export function marketplaceSourcesQueryKey(): readonly ["marketplace-sources"] {
  return MARKETPLACE_SOURCES_KEY;
}

export function useMarketplaceSources() {
  return useQuery({
    queryKey: MARKETPLACE_SOURCES_KEY,
    queryFn: () => api.fetchMarketplaceSources(),
    refetchOnWindowFocus: false,
  });
}

export function useRemoveMarketplaceSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.removeMarketplaceSource(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MARKETPLACE_SOURCES_KEY });
      void queryClient.invalidateQueries({ queryKey: MARKETPLACE_KEY });
    },
  });
}
