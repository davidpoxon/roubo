import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { ApiError } from "../../../lib/api";
import {
  useInstallPluginCancel,
  useInstallPluginConfirm,
  useInstallPluginPreview,
} from "../../../hooks/usePlugins";
import { useToast } from "../../../hooks/useToast";
import {
  PermissionsScreen,
  SourceScreen,
  initialSourceStep,
  type PermissionsStep,
  type SourceStep,
} from "./install-screens";

type State = SourceStep | PermissionsStep;

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function InstallPluginDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  // Mount inner content only while open so state resets between sessions
  // without an effect-driven reset.
  if (!isOpen) return null;
  return <InstallPluginDialogContent onClose={onClose} />;
}

function InstallPluginDialogContent({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State>(() => initialSourceStep());
  const previewMutation = useInstallPluginPreview();
  const confirmMutation = useInstallPluginConfirm();
  const cancelMutation = useInstallPluginCancel();
  const { addToast } = useToast();

  const isSubmitting = previewMutation.isPending || confirmMutation.isPending;

  function handleClose() {
    // If we were on the permissions screen with a live staging token, fire a
    // best-effort cancel so we never orphan a staging directory.
    if (state.step === "permissions" && !confirmMutation.isPending) {
      cancelMutation.mutate(state.preview.stagingToken);
    }
    onClose();
  }

  function handleSubmitSource() {
    if (state.step !== "source") return;
    const value = (state.tab === "git" ? state.gitInput : state.localInput).trim();
    if (value.length === 0) {
      setState({
        ...state,
        error:
          state.tab === "git"
            ? "Enter the Git URL of a plugin repository."
            : "Enter the absolute path to a local plugin directory.",
      });
      return;
    }
    setState({ ...state, error: null });
    previewMutation.mutate(
      { source: state.tab, value },
      {
        onSuccess: (preview) => {
          setState({ step: "permissions", preview, error: null });
        },
        onError: (err) => {
          setState({ ...state, error: errorMessage(err, "Install failed.") });
        },
      },
    );
  }

  function handleConfirm() {
    if (state.step !== "permissions") return;
    confirmMutation.mutate(state.preview.stagingToken, {
      onSuccess: (result) => {
        const name = result.plugin.manifest?.name ?? result.plugin.id;
        addToast(`Installed ${name}.`);
        onClose();
      },
      onError: (err) => {
        setState({ ...state, error: errorMessage(err, "Install failed.") });
      },
    });
  }

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      isDismissable={!isSubmitting}
      isKeyboardDismissDisabled={isSubmitting}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {state.step === "source" ? (
            <SourceScreen
              state={state}
              onChange={setState}
              onCancel={handleClose}
              onSubmit={handleSubmitSource}
              submitting={previewMutation.isPending}
            />
          ) : (
            <PermissionsScreen
              state={state}
              onCancel={handleClose}
              onConfirm={handleConfirm}
              confirming={confirmMutation.isPending}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
