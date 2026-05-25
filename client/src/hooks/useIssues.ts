import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListIssuesWarning, NormalizedIssue, PaginatedIssues } from "@roubo/shared";
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
  };
}

export function useRefreshIssues() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["issues"] });
}

/**
 * Project-scoped per-source per-category warnings emitted on the most recent
 * `listIssues` page-1 pull. Alerts only fetch on page 1, so page 1 is the
 * authoritative health signal. A category that is no longer in the warnings
 * array after the next pull is implicitly cleared (AC #7).
 *
 * Lives on its own React Query key so the Configure dialog can subscribe
 * independent of the issue list, while still using the same underlying
 * fetch surface. Stale-time matches the issues hook so the dialog reflects
 * the same cadence the cut list sees.
 */
export function useIssueListWarnings(projectId: string | undefined): ListIssuesWarning[] {
  const query = useQuery<ListIssuesWarning[]>({
    queryKey: ["integration-warnings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const firstPage = await api.fetchIssuesPage(projectId as string, { cursor: null });
      return firstPage.warnings ?? [];
    },
    staleTime: 30_000,
    retry: false,
  });
  return query.data ?? [];
}
