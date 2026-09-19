import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
import { AlertTriangle } from "lucide-react";
import type { DirtyReason, DirtyReasonKind } from "@roubo/shared";

const KIND_LABEL: Record<DirtyReasonKind, string> = {
  "dirty-worktree": "Uncommitted changes",
  stash: "Stashed changes",
  "unpushed-commits": "Unpushed commits",
  "no-upstream": "No upstream branch (cannot check for unpushed commits)",
  "local-only-after-merge": "Local-only commits (upstream deleted)",
};

export default function ClearBenchDirtyDialog({
  isOpen,
  onClose,
  benchId,
  reasons,
  onConfirmForce,
  isPending,
  forceError,
}: {
  isOpen: boolean;
  onClose: () => void;
  benchId: number;
  reasons: DirtyReason[];
  onConfirmForce: () => void;
  isPending?: boolean;
  forceError?: string | null;
}) {
  const workspaceReasons = reasons.filter((r) => r.location === "workspace");
  const submoduleGroups = new Map<string, DirtyReason[]>();
  for (const r of reasons) {
    if (r.location === "workspace") continue;
    const list = submoduleGroups.get(r.location) ?? [];
    list.push(r);
    submoduleGroups.set(r.location, list);
  }

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-md mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none"
        >
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-border">
                <Heading slot="title" className="text-16 font-semibold text-text-primary">
                  Clear Bench {benchId}: uncommitted work detected
                </Heading>
              </div>

              <div className="px-5 py-4 space-y-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-accent-text shrink-0 mt-0.5" />
                  <p className="text-13 text-text-body">
                    This bench has work that isn&apos;t committed or pushed. Clearing it now will
                    permanently discard:
                  </p>
                </div>

                {workspaceReasons.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-11 font-medium text-text-secondary uppercase tracking-label">
                      Workspace
                    </p>
                    {workspaceReasons.map((r) => (
                      <div key={`${r.kind}-workspace`} className="text-13 text-text-body">
                        {KIND_LABEL[r.kind]}{" "}
                        <span className="font-mono text-12 text-text-secondary">{r.detail}</span>
                      </div>
                    ))}
                  </div>
                )}

                {Array.from(submoduleGroups.entries()).map(([location, locationReasons]) => (
                  <div key={location} className="space-y-1.5">
                    <p className="text-11 font-medium text-text-secondary uppercase tracking-label font-mono">
                      {location}
                    </p>
                    {locationReasons.map((r) => (
                      <div key={`${r.kind}-${location}`} className="text-13 text-text-body">
                        {KIND_LABEL[r.kind]}{" "}
                        <span className="font-mono text-12 text-text-secondary">{r.detail}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {forceError && (
                <div className="px-5 pb-3">
                  <p className="text-13 text-danger-text">{forceError}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
                <Button
                  isDisabled={isPending}
                  onPress={close}
                  className="px-3 py-1.5 text-13 text-text-secondary not-disabled:hover:text-text-primary disabled:opacity-40 transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Cancel
                </Button>
                <Button
                  isDisabled={isPending}
                  onPress={onConfirmForce}
                  className="px-4 py-1.5 text-13 font-medium text-on-danger bg-danger not-disabled:hover:bg-danger-hover disabled:opacity-40 rounded-control transition-colors outline-none not-disabled:active:bg-danger-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Clear anyway
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
