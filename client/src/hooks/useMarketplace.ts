import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { MarketplaceKind } from "../lib/api";

// React Query hooks for the marketplace catalog (CP-FR-020 / CP-US-010, issue
// #621). The catalog query is keyed on the q/kind/sourceId params (sourceId is the
// multi-source filter chip, issue #557). Install and update stage a preview
// (returning a staging token); the confirm/cancel mutations reuse the existing
// plugin install endpoints and invalidate BOTH the marketplace catalog and the
// installed plugin list so the cards re-annotate their installed/update state.

const MARKETPLACE_KEY = "marketplace";
const PLUGINS_KEY = ["plugins"] as const;

export function marketplaceQueryKey(params: {
  q?: string;
  kind?: MarketplaceKind;
  sourceId?: string;
}): readonly [string, string, string, string] {
  return [MARKETPLACE_KEY, params.q ?? "", params.kind ?? "all", params.sourceId ?? "all"];
}

export function useMarketplaceCatalog(params: {
  q?: string;
  kind?: MarketplaceKind;
  sourceId?: string;
}) {
  return useQuery({
    queryKey: marketplaceQueryKey(params),
    queryFn: () => api.fetchMarketplaceCatalog(params),
    refetchOnWindowFocus: false,
    // The source filter chips and the offline banner both render from the
    // response, and q/kind/sourceId are all in the query key, so without this a
    // chip click (or any keystroke) empties `data` while the new query is in
    // flight and unmounts the chip row the user just pressed, taking keyboard
    // focus and the "All sources" way back with it. Holding the previous page's
    // data keeps the chips mounted across the refetch.
    placeholderData: keepPreviousData,
  });
}

// Install / update take an optional `sourceId`: the consumer's explicit
// pick-a-source choice for an id served by several sources (CPHMTP-FR-005, issue
// #558). A plain browse-and-install passes none, and the server refuses an
// ambiguous id with a 409 rather than choosing one.
export interface MarketplacePreviewVars {
  id: string;
  sourceId?: string;
}

export function useMarketplaceInstallPreview() {
  return useMutation({
    mutationFn: ({ id, sourceId }: MarketplacePreviewVars) =>
      api.installFromMarketplace(id, sourceId),
  });
}

export function useMarketplaceUpdatePreview() {
  return useMutation({
    mutationFn: ({ id, sourceId }: MarketplacePreviewVars) =>
      api.updateFromMarketplace(id, sourceId),
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

// Registering a third-party marketplace source (CPHMTP-FR-002, issue #562). The
// consent dialog's container calls this on confirm and nowhere else: the POST is
// the write that records consent (url + unsigned + registeredAt), so it must not
// run while the dialog is merely open (CPHMTP-NFR-003).
export interface RegisterMarketplaceSourceVars {
  url: string;
  credential?: string;
  // The per-source "allow http (intranet)" opt-in (Spike 551). Omitted or false
  // means a plain-http URL is refused by the server.
  allowHttp?: boolean;
}

export function useRegisterMarketplaceSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: RegisterMarketplaceSourceVars) => api.registerMarketplaceSource(vars),
    onSuccess: () => {
      // A new source changes the merged catalog and its `sources` array, so the
      // whole marketplace key tree is invalidated. The prefix also covers a
      // sources list keyed under it, so the settings list re-reads too.
      void queryClient.invalidateQueries({ queryKey: [MARKETPLACE_KEY] });
    },
  });
}
