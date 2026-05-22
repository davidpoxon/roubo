import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { AlertTriangle } from "lucide-react";

interface Props {
  pluginName: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isPending?: boolean;
}

export default function UninstallPluginDialog({
  pluginName,
  isOpen,
  onClose,
  onConfirm,
  isPending,
}: Props) {
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
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              Uninstall {pluginName}?
            </Heading>
          </div>

          <div className="px-5 py-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-sm text-stone-700 dark:text-stone-300">
                This will stop the plugin and remove its files from disk. Any per-project
                integration referencing it must be cleared first. This action cannot be undone.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
            <Button
              isDisabled={isPending}
              onPress={onClose}
              className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 not-disabled:hover:text-stone-700 dark:not-disabled:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none"
            >
              Cancel
            </Button>
            <Button
              isDisabled={isPending}
              onPress={onConfirm}
              className="px-4 py-1.5 text-sm font-medium text-stone-100 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors outline-none"
            >
              Uninstall
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
