import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { SourceCandidateItem, SourceOptionsResult } from "@roubo/shared";
import * as api from "../lib/api";

export type SourceOptionCategory = "project" | "board" | "filter" | "epic";

export interface UseSourceOptionsArgs {
  projectId: string | undefined;
  category: SourceOptionCategory;
  // Parent selection. Board / filter / epic searches are confined to these
  // Jira project keys; project search ignores it.
  scope?: { project?: string[] };
  // User-typed term; debounced internally before it reaches the network.
  search?: string;
  // The picker gates scoped categories until a project is selected; pass
  // `enabled: false` to hold the query until then.
  enabled?: boolean;
}

export interface UseSourceOptionsResult {
  items: SourceCandidateItem[];
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  error: Error | null;
  // Measured round-trip latency (ms) of the most recently fetched page, or
  // null before any page has resolved. Backs the NFR-001 budget visibly (#432).
  durationMs: number | null;
}

// One page plus the client-measured round-trip latency that produced it.
interface SourceOptionsPage extends SourceOptionsResult {
  durationMs: number;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Paginated, debounced type-ahead source search (WU-002). Wraps
 * `fetchSourceOptions` in an infinite query keyed by the debounced search term
 * and scope, so a superseded slow response resolves into an inactive cache
 * entry and never flickers over the latest results (NFR-001 / NFR-004).
 */
export function useSourceOptions({
  projectId,
  category,
  scope,
  search,
  enabled = true,
}: UseSourceOptionsArgs): UseSourceOptionsResult {
  // Initialise from `search` so an existing term queries immediately on mount;
  // later keystrokes are debounced via the effect below.
  const [debouncedSearch, setDebouncedSearch] = useState(search ?? "");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search ?? ""), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  // Stable, order-independent scope key so reordering selected projects does
  // not thrash the cache.
  const scopeKey = scope?.project ? [...scope.project].sort() : [];

  const query = useInfiniteQuery<SourceOptionsPage, Error>({
    queryKey: ["source-options", projectId ?? null, category, scopeKey, debouncedSearch],
    enabled: enabled && !!projectId,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const start = performance.now();
      const page = await api.fetchSourceOptions(projectId as string, {
        category,
        scope,
        search: debouncedSearch,
        cursor: pageParam as string | null,
      });
      return { ...page, durationMs: Math.round(performance.now() - start) };
    },
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const pages = query.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  // Surface the latency of the page fetched most recently (the latest query, or
  // the just-loaded "Load more" page) so the readout tracks the current query.
  const durationMs = pages.length > 0 ? pages[pages.length - 1].durationMs : null;

  return {
    items,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    error: query.error,
    durationMs,
  };
}
