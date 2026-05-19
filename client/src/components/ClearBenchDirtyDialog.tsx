import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { AlertTriangle } from "lucide-react";
import type { DirtyReason, DirtyReasonKind } from "@roubo/shared";

const KIND_LABEL: Record<DirtyReasonKind, string> = {
  "dirty-worktree": "Uncommitted changes",
  stash: "Stashed changes",
  "unpushed-commits": "Unpushed commits",
  "no-upstream": "No upstream branch — cannot check for unpushed commits",
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-md mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  Clear Bench {benchId} — uncommitted work detected
                </Heading>
              </div>

              <div className="px-5 py-4 space-y-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-sm text-stone-700 dark:text-stone-300">
                    This bench has work that isn&apos;t committed or pushed. Clearing it now will
                    permanently discard:
                  </p>
                </div>

                {workspaceReasons.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wide">
                      Workspace
                    </p>
                    {workspaceReasons.map((r) => (
                      <div
                        key={`${r.kind}-workspace`}
                        className="text-sm text-stone-700 dark:text-stone-300"
                      >
                        {KIND_LABEL[r.kind]}{" "}
                        <span className="font-mono text-xs text-stone-500 dark:text-stone-400">
                          {r.detail}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {Array.from(submoduleGroups.entries()).map(([location, locationReasons]) => (
                  <div key={location} className="space-y-1.5">
                    <p className="text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wide font-mono">
                      {location}
                    </p>
                    {locationReasons.map((r) => (
                      <div
                        key={`${r.kind}-${location}`}
                        className="text-sm text-stone-700 dark:text-stone-300"
                      >
                        {KIND_LABEL[r.kind]}{" "}
                        <span className="font-mono text-xs text-stone-500 dark:text-stone-400">
                          {r.detail}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {forceError && (
                <div className="px-5 pb-3">
                  <p className="text-sm text-red-400">{forceError}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  isDisabled={isPending}
                  onPress={close}
                  className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 not-disabled:hover:text-stone-700 dark:not-disabled:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none"
                >
                  Cancel
                </Button>
                <Button
                  isDisabled={isPending}
                  onPress={onConfirmForce}
                  className="px-4 py-1.5 text-sm font-medium text-stone-100 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors outline-none"
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
