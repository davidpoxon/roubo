import { useMemo, useState, useCallback } from "react";
import { Button } from "react-aria-components";
import {
  RefreshCw,
  ExternalLink,
  X,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
} from "lucide-react";
import type { Bench, RouboConfig } from "@roubo/shared";
import DraggableIssueCard from "./DraggableIssueCard";
import Spinner from "./Spinner";
import { useProjectItems, useRefreshProjectItems } from "../hooks/useProjectItems";
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
  projectConfig,
  pendingIssueNumbers,
  initialFilters,
  onFiltersChange,
  initialGrouping,
  onGroupingChange,
  onCollapse,
}: {
  projectId: string;
  benches: Bench[];
  projectConfig: RouboConfig;
  pendingIssueNumbers?: Set<number>;
  initialFilters?: FilterState;
  onFiltersChange?: (projectId: string, filters: FilterState) => void;
  initialGrouping?: GroupingState;
  onGroupingChange?: (projectId: string, grouping: GroupingState) => void;
  onCollapse?: () => void;
}) {
  const repo = projectConfig.project.repo;
  const configuredProject = projectConfig.project.github?.project;

  const {
    data: projectData,
    isLoading: itemsLoading,
    error: itemsError,
  } = useProjectItems(projectId, configuredProject);
  const refreshItems = useRefreshProjectItems();

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

  // Map issue numbers to assigned bench IDs
  const assignedMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const bench of benches) {
      if (bench.assignedIssue) {
        map.set(bench.assignedIssue.number, bench.id);
      }
    }
    return map;
  }, [benches]);

  // Exclude issues already assigned to benches or pending
  const baseItems = useMemo(() => {
    if (!projectData?.items) return [];
    return projectData.items.filter(
      (item) => !assignedMap.has(item.issue.number) && !pendingIssueNumbers?.has(item.issue.number),
    );
  }, [projectData, assignedMap, pendingIssueNumbers]);

  // Compute available filter options from the base pool
  const availableMilestones = useMemo(() => {
    const set = new Set<string>();
    for (const item of baseItems) {
      if (item.issue.milestone) set.add(item.issue.milestone);
    }
    return [...set].sort();
  }, [baseItems]);

  const availableTypes = useMemo(() => {
    const set = new Set<string>();
    for (const item of baseItems) {
      if (item.issue.type) set.add(item.issue.type);
    }
    return [...set].sort();
  }, [baseItems]);

  const availableLabels = useMemo(() => {
    const set = new Set<string>();
    for (const item of baseItems) {
      for (const label of item.issue.labels) set.add(label);
    }
    return [...set].sort();
  }, [baseItems]);

  // Apply user filters on top of base items
  const filteredItems = useMemo(() => applyFilters(baseItems, filters), [baseItems, filters]);

  const groups = useMemo(
    () => (isGroupingActive(grouping) ? groupItems(filteredItems, grouping.groupBy) : []),
    [filteredItems, grouping],
  );

  const projectTitle = projectData?.projectTitle;

  // No GitHub project configured
  if (!configuredProject) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 py-3 border-b border-stone-200 dark:border-stone-800/60">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
              Cut List
            </h3>
            {onCollapse && (
              <Button
                onPress={onCollapse}
                className="p-1.5 rounded-md text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none shrink-0"
                aria-label="Hide cut list"
              >
                <PanelLeftClose size={14} />
              </Button>
            )}
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <p className="text-sm text-stone-500 dark:text-stone-600 mb-2">
            No GitHub project configured
          </p>
          <p className="text-xs text-stone-500 dark:text-stone-700">
            Add a <code className="text-stone-500 font-mono text-[11px]">github.project</code> field
            to your roubo.yaml config.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stone-200 dark:border-stone-800/60">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
              Cut List
            </h3>
            {projectTitle && (
              <p className="text-[11px] text-stone-400 dark:text-stone-600 truncate mt-0.5">
                {projectTitle}
              </p>
            )}
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
      {!itemsLoading && !itemsError && projectData && (
        <div className="flex items-center border-b border-stone-200 dark:border-stone-800/60">
          <div className="flex-1 min-w-0">
            <CutListFilterBar
              filters={filters}
              onFiltersChange={updateFilters}
              availableMilestones={availableMilestones}
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
        {!itemsLoading && !itemsError && projectData && (
          <div className="space-y-0.5">
            {filteredItems.length > 0 ? (
              groups.length > 0 ? (
                // Grouped view: collapsible sections per group
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
                          {group.items.map((item) => (
                            <DraggableIssueCard
                              key={`${group.key}-${item.issue.number}`}
                              item={item}
                              assignedBenchId={assignedMap.get(item.issue.number)}
                              dragIdSuffix={group.key}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                // Flat view (no grouping)
                filteredItems.map((item) => (
                  <DraggableIssueCard
                    key={item.issue.number}
                    item={item}
                    assignedBenchId={assignedMap.get(item.issue.number)}
                  />
                ))
              )
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center px-4">
                <p className="text-xs text-stone-500 dark:text-stone-600 mb-2">
                  {baseItems.length > 0
                    ? "No cuts match the active filters"
                    : "No open cuts in this project"}
                </p>
                {baseItems.length > 0 && (
                  <Button
                    onPress={() => updateFilters(createEmptyFilters())}
                    className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none"
                  >
                    Clear filters
                  </Button>
                )}
                {baseItems.length === 0 && repo && (
                  <a
                    href={`https://github.com/${repo}/issues/new`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
                  >
                    Create one on GitHub
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
