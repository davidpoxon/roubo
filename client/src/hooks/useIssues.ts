import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { NormalizedIssue, PaginatedIssues } from "@roubo/shared";
import * as api from "../lib/api";

export interface UseIssuesFilters {
  labels?: string;
  search?: string;
}

export interface UseIssuesResult {
  issues: NormalizedIssue[];
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  error: Error | null;
  /** True when any retrieved page reported `stalled` (TC-071). */
  stalled: boolean;
  /**
   * True when the response was served from the issue-snapshot cache because
   * the active plugin is `errored` or `disabled` (FR-014 / TC-016). Surface
   * the cut-list stale banner whenever this is true.
   */
  stale: boolean;
  /** ISO timestamp of the cached snapshot when `stale` is true, else null. */
  snapshotCapturedAt: string | null;
}

/**
 * Walk the active plugin's paginated `listIssues` via React Query.
 * Default page size is governed by the server (project's integration config,
 * fallback 50); callers can override per query via `pageSize`.
 */
export function useIssues(
  projectId: string | undefined,
  filters: UseIssuesFilters = {},
  pageSize?: number,
): UseIssuesResult {
  const query = useInfiniteQuery<PaginatedIssues, Error>({
    queryKey: ["issues", projectId, filters, pageSize ?? null],
    enabled: !!projectId,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.fetchIssuesPage(projectId as string, {
        cursor: pageParam as string | null,
        pageSize,
        labels: filters.labels,
        search: filters.search,
      }),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
    retry: false,
  });

  const pages = query.data?.pages ?? [];
  const issues = pages.flatMap((p) => p.items);
  const stalled = pages.some((p) => p.stalled === true);
  // The cache only ever serves the first page, so the stale marker (if present)
  // lives on pages[0]. Iterating defensively in case the server ever extends
  // the contract to mark additional pages.
  const stalePage = pages.find((p) => p.stale === true);
  const stale = stalePage !== undefined;
  const snapshotCapturedAt = stalePage?.snapshotCapturedAt ?? null;

  return {
    issues,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    error: query.error,
    stalled,
    stale,
    snapshotCapturedAt,
  };
}

export function useRefreshIssues() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["issues"] });
}
