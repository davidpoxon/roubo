import { useMemo } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { Tag, MessageSquare, ExternalLink, Lock, Milestone } from "lucide-react";
import Spinner from "./Spinner";
import { useProjectItems } from "../hooks/useProjectItems";
import type { Bench, GitHubProjectItem, RouboConfig } from "@roubo/shared";
import { blockerUrl } from "../lib/github";

function IssueRow({
  item,
  onSelect,
}: {
  item: GitHubProjectItem;
  onSelect: (issueNumber: number, issueTitle: string) => void;
}) {
  const { issue } = item;
  const blockers = issue.blockedBy ?? [];
  const isBlocked = blockers.length > 0;

  const inner = (
    <>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono text-stone-400 dark:text-stone-600 shrink-0">
            #{issue.number}
          </span>
          <span className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
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
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-200 dark:bg-stone-800 text-stone-500 dark:text-stone-400"
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
          {isBlocked && (
            <span className="inline-flex items-center gap-1 text-[10px] text-red-500 dark:text-red-400">
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
                  >
                    #{blocker.number}
                  </a>
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
      <a
        href={issue.htmlUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 p-1 text-stone-400 dark:text-stone-700 hover:text-stone-600 dark:hover:text-stone-400 transition-colors"
      >
        <ExternalLink size={11} />
      </a>
    </>
  );

  if (isBlocked) {
    return (
      <div
        aria-disabled="true"
        className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left rounded-lg opacity-50 cursor-not-allowed"
      >
        {inner}
      </div>
    );
  }

  return (
    <Button
      onPress={() => onSelect(issue.number, issue.title)}
      className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800/60 transition-colors outline-none"
    >
      {inner}
    </Button>
  );
}

export default function IssuePickerModal({
  isOpen,
  onClose,
  onSelect,
  projectId,
  projectConfig,
  benches,
  pendingIssueNumbers,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (issueNumber: number, issueTitle: string) => void;
  projectId: string;
  projectConfig: RouboConfig;
  benches: Bench[];
  pendingIssueNumbers?: Set<number>;
}) {
  const projectNumber = projectConfig.project.github?.project;

  const { data: projectData, isLoading } = useProjectItems(projectId, projectNumber);

  const assignedMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const bench of benches) {
      if (bench.assignedIssue) {
        map.set(bench.assignedIssue.number, bench.id);
      }
    }
    return map;
  }, [benches]);

  const items = useMemo(() => {
    if (!projectData?.items) return undefined;
    return projectData.items.filter(
      (item) => !assignedMap.has(item.issue.number) && !pendingIssueNumbers?.has(item.issue.number),
    );
  }, [projectData, assignedMap, pendingIssueNumbers]);

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
                {isLoading && (
                  <div className="flex items-center justify-center py-12">
                    <Spinner />
                    <span className="ml-2 text-xs text-stone-600">Loading...</span>
                  </div>
                )}

                {!isLoading && items && (
                  <div className="space-y-0.5">
                    {items.length > 0 ? (
                      items.map((item) => (
                        <IssueRow key={item.issue.number} item={item} onSelect={onSelect} />
                      ))
                    ) : (
                      <div className="flex items-center justify-center py-12">
                        <p className="text-sm text-stone-400 dark:text-stone-600">No open issues</p>
                      </div>
                    )}
                  </div>
                )}

                {!isLoading && !projectNumber && (
                  <div className="flex items-center justify-center py-12">
                    <p className="text-sm text-stone-400 dark:text-stone-600">
                      No GitHub project configured
                    </p>
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
