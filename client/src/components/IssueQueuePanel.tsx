import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Button, DialogTrigger } from "react-aria-components";
import { RefreshCw, X, ChevronDown, ChevronRight, ChevronLeft, PanelLeftClose } from "lucide-react";
import type { Bench, RouboConfig } from "@roubo/shared";
import DraggableIssueCard from "./DraggableIssueCard";
import Spinner from "./Spinner";
import { useIssues, useRefreshIssues } from "../hooks/useIssues";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { usePlugins, useOpportunisticRecheckOnMount } from "../hooks/usePlugins";
import { useFilterFacets, usePrefetchFacetOptions } from "../hooks/useCutListFacets";
import CutListFilterBar from "./CutListFilterBar";
import { applyFilters, createEmptyFilters, isFiltersEmpty } from "../lib/cut-list-filters";
import type { FilterState } from "../lib/cut-list-filters";
import type { FilterFacet } from "@roubo/shared";
import CutListGroupByControl from "./CutListGroupByControl";
import { groupItems, createEmptyGrouping, isGroupingActive } from "../lib/cut-list-groups";
import type { GroupingState } from "../lib/cut-list-groups";
import { formatLastUpdated, formatSnapshotAge } from "../lib/last-updated";
import GitHubErrorState from "./GitHubErrorState";
import PluginConfigureDialog from "./PluginConfigureDialog";
import StaleSnapshotBanner from "./StaleSnapshotBanner";

export default function IssueQueuePanel({
  projectId,
  benches,
  projectConfig: _projectConfig,
  pendingIssueExternalIds,
  initialFilters,
  onFiltersChange,
  initialGrouping,
  onGroupingChange,
  onCollapse,
}: {
  projectId: string;
  benches: Bench[];
  projectConfig: RouboConfig;
  pendingIssueExternalIds?: Set<string>;
  initialFilters?: FilterState;
  onFiltersChange?: (projectId: string, filters: FilterState) => void;
  initialGrouping?: GroupingState;
  onGroupingChange?: (projectId: string, grouping: GroupingState) => void;
  onCollapse?: () => void;
}) {
  // Client-retained cursor history for Prev/Next paging (FR-007/FR-008). The
  // plugin contract is forward-only (PaginatedIssues exposes nextCursor only),
  // so each entry is the opaque cursor that loads that page: index 0 is always
  // `null` (page 1), and Prev replays a retained cursor that React Query serves
  // from cache. `pageIndex` is the zero-based offset into the stack.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const activeCursor = cursorStack[pageIndex] ?? null;
  // Announced to screen readers via the polite live region on each page change.
  const [pageAnnouncement, setPageAnnouncement] = useState("");

  const {
    issues,
    isLoading: itemsLoading,
    error: itemsError,
    nextCursor,
    stalled,
    stale,
    snapshotCapturedAt,
    excludedCount,
    isRefetching,
    dataUpdatedAt,
    cacheStatus,
  } = useIssues(projectId, {}, undefined, activeCursor);
  const refreshItems = useRefreshIssues();
  // Guard the refresh control while a refetch is already in flight: disabling
  // the Button is what prevents a second concurrent refresh (FR-005 / AC5),
  // not React Query's request dedupe alone.
  const handleRefresh = useCallback(() => {
    if (isRefetching) return;
    void refreshItems();
  }, [isRefetching, refreshItems]);
  const integrationQuery = useProjectIntegration(projectId);

  // WU-050: loading the cut list triggers a fresh connection-status re-check
  // for every enabled plugin (FR-054). Disabled plugins are not invalidated.
  const pluginsQuery = usePlugins();
  const enabledPluginIds = useMemo(
    () => (pluginsQuery.data?.plugins ?? []).filter((p) => p.status === "enabled").map((p) => p.id),
    [pluginsQuery.data],
  );
  useOpportunisticRecheckOnMount(enabledPluginIds);
  const activePluginId = integrationQuery.data?.plugin?.id ?? null;
  // Display name for the FR-014 stale-snapshot banner. Sourced from the plugin
  // manifest the integration endpoint already returns; if unavailable we skip
  // the banner rather than render "from undefined".
  const activePluginName = integrationQuery.data?.plugin?.manifest?.name ?? null;
  const facetsQuery = useFilterFacets(projectId, activePluginId);
  const facets: FilterFacet[] = useMemo(() => facetsQuery.data ?? [], [facetsQuery.data]);
  // Warm the option cache for async facets so the filter popover shows options
  // immediately instead of behind a "Load options" click.
  usePrefetchFacetOptions(projectId, activePluginId, facets);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  // Only the github-com plugin has an in-dialog OAuth flow; reconnect for other
  // plugins falls back to the schema form's existing token entry.
  const reconnectPlugin =
    integrationQuery.data?.plugin?.id === "github-com" && integrationQuery.data.plugin.installed
      ? integrationQuery.data.plugin
      : null;
  const reconnectEffective = integrationQuery.data?.effective;

  const [filters, setFilters] = useState<FilterState>(() => initialFilters ?? createEmptyFilters());

  const updateFilters = useCallback(
    (newFilters: FilterState) => {
      setFilters(newFilters);
      onFiltersChange?.(projectId, newFilters);
    },
    [projectId, onFiltersChange],
  );

  const [grouping, setGroupingState] = useState<GroupingState>(
    () => initialGrouping ?? createEmptyGrouping(),
  );

  const updateGrouping = useCallback(
    (next: GroupingState) => {
      setGroupingState(next);
      onGroupingChange?.(projectId, next);
    },
    [projectId, onGroupingChange],
  );

  // Reset paging to page 1 and discard forward cursor history whenever the query
  // inputs change (project, filters, grouping/sources). Forward-only cursors are
  // only valid for the shape they were issued against, so retaining them across a
  // shape change would replay stale cursors (FR-008). A stable signature lets us
  // detect a genuine input change without firing on unrelated re-renders.
  const pagingResetSignature = useMemo(
    () =>
      JSON.stringify({ projectId, filters, grouping }, (_key, value) =>
        value instanceof Set ? [...value].sort() : value,
      ),
    [projectId, filters, grouping],
  );
  // Adjust state during render when the inputs change (React's recommended
  // alternative to a reset effect): React restarts the render with the new state
  // before committing, so the page never flashes a stale slice.
  const [lastResetSignature, setLastResetSignature] = useState(pagingResetSignature);
  if (pagingResetSignature !== lastResetSignature) {
    setLastResetSignature(pagingResetSignature);
    setCursorStack([null]);
    setPageIndex(0);
    // Announce the reset-driven jump back to page 1 (NFR-007). Without this the
    // live region would keep the stale "Page N" text and the input-change page
    // change would go unannounced.
    setPageAnnouncement("Page 1");
  }

  // Collapse state keyed by "${projectId}:${groupBy}": new project/dimension combos start expanded.
  // This state is intentionally local to this component (not hoisted to BenchDashboard like filter/grouping
  // state). Collapse layout is ephemeral: resetting it on project switch is the desired behavior.
  const [collapsedGroupsByKey, setCollapsedGroupsByKey] = useState<Map<string, Set<string>>>(
    new Map(),
  );
  const collapseStateKey = `${projectId}:${grouping.groupBy}`;
  const collapsedGroups = collapsedGroupsByKey.get(collapseStateKey) ?? new Set<string>();

  // Bench assignment is keyed on NormalizedIssue.externalId; bench state still
  // carries both a legacy issueNumber and the externalId (see WU-002).
  const assignedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const bench of benches) {
      if (bench.assignedIssue?.externalId) {
        map.set(bench.assignedIssue.externalId, bench.id);
      }
    }
    return map;
  }, [benches]);

  const baseItems = useMemo(() => {
    return issues.filter(
      (issue) =>
        !assignedMap.has(issue.externalId) && !pendingIssueExternalIds?.has(issue.externalId),
    );
  }, [issues, assignedMap, pendingIssueExternalIds]);

  // Derive option universes per facet id from the currently-loaded issues.
  // Used as the fallback option set for `enum` facets that the plugin
  // declared but didn't ship inline options for (typical for the
  // COMMON_FACET_FALLBACK set). `enum-async` facets ignore this and lazy
  // fetch instead. Includes both `facetValues[facetId]` (host-API 1.1.0+)
  // and the canonical NormalizedIssue field for the four common facets so
  // 1.0.0 plugins keep working.
  const derivedOptions = useMemo<Record<string, string[]>>(() => {
    const sets: Record<string, Set<string>> = {};
    const bump = (facetId: string, value: string | null | undefined) => {
      if (!value) return;
      (sets[facetId] ??= new Set<string>()).add(value);
    };
    for (const issue of baseItems) {
      bump("type", issue.issueType);
      for (const label of issue.labels) bump("label", label);
      for (const label of issue.labels) bump("labels", label);
      for (const a of issue.assignees) bump("assignee", a.externalId);
      bump("status", issue.currentState);
      const values = issue.facetValues ?? {};
      for (const [id, val] of Object.entries(values)) {
        if (Array.isArray(val)) for (const v of val) bump(id, v);
        else bump(id, val);
      }
    }
    const out: Record<string, string[]> = {};
    for (const [id, set] of Object.entries(sets)) {
      out[id] = [...set].sort();
    }
    return out;
  }, [baseItems]);

  const filteredItems = useMemo(() => applyFilters(baseItems, filters), [baseItems, filters]);

  const groups = useMemo(() => {
    if (!isGroupingActive(grouping)) return [];
    // Resolve the facet backing the active dimension. If it's no longer exposed
    // (e.g. plugin switched), skip grouping rather than render a dangling group.
    const groupFacet = facets.find((f) => f.id === grouping.groupBy);
    if (!groupFacet) return [];
    return groupItems(filteredItems, grouping.groupBy, groupFacet.label);
  }, [filteredItems, grouping, facets]);

  // Prev/Next paging (FR-007/FR-008). Next pushes the current page's nextCursor
  // onto the stack and advances; Prev steps back to a retained cursor that React
  // Query serves from cache (NFR-004). Total page count is unknowable with
  // forward-only cursors, so the last page is inferred from nextCursor === null.
  const hasPrev = pageIndex > 0;
  const hasNext = nextCursor !== null;
  const pageNumber = pageIndex + 1;

  const goPrev = useCallback(() => {
    setPageIndex((prev) => {
      if (prev === 0) return prev;
      const next = prev - 1;
      setPageAnnouncement(`Page ${next + 1}`);
      return next;
    });
  }, []);

  const goNext = useCallback(() => {
    if (nextCursor === null) return;
    setCursorStack((stack) => {
      // Truncate any forward history and append this page's nextCursor so Prev
      // can replay the page we are leaving.
      const trimmed = stack.slice(0, pageIndex + 1);
      return [...trimmed, nextCursor];
    });
    setPageIndex((prev) => {
      const next = prev + 1;
      setPageAnnouncement(`Page ${next + 1}`);
      return next;
    });
  }, [nextCursor, pageIndex]);

  // Last-updated indicator (FR-006). The stale path (cached snapshot, plugin
  // unavailable) is worded and coloured distinctly from the warm path so a
  // frozen snapshot never reads as a fresh update (AC3). While a refresh is in
  // flight the indicator reads "refreshing..." instead of a timestamp (AC1).
  const lastUpdatedLabel = useMemo(() => {
    if (isRefetching) return "refreshing...";
    if (stale) {
      const captured = snapshotCapturedAt ? Date.parse(snapshotCapturedAt) : NaN;
      return Number.isNaN(captured) ? "stale snapshot" : formatSnapshotAge(captured);
    }
    return formatLastUpdated(dataUpdatedAt);
  }, [isRefetching, stale, snapshotCapturedAt, dataUpdatedAt]);

  // Stale-while-revalidate cache-state badge (CLI-FR-002 / CLI-TC-001). Distinct
  // from the FR-014 stale-snapshot banner below: this is the inline warm /
  // revalidating / stale chip. Precedence: the FR-014 stale serve (plugin
  // unavailable) wins; then a background revalidation in flight (React Query's
  // isRefetching) reads `revalidating`; then a warm snapshot served by the
  // server (`cacheStatus === 'revalidating'`) reads `warm`. A genuinely fresh
  // live load (`cacheStatus === 'miss'`) shows no chip (null) so the badge never
  // competes with the steady state. Per CLI-TC-001 the warm open shows `warm`
  // first, transitions to `revalidating` while the client refetches, then back
  // to `warm` once fresh data lands.
  const cacheState: "warm" | "revalidating" | "stale" | null = useMemo(() => {
    if (stale) return "stale";
    if (isRefetching) return "revalidating";
    if (cacheStatus === "revalidating") return "warm";
    return null;
  }, [stale, isRefetching, cacheStatus]);

  // Polite live-region announcement for refresh start/completion (NFR-007 /
  // AC4). Announce "Refreshing cut list" when a refetch begins, then on
  // completion announce success or, when the refetch errored, a failure (a
  // failed refetch settles isRefetching to false the same way a success does,
  // so the completion message is gated on itemsError rather than reading "Cut
  // list updated" when nothing updated). Stay silent before the first refresh.
  const [refreshAnnouncement, setRefreshAnnouncement] = useState("");
  const wasRefetchingRef = useRef(false);
  useEffect(() => {
    if (isRefetching && !wasRefetchingRef.current) {
      setRefreshAnnouncement("Refreshing cut list");
    } else if (!isRefetching && wasRefetchingRef.current) {
      setRefreshAnnouncement(itemsError ? "Cut list refresh failed" : "Cut list updated");
    }
    wasRefetchingRef.current = isRefetching;
  }, [isRefetching, itemsError]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stone-200 dark:border-stone-800/60">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
              Cut List
            </h3>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {cacheState && (
              <span
                data-testid="cut-list-cache-state"
                data-state={cacheState}
                className={`text-[10px] font-medium uppercase tracking-wide whitespace-nowrap ${
                  cacheState === "stale"
                    ? "text-amber-600 dark:text-amber-400"
                    : cacheState === "revalidating"
                      ? "text-stone-400 dark:text-stone-600"
                      : "text-green-600 dark:text-green-500"
                }`}
              >
                {cacheState}
              </span>
            )}
            {lastUpdatedLabel && (
              <span
                data-testid="cut-list-last-updated"
                data-state={stale ? "stale" : "fresh"}
                className={`text-[10px] font-mono whitespace-nowrap ${
                  stale
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-stone-400 dark:text-stone-600"
                }`}
              >
                {lastUpdatedLabel}
              </span>
            )}
            <Button
              onPress={handleRefresh}
              isDisabled={isRefetching}
              className="p-1.5 rounded-md text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none disabled:opacity-60 disabled:cursor-default"
              aria-label="Refresh cut list"
            >
              <RefreshCw size={13} className={isRefetching ? "animate-spin" : undefined} />
            </Button>
            {onCollapse && (
              <Button
                onPress={onCollapse}
                className="p-1.5 rounded-md text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none"
                aria-label="Hide cut list"
              >
                <PanelLeftClose size={14} />
              </Button>
            )}
          </div>
        </div>
        {/* Polite live region announcing refresh start/completion (NFR-007). */}
        <div
          role="status"
          aria-live="polite"
          data-testid="cut-list-refresh-status"
          className="sr-only"
        >
          {refreshAnnouncement}
        </div>
      </div>

      {/* Filter bar */}
      {!itemsLoading && !itemsError && (
        <div className="flex items-center border-b border-stone-200 dark:border-stone-800/60">
          <div className="flex-1 min-w-0">
            <CutListFilterBar
              filters={filters}
              onFiltersChange={updateFilters}
              facets={facets}
              projectId={projectId}
              pluginId={activePluginId}
              derivedOptions={derivedOptions}
            />
          </div>
          <div className="flex items-center gap-1 pr-2 shrink-0">
            <CutListGroupByControl
              grouping={grouping}
              onGroupingChange={updateGrouping}
              facets={facets}
            />
            {!isFiltersEmpty(filters) && (
              <>
                <span className="text-[11px] font-mono text-stone-500 dark:text-stone-600 whitespace-nowrap">
                  {filteredItems.length}/{baseItems.length}
                </span>
                <Button
                  onPress={() => updateFilters(createEmptyFilters())}
                  aria-label="Clear all filters"
                  className="p-1 rounded-md text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none"
                >
                  <X size={12} />
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {stale && activePluginName && <StaleSnapshotBanner pluginName={activePluginName} />}

      {stalled && (
        <div
          data-testid="stalled-note"
          className="mx-3 mt-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 text-[11px] text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60"
        >
          Plugin paging appears stuck. Try a refresh.
        </div>
      )}

      {excludedCount > 0 && (
        <div
          role="status"
          data-testid="excluded-count-note"
          className="mx-3 mt-2 px-3 py-2 rounded-md bg-stone-100 dark:bg-stone-800/40 text-[11px] text-stone-600 dark:text-stone-400 border border-stone-200 dark:border-stone-700/60"
        >
          {excludedCount} filtered out by status
        </div>
      )}

      {/* Cut list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {/* Error state */}
        {itemsError && (
          <GitHubErrorState
            error={itemsError}
            variant="banner"
            onRetry={refreshItems}
            onReconnect={reconnectPlugin ? () => setReconnectOpen(true) : undefined}
            className="mx-2 mb-2"
          />
        )}

        {reconnectPlugin && reconnectEffective && (
          <DialogTrigger isOpen={reconnectOpen} onOpenChange={setReconnectOpen}>
            {/* DialogTrigger requires a trigger child; render a hidden button
                since the open state is controlled by GitHubErrorState. */}
            <Button className="sr-only" aria-hidden excludeFromTabOrder>
              Open reconnect dialog
            </Button>
            <PluginConfigureDialog
              scope="project"
              projectId={projectId}
              plugin={reconnectPlugin}
              effective={reconnectEffective}
            />
          </DialogTrigger>
        )}

        {/* Loading */}
        {itemsLoading && (
          <div className="flex items-center justify-center py-8">
            <Spinner />
            <span className="ml-2 text-xs text-stone-600">Loading...</span>
          </div>
        )}

        {/* Cut list */}
        {!itemsLoading && !itemsError && (
          <div className="space-y-0.5">
            {filteredItems.length > 0 ? (
              groups.length > 0 ? (
                groups.map((group) => {
                  const isCollapsed = collapsedGroups.has(group.key);
                  return (
                    <div key={group.key}>
                      <Button
                        onPress={() =>
                          setCollapsedGroupsByKey((prev) => {
                            const existing = prev.get(collapseStateKey) ?? new Set<string>();
                            const next = new Set(existing);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return new Map(prev).set(collapseStateKey, next);
                          })
                        }
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-400 transition-colors outline-none"
                      >
                        {isCollapsed ? (
                          <ChevronRight size={11} className="shrink-0" />
                        ) : (
                          <ChevronDown size={11} className="shrink-0" />
                        )}
                        <span className="truncate">{group.label}</span>
                        <span className="font-mono text-[10px] text-stone-400 dark:text-stone-600 ml-auto shrink-0">
                          {group.items.length}
                        </span>
                      </Button>
                      {!isCollapsed && (
                        <div className="space-y-0.5">
                          {group.items.map((issue) => (
                            <DraggableIssueCard
                              key={`${group.key}-${issue.externalId}`}
                              issue={issue}
                              assignedBenchId={assignedMap.get(issue.externalId)}
                              dragIdSuffix={group.key}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                filteredItems.map((issue) => (
                  <DraggableIssueCard
                    key={issue.externalId}
                    issue={issue}
                    assignedBenchId={assignedMap.get(issue.externalId)}
                  />
                ))
              )
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center px-4">
                <p className="text-xs text-stone-500 dark:text-stone-600 mb-2">
                  {baseItems.length > 0
                    ? "No cuts match the active filters"
                    : "No open cuts available"}
                </p>
                {baseItems.length > 0 && (
                  <Button
                    onPress={() => updateFilters(createEmptyFilters())}
                    className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none"
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pagination footer (FR-007/FR-008). Hidden while loading, on error, or
          when there is genuinely nothing to page (no items on this page AND no
          prior/next page, TC-027). When the current page's items are all filtered
          out client-side but another page exists (hasNext) or we paged in from a
          prior page (hasPrev), the pager stays so Next/Prev remain reachable. */}
      {!itemsLoading && !itemsError && (filteredItems.length > 0 || hasPrev || hasNext) && (
        <div
          data-testid="cut-list-pager"
          className="flex items-center justify-between gap-2 px-3 py-2 border-t border-stone-200 dark:border-stone-800/60"
        >
          <Button
            onPress={goPrev}
            isDisabled={!hasPrev}
            aria-label="Previous page"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-stone-600 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40 disabled:pointer-events-none"
          >
            <ChevronLeft size={13} />
            Prev
          </Button>
          <span
            data-testid="cut-list-page-indicator"
            className="text-[11px] font-mono text-stone-500 dark:text-stone-600 whitespace-nowrap"
          >
            Page {pageNumber} &middot; {filteredItems.length} item
            {filteredItems.length === 1 ? "" : "s"}
          </span>
          <Button
            onPress={goNext}
            isDisabled={!hasNext}
            aria-label="Next page"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-stone-600 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40 disabled:pointer-events-none"
          >
            Next
            <ChevronRight size={13} />
          </Button>
        </div>
      )}

      {/* Polite live region announcing page changes to screen readers (NFR-007). */}
      <div aria-live="polite" className="sr-only" data-testid="cut-list-page-live">
        {pageAnnouncement}
      </div>
    </div>
  );
}
