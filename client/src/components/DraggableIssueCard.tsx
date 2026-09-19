import { Button } from "react-aria-components";
import { useDraggable } from "@dnd-kit/core";
import { ExternalLink, Lock } from "lucide-react";
import type { NormalizedIssue } from "@roubo/shared";
import IssueChip from "./IssueChip";
import {
  METADATA_ICONS,
  MILESTONE_ICON,
  alertSeverityTooltip,
  issueTypeChip,
  milestoneLabel,
  securityCategoryFor,
  shortIssueRef,
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

  // Surface the milestone right after the status chip when a plugin provides it.
  // The chip truncates, so the full title is exposed via tooltip on hover.
  const milestone = milestoneLabel(issue);
  if (milestone) {
    chips.push({
      category: "milestone",
      key: "milestone",
      label: milestone,
      icon: MILESTONE_ICON,
      tooltip: milestone,
    });
  }

  // Keep the dependency chip adjacent to the status chip so "Blocked" and
  // "Blocks N issue(s)" wrap onto the same line. Being the earliest metadata
  // entry also makes it the last metadata chip truncateChips drops.
  if (issue.blocks.length > 0) {
    chips.push({
      category: "metadata",
      key: "blocks",
      label: `Blocks ${issue.blocks.length} ${issue.blocks.length === 1 ? "issue" : "issues"}`,
      icon: METADATA_ICONS.blocks,
    });
  }

  // Security categories surface a dedicated chip in the chips row
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
      className={`group relative rounded-lg border transition-colors ${
        isDragging
          ? "opacity-40 border-accent-border bg-accent-muted"
          : isBlocked
            ? "opacity-50 border-border bg-bg-base cursor-not-allowed"
            : isAssigned
              ? "border-border bg-bg-base"
              : "border-border bg-bg-surface hover:bg-bg-hover cursor-grab active:cursor-grabbing"
      }`}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <span
            className={`block truncate text-12 font-medium ${isAssigned ? "text-text-secondary" : "text-text-primary"}`}
          >
            {issue.title}
          </span>
          <span className="block text-11 font-mono mb-1.5 text-text-secondary">
            {shortIssueRef(issue.externalId)}
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
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
            className="shrink-0 p-1 text-text-secondary hover:text-text-primary transition-colors outline-none opacity-0 group-hover:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-label={`Open ${issue.externalId} in browser`}
          >
            <ExternalLink size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}
