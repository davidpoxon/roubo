import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../../lib/aria-modal";
import { AlertTriangle } from "lucide-react";

interface Props {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function UnsavedChangesDialog({ isOpen, onConfirm, onCancel }: Props) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      isDismissable
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
                  Discard changes?
                </Heading>
              </div>

              <div className="px-5 py-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-13 text-stone-700 dark:text-stone-300">
                    You have unsaved changes. Leaving now will discard them.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  onPress={close}
                  className="px-3 py-1.5 text-13 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Keep editing
                </Button>
                <Button
                  onPress={onConfirm}
                  className="px-4 py-1.5 text-13 font-medium text-on-danger bg-danger not-disabled:hover:bg-danger-hover rounded-control transition-colors outline-none not-disabled:active:bg-danger-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Discard
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
