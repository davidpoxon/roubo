import { useOutletContext } from "react-router";
import { Button, Tooltip, TooltipTrigger } from "react-aria-components";
import { Plus } from "lucide-react";
import type { ProjectOutletContext } from "./BenchDashboard";
import BenchCard from "./BenchCard";
import EmptyBenchCard from "./EmptyBenchCard";
import PendingBenchCard from "./PendingBenchCard";
import Spinner from "./Spinner";
import IssueQueuePanel from "./IssueQueuePanel";
import GlobalBenchMeter from "./GlobalBenchMeter";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { useGlobalCap } from "../hooks/useGlobalCap";

export default function BenchesTab() {
  const {
    benchPositions,
    pendingAssignments,
    isLoading,
    openCreateBench,
    pickIssueForBench,
    testBenchEnabled,
    onCreateTestBench,
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
        <aside className="w-[340px] shrink-0 border-r border-border overflow-hidden">
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
            <h2 className="text-20 font-semibold text-text-primary">Benches</h2>
            <p className="text-12 text-text-secondary mt-1">Active and available bench slots.</p>
          </div>
          <div className="flex items-center gap-4">
            <GlobalBenchMeter />
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
                  className="flex items-center gap-1.5 px-3 py-1.5 text-12 font-medium text-on-accent bg-accent opacity-40 cursor-not-allowed rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base not-disabled:active:bg-accent-active"
                >
                  <Plus size={14} />
                  Set up bench
                </Button>
                <Tooltip className="bg-bg-inverse text-text-on-inverse text-12 px-3 py-1.5 rounded-control shadow-elevation-0 max-w-xs">
                  {capTooltip}
                </Tooltip>
              </TooltipTrigger>
            ) : (
              <Button
                onPress={openCreateBench}
                className="flex items-center gap-1.5 px-3 py-1.5 text-12 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover rounded-control transition-colors outline-none not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <Plus size={14} />
                Set up bench
              </Button>
            )}
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-13 text-text-secondary py-12">
            <Spinner />
            Loading...
          </div>
        )}

        {!isLoading && !benchPositions && (
          <p className="text-13 text-text-secondary py-12">
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
                  testBenchEnabled={testBenchEnabled}
                  onCreateTestBench={onCreateTestBench}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
