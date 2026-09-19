import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-lg mx-4">
        <Dialog
          ref={stampAriaModal}
          data-testid="enable-plugin-modal"
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none"
        >
          <div className="px-5 py-4 border-b border-border">
            <Heading slot="title" className="text-16 font-semibold text-text-primary">
              {STRINGS.title(pluginName)}
            </Heading>
            <p className="mt-1 text-12 text-text-secondary">
              {STRINGS.descriptionPrefix}
              <span className="font-mono">{STRINGS.descriptionRoubo}</span>
              {STRINGS.descriptionReferences}
              <span className="font-mono text-text-body">{pluginId}</span>
              {STRINGS.descriptionPluginSuffix}
            </p>
          </div>

          {error && (
            <div className="px-5 pt-4">
              <div
                role="alert"
                data-testid="enable-plugin-error"
                className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-13 text-danger-text flex items-start gap-2"
              >
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
            <Button
              onPress={handleCancel}
              isDisabled={isPending}
              data-testid="enable-plugin-cancel"
              className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {STRINGS.cancel}
            </Button>
            <Button
              autoFocus
              onPress={handleConfirm}
              isDisabled={isPending}
              data-testid="enable-plugin-confirm"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring not-disabled:active:bg-accent-active"
            >
              <Power size={14} />
              {isPending ? STRINGS.enabling : STRINGS.enableAndLoad}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
