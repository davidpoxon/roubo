import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../../lib/aria-modal";
import { AlertTriangle } from "lucide-react";

export interface ComponentBenchReference {
  benchId: number;
  branch: string;
}

interface Props {
  isOpen: boolean;
  componentName: string;
  references: ComponentBenchReference[];
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ComponentRemoveDialog({
  isOpen,
  componentName,
  references,
  onCancel,
  onConfirm,
}: Props) {
  const isInUse = references.length > 0;

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
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-16 font-semibold text-stone-900 dark:text-stone-100"
            >
              {isInUse ? `"${componentName}" is in use` : `Remove "${componentName}"?`}
            </Heading>
          </div>

          <div className="px-5 py-4 space-y-3">
            {isInUse ? (
              <>
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-13 text-stone-700 dark:text-stone-300">
                    This component is currently running in:
                  </p>
                </div>
                <ul className="space-y-1 pl-4">
                  {references.map((ref) => (
                    <li
                      key={ref.benchId}
                      className="text-13 text-stone-600 dark:text-stone-400 list-disc"
                    >
                      bench #{ref.benchId}{" "}
                      <span className="font-mono text-text-secondary">({ref.branch})</span>
                    </li>
                  ))}
                </ul>
                <p className="text-12 text-stone-500 dark:text-stone-400">
                  Removing it will stop tracking it in those benches. The benches themselves will
                  not be cleared.
                </p>
              </>
            ) : (
              <p className="text-13 text-stone-700 dark:text-stone-300">
                This will remove{" "}
                <span className="font-mono text-stone-900 dark:text-stone-100">
                  {componentName}
                </span>{" "}
                from the components list.
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
            <Button
              onPress={onCancel}
              className="px-3 py-1.5 text-13 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Cancel
            </Button>
            <Button
              onPress={onConfirm}
              className="px-4 py-1.5 text-13 font-medium text-on-danger bg-danger not-disabled:hover:bg-danger-hover rounded-control transition-colors outline-none not-disabled:active:bg-danger-active focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {isInUse ? "Remove anyway" : "Remove"}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
