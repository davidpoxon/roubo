import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../../lib/aria-modal";
import { AlertTriangle } from "lucide-react";
import type { JigMeta, JigReference } from "@roubo/shared";

function formatReference(ref: JigReference): string {
  if (ref.type === "app-default") return "Set as the app-level default jig in Settings.";
  if (ref.type === "project-default") return `Default jig for "${ref.projectName}".`;
  return `Assigned to issue type "${ref.issueType}" in "${ref.projectName}".`;
}

interface Props {
  isOpen: boolean;
  jig: Pick<JigMeta, "id" | "name">;
  onCancel: () => void;
  onConfirm: () => void;
  references?: JigReference[];
  isPending?: boolean;
}

export default function DeleteJigDialog({
  isOpen,
  jig,
  onCancel,
  onConfirm,
  references,
  isPending,
}: Props) {
  const isBlocked = references && references.length > 0;

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-sm mx-4">
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
                  {isBlocked ? "Jig is in use" : `Delete "${jig.name}"?`}
                </Heading>
              </div>

              <div className="px-5 py-4 space-y-3">
                {isBlocked ? (
                  <>
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                      <p className="text-13 text-stone-700 dark:text-stone-300">
                        This jig cannot be deleted because it is referenced in:
                      </p>
                    </div>
                    <ul className="space-y-1 pl-4">
                      {(references ?? []).map((ref, i) => (
                        <li
                          key={i}
                          className="text-13 text-stone-600 dark:text-stone-400 list-disc"
                        >
                          {formatReference(ref)}
                        </li>
                      ))}
                    </ul>
                    <p className="text-12 text-stone-500 dark:text-stone-400">
                      Remove those references first, then delete this jig.
                    </p>
                  </>
                ) : (
                  <p className="text-13 text-stone-700 dark:text-stone-300">
                    This will permanently delete the jig. This action cannot be undone.
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                {isBlocked ? (
                  <Button
                    onPress={close}
                    className="px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover rounded-control transition-colors outline-none not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    OK
                  </Button>
                ) : (
                  <>
                    <Button
                      isDisabled={isPending}
                      onPress={close}
                      className="px-3 py-1.5 text-13 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-40 transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      Cancel
                    </Button>
                    <Button
                      isDisabled={isPending}
                      onPress={onConfirm}
                      className="px-4 py-1.5 text-13 font-medium text-on-danger bg-danger not-disabled:hover:bg-danger-hover disabled:opacity-40 rounded-control transition-colors outline-none not-disabled:active:bg-danger-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      {isPending ? "Deleting..." : "Delete"}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
