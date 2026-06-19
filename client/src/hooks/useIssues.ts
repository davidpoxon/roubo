import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NormalizedIssue, PaginatedIssues } from "@roubo/shared";
import * as api from "../lib/api";

export interface UseIssuesFilters {
  labels?: string;
  search?: string;
}

export interface UseIssuesResult {
  issues: NormalizedIssue[];
  isLoading: boolean;
  /** The opaque cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
  error: Error | null;
  /** True when the retrieved page reported `stalled` (TC-071). */
  stalled: boolean;
  /**
   * True when the response was served from the issue-snapshot cache because
   * the active plugin is `errored` or `disabled` (FR-014 / TC-016). Surface
   * the cut-list stale banner whenever this is true.
   */
  stale: boolean;
  /** ISO timestamp of the cached snapshot when `stale` is true, else null. */
  snapshotCapturedAt: string | null;
  /**
   * Issues the active plugin dropped in-query on this page (status-category
   * exclusion, FR-009/FR-010), or 0 when the page reported no count. Drives the
   * cut list's "N filtered out by status" banner.
   */
  excludedCount: number;
  /**
   * React Query's native `isRefetching`: true while a background refetch of
   * already-loaded data is in flight (FR-005). Drives the refresh control's
   * spinning in-progress state and guards against a second concurrent refresh.
   */
  isRefetching: boolean;
  /**
   * React Query's native `dataUpdatedAt`: epoch ms of the last successful
   * fetch, advancing on each successful refresh (FR-006). Drives the
   * last-updated indicator. 0 before the first successful fetch.
   */
  dataUpdatedAt: number;
}

/**
 * Fetch a single page of the active plugin's paginated `listIssues` via React
 * Query, keyed on the supplied opaque `cursor` (FR-007). The plugin contract is
 * forward-only (`PaginatedIssues` exposes `nextCursor` only), so Prev/Next paging
 * is driven by the caller retaining prior cursors and replaying them through this
 * hook; React Query then serves a revisited page from cache.
 *
 * Default page size is governed by the server (project's integration config,
 * fallback 50); callers can override per query via `pageSize`.
 */
export function useIssues(
  projectId: string | undefined,
  filters: UseIssuesFilters = {},
  pageSize?: number,
  cursor: string | null = null,
): UseIssuesResult {
  const query = useQuery<PaginatedIssues, Error>({
    queryKey: ["issues", projectId, filters, pageSize ?? null, cursor],
    enabled: !!projectId,
    queryFn: () =>
      api.fetchIssuesPage(projectId as string, {
        cursor,
        pageSize,
        labels: filters.labels,
        search: filters.search,
      }),
    staleTime: 30_000,
    retry: false,
  });

  const page = query.data;
  // The host dedupes within a single response page, so no cross-page backstop is
  // needed here: this hook only ever holds one page at a time.
  const issues = page?.items ?? [];
  const stalled = page?.stalled === true;
  const stale = page?.stale === true;
  const snapshotCapturedAt = (stale ? page?.snapshotCapturedAt : undefined) ?? null;
  const excludedCount = page?.excludedCount ?? 0;

  return {
    issues,
    isLoading: query.isLoading,
    nextCursor: page?.nextCursor ?? null,
    error: query.error,
    stalled,
    stale,
    snapshotCapturedAt,
    excludedCount,
    isRefetching: query.isRefetching,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}

export function useRefreshIssues() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["issues"] });
}
