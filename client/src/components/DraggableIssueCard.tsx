import { Button } from "react-aria-components";
import { useDraggable } from "@dnd-kit/core";
import { ExternalLink, Lock } from "lucide-react";
import type { NormalizedIssue } from "@roubo/shared";
import IssueChip from "./IssueChip";
import {
  METADATA_ICONS,
  alertSeverityTooltip,
  issueTypeChip,
  securityCategoryFor,
  statusTone,
  truncateChips,
  type ChipItem,
} from "../lib/chip-mapping";

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

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: { issue },
    disabled: isAssigned || isBlocked,
  });

  const isInteractive = !isAssigned && !isBlocked;
  const primaryAssignee = issue.assignees[0]?.displayName;
  const typeChip = issueTypeChip(issue.issueType);
  const securityCategory = securityCategoryFor(issue.issueType);

  const chips: ChipItem[] = [];

  const tone = statusTone(issue.currentState, isBlocked);
  chips.push({
    category: "status",
    key: "status",
    label: isBlocked ? "Blocked" : issue.currentState,
    tone,
    icon: isBlocked ? Lock : undefined,
    ariaDescription: isBlocked ? `Blocked by ${blockers.join(", ")}` : undefined,
  });

  // Security categories surface a dedicated chip inline-left of the title
  // (rendered below). Suppress the duplicate row-chip so the list shows only
  // the category chip per prototype-notes.
  if (typeChip && !securityCategory) {
    const tooltip = alertSeverityTooltip(issue) ?? undefined;
    chips.push({
      category: "issue-type",
      key: "issue-type",
      label: typeChip.label,
      icon: typeChip.icon,
      tooltip,
    });
  }

  for (const label of issue.labels) {
    chips.push({
      category: "label",
      key: `label:${label}`,
      label,
    });
  }

  if (primaryAssignee) {
    chips.push({
      category: "metadata",
      key: "assignee",
      label: primaryAssignee,
      icon: METADATA_ICONS.assignee,
    });
  }

  if (issue.blocks.length > 0) {
    chips.push({
      category: "metadata",
      key: "blocks",
      label: `Blocks ${issue.blocks.length} ${issue.blocks.length === 1 ? "issue" : "issues"}`,
      icon: METADATA_ICONS.blocks,
    });
  }

  if (isAssigned) {
    chips.push({
      category: "metadata",
      key: "bench",
      label: `Bench ${assignedBenchId}`,
      icon: METADATA_ICONS.bench,
    });
  }

  const { visible, overflowCount } = truncateChips(chips, 6);

  return (
    <div
      ref={setNodeRef}
      {...(isInteractive ? listeners : {})}
      {...(isInteractive ? attributes : {})}
      aria-disabled={isBlocked || undefined}
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
            {securityCategory && typeChip && (
              <IssueChip
                variant="security-category"
                securityCategory={securityCategory}
                icon={typeChip.icon}
                tooltip={issue.externalId}
                data-testid="security-category-chip"
              >
                {typeChip.label}
              </IssueChip>
            )}
            <span
              className={`text-xs font-medium truncate ${isAssigned ? "text-stone-400 dark:text-stone-600" : "text-stone-800 dark:text-stone-200"}`}
            >
              {issue.title}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {visible.map((chip) => (
              <IssueChip
                key={chip.key}
                variant={chip.category}
                icon={chip.icon}
                tone={chip.tone}
                ariaDescription={chip.ariaDescription}
                tooltip={chip.tooltip}
              >
                {chip.label}
              </IssueChip>
            ))}
            {overflowCount > 0 && (
              <IssueChip key="overflow" variant="metadata">
                +{overflowCount} more
              </IssueChip>
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
