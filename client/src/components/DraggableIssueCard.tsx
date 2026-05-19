import { Button } from "react-aria-components";
import { useDraggable } from "@dnd-kit/core";
import { ExternalLink, Lock, MessageSquare, Milestone, Tag } from "lucide-react";
import type { GitHubProjectItem } from "@roubo/shared";
import { statusColor } from "../lib/issue-status";
import { blockerUrl } from "../lib/github";

export default function DraggableIssueCard({
  item,
  assignedBenchId,
  dragIdSuffix,
}: {
  item: GitHubProjectItem;
  assignedBenchId?: number;
  /** Optional suffix to make the drag ID unique when the same card appears in multiple groups (e.g. label grouping). */
  dragIdSuffix?: string;
}) {
  const isAssigned = assignedBenchId !== undefined;
  const { issue } = item;
  const blockers = issue.blockedBy ?? [];
  const isBlocked = blockers.length > 0;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragIdSuffix ? `issue-${issue.number}-${dragIdSuffix}` : `issue-${issue.number}`,
    data: { item },
    disabled: isAssigned || isBlocked,
  });

  const isInteractive = !isAssigned && !isBlocked;

  return (
    <div
      ref={setNodeRef}
      {...(isInteractive ? listeners : {})}
      {...(isInteractive ? attributes : {})}
      aria-disabled={isBlocked || undefined}
      aria-describedby={isBlocked ? `blocked-by-${issue.number}` : undefined}
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
        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {/* Status dot */}
            {item.status && (
              <span
                title={item.status}
                className={`shrink-0 w-1.5 h-1.5 rounded-full ${statusColor(item.status).dot} ${isAssigned ? "opacity-40" : ""}`}
              />
            )}
            <span
              className={`text-[11px] font-mono shrink-0 ${isAssigned ? "text-stone-300 dark:text-stone-700" : "text-stone-400 dark:text-stone-600"}`}
            >
              #{issue.number}
            </span>
            <span
              className={`text-xs font-medium truncate ${isAssigned ? "text-stone-400 dark:text-stone-600" : "text-stone-800 dark:text-stone-200"}`}
            >
              {issue.title}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {issue.type && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">
                {issue.type}
              </span>
            )}
            {issue.milestone && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-200 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
                <Milestone size={7} />
                {issue.milestone}
              </span>
            )}
            {issue.labels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-200 dark:bg-stone-800 text-stone-500"
              >
                <Tag size={7} />
                {label}
              </span>
            ))}
            {issue.commentsCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-stone-400 dark:text-stone-600">
                <MessageSquare size={9} />
                {issue.commentsCount}
              </span>
            )}
            {issue.blockingCount !== undefined && issue.blockingCount > 0 && (
              <span className="text-[10px] text-amber-500/70 dark:text-amber-400/50">
                Blocks {issue.blockingCount} {issue.blockingCount === 1 ? "issue" : "issues"}
              </span>
            )}
            {issue.assignee && (
              <span className="text-[10px] text-stone-400 dark:text-stone-600">
                {issue.assignee}
              </span>
            )}
            {isAssigned && (
              <span className="text-[10px] font-medium text-violet-400/60">
                Bench {assignedBenchId}
              </span>
            )}
            {isBlocked && (
              <span
                id={`blocked-by-${issue.number}`}
                className="inline-flex items-center gap-1 text-[10px] text-red-500 dark:text-red-400"
              >
                <Lock size={8} />
                Blocked by{" "}
                {blockers.map((blocker, i) => (
                  <span key={blocker.number}>
                    {i > 0 && ", "}
                    <a
                      href={blockerUrl(issue.htmlUrl, blocker.number)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={blocker.title}
                      className="underline underline-offset-2 hover:text-red-600 dark:hover:text-red-300"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      #{blocker.number}
                    </a>
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>

        {/* External link — stopPropagation prevents drag initiation */}
        <div onPointerDown={(e) => e.stopPropagation()}>
          <Button
            onPress={() => window.open(issue.htmlUrl, "_blank")}
            className="shrink-0 p-1 text-stone-300 dark:text-stone-700 hover:text-stone-500 dark:hover:text-stone-400 transition-colors outline-none opacity-0 group-hover:opacity-100"
            aria-label={`Open issue #${issue.number} on GitHub`}
          >
            <ExternalLink size={11} />
          </Button>
        </div>
      </div>
    </div>
  );
}
