import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Button } from "react-aria-components";
import { RefreshCw, X, ChevronDown, ChevronRight, PanelLeftClose } from "lucide-react";
import type { Bench, RouboConfig } from "@roubo/shared";
import DraggableIssueCard from "./DraggableIssueCard";
import Spinner from "./Spinner";
import { useIssues, useRefreshIssues } from "../hooks/useIssues";
import CutListFilterBar from "./CutListFilterBar";
import { applyFilters, createEmptyFilters, isFiltersEmpty } from "../lib/cut-list-filters";
import type { FilterState } from "../lib/cut-list-filters";
import CutListGroupByControl from "./CutListGroupByControl";
import { groupItems, createEmptyGrouping, isGroupingActive } from "../lib/cut-list-groups";
import type { GroupingState } from "../lib/cut-list-groups";
import GitHubErrorState from "./GitHubErrorState";

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
  const {
    issues,
    isLoading: itemsLoading,
    error: itemsError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    stalled,
  } = useIssues(projectId);
  const refreshItems = useRefreshIssues();

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

  // Collapse state keyed by "${projectId}:${groupBy}" — new project/dimension combos start expanded.
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

  const availableTypes = useMemo(() => {
    const set = new Set<string>();
    for (const issue of baseItems) {
      if (issue.issueType) set.add(issue.issueType);
    }
    return [...set].sort();
  }, [baseItems]);

  const availableLabels = useMemo(() => {
    const set = new Set<string>();
    for (const issue of baseItems) {
      for (const label of issue.labels) set.add(label);
    }
    return [...set].sort();
  }, [baseItems]);

  const filteredItems = useMemo(() => applyFilters(baseItems, filters), [baseItems, filters]);

  const groups = useMemo(
    () => (isGroupingActive(grouping) ? groupItems(filteredItems, grouping.groupBy) : []),
    [filteredItems, grouping],
  );

  // Auto-fetch next page when the sentinel scrolls into view (FR-022, NFR-005).
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            fetchNextPage();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              onPress={refreshItems}
              className="p-1.5 rounded-md text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none"
              aria-label="Refresh cut list"
            >
              <RefreshCw size={13} />
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
      </div>

      {/* Filter bar */}
      {!itemsLoading && !itemsError && (
        <div className="flex items-center border-b border-stone-200 dark:border-stone-800/60">
          <div className="flex-1 min-w-0">
            <CutListFilterBar
              filters={filters}
              onFiltersChange={updateFilters}
              availableTypes={availableTypes}
              availableLabels={availableLabels}
            />
          </div>
          <CutListGroupByControl grouping={grouping} onGroupingChange={updateGrouping} />
          {!isFiltersEmpty(filters) && (
            <div className="flex items-center gap-1 pr-2 shrink-0">
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
            </div>
          )}
        </div>
      )}

      {stalled && (
        <div
          data-testid="stalled-note"
          className="mx-3 mt-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 text-[11px] text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60"
        >
          Plugin paging appears stuck. Try a refresh.
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
            className="mx-2 mb-2"
          />
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
            {hasNextPage && (
              <div
                ref={sentinelRef}
                data-testid="queue-load-more-sentinel"
                className="flex items-center justify-center py-4"
              >
                {isFetchingNextPage && <Spinner />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
