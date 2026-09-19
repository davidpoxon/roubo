import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
import { GitBranch, AlertTriangle } from "lucide-react";
import type { BranchConflictInfo } from "@roubo/shared";

export default function BranchConflictDialog({
  isOpen,
  onClose,
  conflict,
  onResume,
  onCreateNew,
}: {
  isOpen: boolean;
  onClose: () => void;
  conflict: BranchConflictInfo;
  onResume: () => void;
  onCreateNew: () => void;
}) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-md mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none"
        >
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="text-16 font-semibold text-stone-900 dark:text-stone-100"
                >
                  Branch already exists
                </Heading>
              </div>

              <div className="px-5 py-4 space-y-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-2">
                    <p className="text-13 text-stone-700 dark:text-stone-300">
                      The branch{" "}
                      <code className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-12 font-mono text-stone-800 dark:text-stone-200">
                        <GitBranch size={12} />
                        {conflict.branchName}
                      </code>{" "}
                      already exists in this repository.
                    </p>
                    {conflict.workspaceExists && (
                      <p className="text-12 text-amber-400/80">
                        A matching worktree also exists on disk. You may have an orphaned worktree
                        to clean up.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  onPress={close}
                  className="px-3 py-1.5 text-13 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Cancel
                </Button>
                <Button
                  onPress={() => {
                    onCreateNew();
                    close();
                  }}
                  className="px-4 py-1.5 text-13 font-medium text-stone-700 dark:text-stone-200 bg-stone-200 dark:bg-stone-700 hover:bg-stone-300 dark:hover:bg-stone-600 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Create new branch
                </Button>
                <Button
                  onPress={() => {
                    onResume();
                    close();
                  }}
                  className="px-4 py-1.5 text-13 font-medium text-stone-100 bg-stone-600 hover:bg-stone-500 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Resume existing
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
