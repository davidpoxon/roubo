import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { AlertTriangle, Power } from "lucide-react";
import { ApiError } from "../lib/api";
import { useEnablePlugin } from "../hooks/usePlugins";

const STRINGS = {
  title: (pluginName: string) => `Enable ${pluginName} to load this project?`,
  descriptionPrefix: "This project's ",
  descriptionRoubo: "roubo.yaml",
  descriptionReferences: " references the ",
  descriptionPluginSuffix:
    " plugin, which is currently disabled. Roubo will start it and continue loading the project. You can disable it again from Settings → Plugins.",
  errorFallback: (pluginName: string) => `Couldn't start ${pluginName}.`,
  cancel: "Cancel",
  enabling: "Enabling…",
  enableAndLoad: "Enable and load project",
};

interface Props {
  projectId: string;
  pluginId: string;
  pluginName: string;
  onCancel: () => void;
  onEnabled: () => void;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function EnablePluginPromptModal({
  projectId,
  pluginId,
  pluginName,
  onCancel,
  onEnabled,
}: Props) {
  const queryClient = useQueryClient();
  const enableMutation = useEnablePlugin();
  const [error, setError] = useState<string | null>(null);

  const isPending = enableMutation.isPending;

  function handleCancel() {
    if (isPending) return;
    onCancel();
  }

  function handleConfirm() {
    setError(null);
    enableMutation.mutate(pluginId, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
        onEnabled();
      },
      onError: (err) => {
        setError(errorMessage(err, STRINGS.errorFallback(pluginName)));
      },
    });
  }

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) handleCancel();
      }}
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog
          data-testid="enable-plugin-modal"
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              {STRINGS.title(pluginName)}
            </Heading>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              {STRINGS.descriptionPrefix}
              <span className="font-mono">{STRINGS.descriptionRoubo}</span>
              {STRINGS.descriptionReferences}
              <span className="font-mono text-stone-700 dark:text-stone-200">{pluginId}</span>
              {STRINGS.descriptionPluginSuffix}
            </p>
          </div>

          {error && (
            <div className="px-5 pt-4">
              <div
                role="alert"
                data-testid="enable-plugin-error"
                className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300 flex items-start gap-2"
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
            <Button
              onPress={handleCancel}
              isDisabled={isPending}
              data-testid="enable-plugin-cancel"
              className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              autoFocus
              onPress={handleConfirm}
              isDisabled={isPending}
              data-testid="enable-plugin-confirm"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Power size={13} />
              {isPending ? STRINGS.enabling : STRINGS.enableAndLoad}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
