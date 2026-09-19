import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../../../lib/aria-modal";
import { AlertTriangle } from "lucide-react";

const STRINGS = {
  title: (pluginName: string) => `Uninstall ${pluginName}?`,
  body: "This will stop the plugin and remove its files from disk. Any per-project integration referencing it must be cleared first. This action cannot be undone.",
  cancel: "Cancel",
  uninstall: "Uninstall",
};

interface Props {
  pluginName: string;
  onConfirm: () => void;
  isPending?: boolean;
}

export default function UninstallPluginDialog({ pluginName, onConfirm, isPending }: Props) {
  return (
    <ModalOverlay
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
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="text-16 font-semibold text-stone-900 dark:text-stone-100"
                >
                  {STRINGS.title(pluginName)}
                </Heading>
              </div>

              <div className="px-5 py-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-13 text-stone-700 dark:text-stone-300">{STRINGS.body}</p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  isDisabled={isPending}
                  onPress={close}
                  className="px-3 py-1.5 text-13 text-stone-500 dark:text-stone-400 not-disabled:hover:text-stone-700 dark:not-disabled:hover:text-stone-200 disabled:opacity-40 transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {STRINGS.cancel}
                </Button>
                <Button
                  isDisabled={isPending}
                  onPress={() => {
                    onConfirm();
                    close();
                  }}
                  className="px-4 py-1.5 text-13 font-medium text-on-danger bg-danger not-disabled:hover:bg-danger-hover disabled:opacity-40 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring not-disabled:active:bg-danger-active"
                >
                  {STRINGS.uninstall}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
