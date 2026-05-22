import { Button } from "react-aria-components";
import { useDraggable } from "@dnd-kit/core";
import { ExternalLink, Lock, Tag } from "lucide-react";
import type { NormalizedIssue } from "@roubo/shared";

export default function DraggableIssueCard({
  issue,
  assignedBenchId,
  dragIdSuffix,
}: {
  issue: NormalizedIssue;
  assignedBenchId?: number;
  /** Optional suffix to make the drag ID unique when the same card appears in multiple groups (e.g. label grouping). */
  dragIdSuffix?: string;
}) {
  const isAssigned = assignedBenchId !== undefined;
  const blockers = issue.blockedBy;
  const isBlocked = blockers.length > 0;
  const dragId = dragIdSuffix
    ? `issue-${issue.externalId}-${dragIdSuffix}`
    : `issue-${issue.externalId}`;
  const blockedDescriptionId = `blocked-by-${dragId}`;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: { issue },
    disabled: isAssigned || isBlocked,
  });

  const isInteractive = !isAssigned && !isBlocked;
  const primaryAssignee = issue.assignees[0]?.displayName;

  return (
    <div
      ref={setNodeRef}
      {...(isInteractive ? listeners : {})}
      {...(isInteractive ? attributes : {})}
      aria-disabled={isBlocked || undefined}
      aria-describedby={isBlocked ? blockedDescriptionId : undefined}
      className={`group relative rounded-lg transition-colors ${
        isDragging
          ? "opacity-40 bg-stone-100 dark:bg-stone-900/50"
          : isBlocked
            ? "opacity-50 bg-stone-50 dark:bg-stone-900/20 cursor-not-allowed"
            : isAssigned
              ? "bg-stone-50 dark:bg-stone-900/30"
              : "bg-stone-100 dark:bg-stone-900/50 hover:bg-stone-200 dark:hover:bg-stone-900/80 cursor-grab active:cursor-grabbing"
      }`}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`text-[11px] font-mono shrink-0 ${isAssigned ? "text-stone-300 dark:text-stone-700" : "text-stone-400 dark:text-stone-600"}`}
            >
              {issue.externalId}
            </span>
            <span
              className={`text-xs font-medium truncate ${isAssigned ? "text-stone-400 dark:text-stone-600" : "text-stone-800 dark:text-stone-200"}`}
            >
              {issue.title}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {issue.issueType && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">
                {issue.issueType}
              </span>
            )}
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-200 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
              {issue.currentState}
            </span>
            {issue.labels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-200 dark:bg-stone-800 text-stone-500"
              >
                <Tag size={7} />
                {label}
              </span>
            ))}
            {issue.blocks.length > 0 && (
              <span className="text-[10px] text-amber-500/70 dark:text-amber-400/50">
                Blocks {issue.blocks.length} {issue.blocks.length === 1 ? "issue" : "issues"}
              </span>
            )}
            {primaryAssignee && (
              <span className="text-[10px] text-stone-400 dark:text-stone-600">
                {primaryAssignee}
              </span>
            )}
            {isAssigned && (
              <span className="text-[10px] font-medium text-violet-400/60">
                Bench {assignedBenchId}
              </span>
            )}
            {isBlocked && (
              <span
                id={blockedDescriptionId}
                className="inline-flex items-center gap-1 text-[10px] text-red-500 dark:text-red-400"
              >
                <Lock size={8} />
                Blocked by {blockers.join(", ")}
              </span>
            )}
          </div>
        </div>

        <div onPointerDown={(e) => e.stopPropagation()}>
          <Button
            onPress={() => window.open(issue.externalUrl, "_blank")}
            className="shrink-0 p-1 text-stone-300 dark:text-stone-700 hover:text-stone-500 dark:hover:text-stone-400 transition-colors outline-none opacity-0 group-hover:opacity-100"
            aria-label={`Open ${issue.externalId} in browser`}
          >
            <ExternalLink size={11} />
          </Button>
        </div>
      </div>
    </div>
  );
}
