import { useCallback, useMemo, useState } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
import { Tag, ExternalLink, Lock, ChevronLeft, ChevronRight } from "lucide-react";
import Spinner from "./Spinner";
import IssueChip from "./IssueChip";
import { useIssues } from "../hooks/useIssues";
import type { Bench, NormalizedIssue } from "@roubo/shared";
import { issueTypeChip, securityCategoryFor } from "../lib/chip-mapping";

function IssueRow({
  issue,
  onSelect,
}: {
  issue: NormalizedIssue;
  onSelect: (externalId: string, issueTitle: string) => void;
}) {
  const blockers = issue.blockedBy;
  const isBlocked = blockers.length > 0;
  const securityCategory = securityCategoryFor(issue.issueType);
  const typeChip = issueTypeChip(issue.issueType);

  return (
    <Button
      onPress={() => onSelect(issue.externalId, issue.title)}
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
  onSelect: (externalId: string, issueTitle: string) => void;
  projectId: string;
  benches: Bench[];
  pendingIssueExternalIds?: Set<string>;
}) {
  // Client-retained cursor history for Prev/Next paging (the plugin contract is
  // forward-only, so Prev replays a retained cursor that React Query serves from
  // cache). Index 0 is always `null` (page 1).
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const activeCursor = cursorStack[pageIndex] ?? null;
  const [pageAnnouncement, setPageAnnouncement] = useState("");

  // Reset to page 1 whenever the modal closes so a fresh open starts clean.
  // Adjusting state during render (React's recommended alternative to a reset
  // effect) keeps a reopened modal from briefly showing the prior page.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (!isOpen) {
      setCursorStack([null]);
      setPageIndex(0);
      setPageAnnouncement("");
    }
  }

  const { issues, isLoading, nextCursor, stalled, error } = useIssues(
    projectId,
    {},
    undefined,
    activeCursor,
  );

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
    setCursorStack((stack) => [...stack.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((prev) => {
      const next = prev + 1;
      setPageAnnouncement(`Page ${next + 1}`);
      return next;
    });
  }, [nextCursor, pageIndex]);

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
        <Dialog
          ref={stampAriaModal}
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none flex flex-col overflow-hidden"
        >
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
                  </div>
                )}
              </div>

              {/* Pagination footer. Hidden while loading, on error, or when there
                  is genuinely nothing to page (no items on this page AND no
                  prior/next page). When the current page's issues are all assigned
                  or pending but another page exists (hasNext) or we paged in from a
                  prior page (hasPrev), the pager stays so Next/Prev stay reachable. */}
              {!isLoading && !error && (items.length > 0 || hasPrev || hasNext) && (
                <div
                  data-testid="picker-pager"
                  className="flex items-center justify-between gap-2 px-4 py-2 border-t border-stone-200 dark:border-stone-800/60"
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
                    data-testid="picker-page-indicator"
                    className="text-[11px] font-mono text-stone-500 dark:text-stone-600 whitespace-nowrap"
                  >
                    Page {pageNumber} &middot; {items.length} item{items.length === 1 ? "" : "s"}
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

              <div aria-live="polite" className="sr-only" data-testid="picker-page-live">
                {pageAnnouncement}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
