import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { AlertTriangle } from "lucide-react";
import type { BlueprintMeta, BlueprintReference } from "@roubo/shared";

function formatReference(ref: BlueprintReference): string {
  if (ref.type === "app-default") return "Set as the app-level default blueprint in Settings.";
  if (ref.type === "project-default") return `Default blueprint for "${ref.projectName}".`;
  return `Assigned to issue type "${ref.issueType}" in "${ref.projectName}".`;
}

interface Props {
  isOpen: boolean;
  blueprint: Pick<BlueprintMeta, "id" | "name">;
  onCancel: () => void;
  onConfirm: () => void;
  references?: BlueprintReference[];
  isPending?: boolean;
}

export default function DeleteBlueprintDialog({
  isOpen,
  blueprint,
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-sm mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  {isBlocked ? "Blueprint is in use" : `Delete "${blueprint.name}"?`}
                </Heading>
              </div>

              <div className="px-5 py-4 space-y-3">
                {isBlocked ? (
                  <>
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-stone-700 dark:text-stone-300">
                        This blueprint cannot be deleted because it is referenced in:
                      </p>
                    </div>
                    <ul className="space-y-1 pl-4">
                      {(references ?? []).map((ref, i) => (
                        <li
                          key={i}
                          className="text-sm text-stone-600 dark:text-stone-400 list-disc"
                        >
                          {formatReference(ref)}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-stone-400 dark:text-stone-600">
                      Remove those references first, then delete this blueprint.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-stone-700 dark:text-stone-300">
                    This will permanently delete the blueprint. This action cannot be undone.
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                {isBlocked ? (
                  <Button
                    onPress={close}
                    className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none"
                  >
                    OK
                  </Button>
                ) : (
                  <>
                    <Button
                      isDisabled={isPending}
                      onPress={close}
                      className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none"
                    >
                      Cancel
                    </Button>
                    <Button
                      isDisabled={isPending}
                      onPress={onConfirm}
                      className="px-4 py-1.5 text-sm font-medium text-stone-100 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors outline-none"
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
