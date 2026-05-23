import { useEffect, useRef, useState } from "react";
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

export default function InstallPluginDialog() {
  return (
    <ModalOverlay
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => <InstallFlow close={close} />}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function InstallFlow({ close }: { close: () => void }) {
  const [state, setState] = useState<State>(() => initialSourceStep());
  const previewMutation = useInstallPluginPreview();
  const confirmMutation = useInstallPluginConfirm();
  const cancelMutation = useInstallPluginCancel();
  const { addToast } = useToast();

  // Cleanup contract: if the user leaves the permissions screen without
  // confirming, fire a best-effort cancel so we never orphan the staging
  // directory on the server. Three close paths: Cancel button (handled
  // synchronously in handleCancel below), and Escape / overlay-dismiss
  // (handled by the unmount effect below). Both go through the same
  // idempotent helper, guarded by cleanedUpRef.
  const stateRef = useRef(state);
  stateRef.current = state;
  const cancelRef = useRef(cancelMutation);
  cancelRef.current = cancelMutation;
  const confirmedRef = useRef(false);
  const confirmPendingRef = useRef(confirmMutation.isPending);
  confirmPendingRef.current = confirmMutation.isPending;
  const cleanedUpRef = useRef(false);

  const maybeCleanupRef = useRef(() => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;
    const s = stateRef.current;
    if (s.step === "permissions" && !confirmedRef.current && !confirmPendingRef.current) {
      cancelRef.current.mutate(s.preview.stagingToken);
    }
  });

  useEffect(() => {
    const cleanup = maybeCleanupRef.current;
    return () => cleanup();
  }, []);

  function handleCancel() {
    maybeCleanupRef.current();
    close();
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
        confirmedRef.current = true;
        close();
      },
      onError: (err) => {
        setState({ ...state, error: errorMessage(err, "Install failed.") });
      },
    });
  }

  return state.step === "source" ? (
    <SourceScreen
      state={state}
      onChange={setState}
      onCancel={handleCancel}
      onSubmit={handleSubmitSource}
      submitting={previewMutation.isPending}
    />
  ) : (
    <PermissionsScreen
      state={state}
      onCancel={handleCancel}
      onConfirm={handleConfirm}
      confirming={confirmMutation.isPending}
    />
  );
}
