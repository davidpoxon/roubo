import { useOutletContext } from "react-router-dom";
import { Button, Tooltip, TooltipTrigger } from "react-aria-components";
import { Plus } from "lucide-react";
import type { ProjectOutletContext } from "./BenchDashboard";
import BenchCard from "./BenchCard";
import EmptyBenchCard from "./EmptyBenchCard";
import PendingBenchCard from "./PendingBenchCard";
import Spinner from "./Spinner";
import IssueQueuePanel from "./IssueQueuePanel";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { useGlobalCap } from "../hooks/useGlobalCap";

export default function BenchesTab() {
  const {
    benchPositions,
    pendingAssignments,
    isLoading,
    openCreateBench,
    pickIssueForBench,
    hasGitHub,
    benches,
    projectConfig,
    pendingIssueExternalIds,
    initialFilters,
    onFiltersChange,
    initialGrouping,
    onGroupingChange,
    issueQueueCollapsed,
    onToggleIssueQueue,
    projectId,
  } = useOutletContext<ProjectOutletContext>();

  const { data: integration } = useProjectIntegration(projectId);
  const activeIntegrationId = integration?.plugin?.id ?? null;

  const cap = useGlobalCap();
  const atCap = cap.isAtCap || cap.isOverCap;
  const capTooltip = `Global bench limit reached. ${cap.current} of ${cap.max} benches in use. Clear a bench to free a slot.`;

  return (
    <div className="flex h-full">
      {hasGitHub && !issueQueueCollapsed && (
        <aside className="w-[340px] shrink-0 border-r border-stone-200 dark:border-stone-800/40 overflow-hidden">
          <IssueQueuePanel
            key={projectId}
            projectId={projectId}
            benches={benches}
            projectConfig={projectConfig}
            pendingIssueExternalIds={pendingIssueExternalIds}
            initialFilters={initialFilters}
            onFiltersChange={onFiltersChange}
            initialGrouping={initialGrouping}
            onGroupingChange={onGroupingChange}
            onCollapse={onToggleIssueQueue}
          />
        </aside>
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain p-8">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">Benches</h2>
            <p className="text-[12px] text-stone-400 dark:text-stone-500 mt-1">
              Active and available bench slots.
            </p>
          </div>
          {atCap ? (
            // Use aria-disabled rather than isDisabled so the button stays focusable
            // and keeps firing hover/focus events, which the tooltip needs to appear.
            // A natively disabled button (RAC isDisabled) would be skipped by the
            // keyboard and suppress the tooltip. onPress is a no-op while at cap.
            <TooltipTrigger delay={500}>
              <Button
                onPress={() => {
                  if (!atCap) openCreateBench();
                }}
                aria-disabled
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 opacity-50 cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
              >
                <Plus size={14} />
                Set up bench
              </Button>
              <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg max-w-xs">
                {capTooltip}
              </Tooltip>
            </TooltipTrigger>
          ) : (
            <Button
              onPress={openCreateBench}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none"
            >
              <Plus size={14} />
              Set up bench
            </Button>
          )}
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-stone-400 dark:text-stone-600 py-12">
            <Spinner />
            Loading...
          </div>
        )}

        {!isLoading && !benchPositions && (
          <p className="text-sm text-stone-400 dark:text-stone-600 py-12">
            No bench configuration found. Check your roubo.yaml.
          </p>
        )}

        {!isLoading && benchPositions && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {benchPositions.map(({ position, bench }) => {
              if (bench) {
                return (
                  <BenchCard
                    key={`${bench.projectId}-${bench.id}`}
                    bench={bench}
                    activeIntegrationId={activeIntegrationId}
                  />
                );
              }
              const pending = pendingAssignments.get(position);
              if (pending) {
                return (
                  <PendingBenchCard
                    key={`pending-${position}`}
                    position={position}
                    externalId={pending.externalId}
                    issueTitle={pending.issueTitle}
                  />
                );
              }
              return (
                <EmptyBenchCard
                  key={`empty-${position}`}
                  position={position}
                  onCreateBlank={openCreateBench}
                  onPickIssue={pickIssueForBench}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
