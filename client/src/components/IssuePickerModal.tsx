import { useEffect, useMemo, useRef } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { Tag, ExternalLink, Lock } from "lucide-react";
import Spinner from "./Spinner";
import IssueChip from "./IssueChip";
import { useIssues } from "../hooks/useIssues";
import type { Bench, NormalizedIssue } from "@roubo/shared";
import { issueNumberFromExternalId } from "../lib/issue-id";
import { issueTypeChip, securityCategoryFor } from "../lib/chip-mapping";

function IssueRow({
  issue,
  onSelect,
}: {
  issue: NormalizedIssue;
  onSelect: (issueNumber: number, issueTitle: string) => void;
}) {
  const blockers = issue.blockedBy;
  const isBlocked = blockers.length > 0;
  const issueNumber = issueNumberFromExternalId(issue.externalId);
  const canSelect = issueNumber !== null;
  const securityCategory = securityCategoryFor(issue.issueType);
  const typeChip = issueTypeChip(issue.issueType);

  return (
    <Button
      onPress={() => {
        if (issueNumber !== null) onSelect(issueNumber, issue.title);
      }}
      isDisabled={!canSelect}
      className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800/60 transition-colors outline-none disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono text-stone-400 dark:text-stone-600 shrink-0">
            {issue.externalId}
          </span>
          {securityCategory && typeChip && (
            // No tooltip here: the row is already an interactive React Aria
            // Button (HTML <button>) and an inner tooltip-wrapped Button would
            // produce nested buttons. The externalId tooltip is non-additive
            // anyway, since the externalId span is rendered inline to the left.
            <IssueChip
              variant="security-category"
              securityCategory={securityCategory}
              icon={typeChip.icon}
              data-testid="security-category-chip"
            >
              {typeChip.label}
            </IssueChip>
          )}
          <span className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
            {issue.title}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {issue.issueType && !securityCategory && (
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
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-200 dark:bg-stone-800 text-stone-500 dark:text-stone-400"
            >
              <Tag size={7} />
              {label}
            </span>
          ))}
        </div>
        {isBlocked && (
          <div
            data-testid="blocked-banner"
            className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60"
          >
            <Lock size={9} />
            Blocked by {blockers.join(", ")}
          </div>
        )}
      </div>
      <a
        href={issue.externalUrl}
        target="_blank"
        rel="noopener noreferrer"
        onPointerDown={(e) => e.stopPropagation()}
        className="shrink-0 p-1 text-stone-400 dark:text-stone-700 hover:text-stone-600 dark:hover:text-stone-400 transition-colors"
      >
        <ExternalLink size={11} />
      </a>
    </Button>
  );
}

export default function IssuePickerModal({
  isOpen,
  onClose,
  onSelect,
  projectId,
  benches,
  pendingIssueExternalIds,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (issueNumber: number, issueTitle: string) => void;
  projectId: string;
  benches: Bench[];
  pendingIssueExternalIds?: Set<string>;
}) {
  const { issues, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, stalled, error } =
    useIssues(projectId);

  const assignedExternalIds = useMemo(() => {
    const set = new Set<string>();
    for (const bench of benches) {
      if (bench.assignedIssue?.externalId) set.add(bench.assignedIssue.externalId);
    }
    return set;
  }, [benches]);

  const items = useMemo(() => {
    return issues.filter(
      (issue) =>
        !assignedExternalIds.has(issue.externalId) &&
        !pendingIssueExternalIds?.has(issue.externalId),
    );
  }, [issues, assignedExternalIds, pendingIssueExternalIds]);

  // Auto-fetch next page when the sentinel scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none flex flex-col overflow-hidden">
          {() => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  Pick an issue
                </Heading>
              </div>

              <div className="flex-1 overflow-y-auto px-1 py-1 min-h-[200px] max-h-[50vh]">
                {stalled && (
                  <div
                    data-testid="stalled-note"
                    className="m-3 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 text-[11px] text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60"
                  >
                    Plugin paging appears stuck. Try a refresh.
                  </div>
                )}

                {isLoading && (
                  <div className="flex items-center justify-center py-12">
                    <Spinner />
                    <span className="ml-2 text-xs text-stone-600">Loading...</span>
                  </div>
                )}

                {!isLoading && error && (
                  <div className="flex items-center justify-center py-12">
                    <p className="text-sm text-stone-400 dark:text-stone-600">
                      Could not load issues.
                    </p>
                  </div>
                )}

                {!isLoading && !error && (
                  <div className="space-y-0.5">
                    {items.length > 0 ? (
                      items.map((issue) => (
                        <IssueRow key={issue.externalId} issue={issue} onSelect={onSelect} />
                      ))
                    ) : (
                      <div className="flex items-center justify-center py-12">
                        <p className="text-sm text-stone-400 dark:text-stone-600">No open issues</p>
                      </div>
                    )}
                    {hasNextPage && (
                      <div
                        ref={sentinelRef}
                        data-testid="picker-load-more-sentinel"
                        className="flex items-center justify-center py-4"
                      >
                        {isFetchingNextPage && <Spinner />}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
