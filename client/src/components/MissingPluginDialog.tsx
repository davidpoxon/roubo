import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { AlertTriangle, Download } from "lucide-react";
import type { InstallPreview } from "@roubo/shared";
import { ApiError } from "../lib/api";
import {
  useInstallPluginCancel,
  useInstallPluginConfirm,
  useInstallPluginPreview,
} from "../hooks/usePlugins";
import { useToast } from "../hooks/useToast";
import {
  PermissionsScreen,
  SourceScreen,
  initialSourceStep,
  type PermissionsStep,
  type SourceStep,
  type SourceTab,
} from "./settings/plugins/install-screens";

interface PromptStep {
  step: "prompt";
  error: string | null;
}

type State = PromptStep | SourceStep | PermissionsStep;

function detectSourceTab(value: string): SourceTab {
  // Local paths start with a filesystem root. Anything else (https://, git@,
  // ssh://, git+…) is treated as a Git URL; the server validates either way.
  return value.startsWith("/") ? "local" : "git";
}

function truncateSource(value: string, max = 48): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function MissingPluginDialog({
  projectId,
  pluginId,
  pluginSource,
  onClose,
  onSkip,
}: {
  projectId: string;
  pluginId: string;
  pluginSource: string | undefined;
  onClose: () => void;
  onSkip: () => void;
}) {
  return (
    <MissingPluginDialogContent
      projectId={projectId}
      pluginId={pluginId}
      pluginSource={pluginSource}
      onClose={onClose}
      onSkip={onSkip}
    />
  );
}

function MissingPluginDialogContent({
  projectId,
  pluginId,
  pluginSource,
  onClose,
  onSkip,
}: {
  projectId: string;
  pluginId: string;
  pluginSource: string | undefined;
  onClose: () => void;
  onSkip: () => void;
}) {
  const previewMutation = useInstallPluginPreview();
  const confirmMutation = useInstallPluginConfirm();
  const cancelMutation = useInstallPluginCancel();
  const { addToast } = useToast();
  const queryClient = useQueryClient();

  const [state, setState] = useState<State>(() =>
    pluginSource ? { step: "prompt", error: null } : initialSourceStep(detectSourceTab("")),
  );

  const isSubmitting = previewMutation.isPending || confirmMutation.isPending;

  function handleClose() {
    if (state.step === "permissions" && !confirmMutation.isPending) {
      cancelMutation.mutate(state.preview.stagingToken);
    }
    onClose();
  }

  function handleSkip() {
    if (state.step === "permissions" && !confirmMutation.isPending) {
      cancelMutation.mutate(state.preview.stagingToken);
    }
    onSkip();
  }

  function onPreviewSuccess(preview: InstallPreview) {
    setState({ step: "permissions", preview, error: null });
  }

  function handleOneClickInstall() {
    if (!pluginSource) return;
    const tab = detectSourceTab(pluginSource);
    previewMutation.mutate(
      { source: tab, value: pluginSource },
      {
        onSuccess: onPreviewSuccess,
        onError: (err) => {
          setState({
            step: "prompt",
            error: errorMessage(err, "Couldn't install from that source."),
          });
        },
      },
    );
  }

  function handleUseDifferentSource() {
    setState(initialSourceStep(pluginSource ? detectSourceTab(pluginSource) : "git"));
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
        onSuccess: onPreviewSuccess,
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
        void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
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
          {state.step === "prompt" && (
            <PromptScreen
              pluginId={pluginId}
              pluginSource={pluginSource}
              error={state.error}
              installing={previewMutation.isPending}
              onOneClickInstall={handleOneClickInstall}
              onUseDifferentSource={handleUseDifferentSource}
              onSkip={handleSkip}
            />
          )}
          {state.step === "source" && (
            <SourceScreen
              state={state}
              onChange={setState}
              onCancel={handleSkip}
              onSubmit={handleSubmitSource}
              submitting={previewMutation.isPending}
              title="Plugin needed for this project"
              subtitle={
                <>
                  This project's <span className="font-mono">roubo.yaml</span> references plugin{" "}
                  <span className="font-mono text-stone-700 dark:text-stone-200">{pluginId}</span>,
                  which isn't installed locally. Provide a Git URL or local directory to install it,
                  or skip for now.
                </>
              }
              cancelLabel="Skip for now"
              submitLabel="Install"
            />
          )}
          {state.step === "permissions" && (
            <PermissionsScreen
              state={state}
              onCancel={handleSkip}
              onConfirm={handleConfirm}
              confirming={confirmMutation.isPending}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function PromptScreen({
  pluginId,
  pluginSource,
  error,
  installing,
  onOneClickInstall,
  onUseDifferentSource,
  onSkip,
}: {
  pluginId: string;
  pluginSource: string | undefined;
  error: string | null;
  installing: boolean;
  onOneClickInstall: () => void;
  onUseDifferentSource: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
        <Heading slot="title" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Plugin needed for this project
        </Heading>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          This project's <span className="font-mono">roubo.yaml</span> references plugin{" "}
          <span className="font-mono text-stone-700 dark:text-stone-200">{pluginId}</span>, which
          isn't installed locally. Install it to load issues, or skip for now and load the project
          without it.
        </p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {pluginSource && (
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
              Suggested source
            </div>
            <div
              className="mt-1 text-[13px] font-mono text-stone-800 dark:text-stone-200 break-all"
              data-testid="missing-plugin-suggested-source"
            >
              {pluginSource}
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="missing-plugin-error"
            className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300 flex items-start gap-2"
          >
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
        <Button
          onPress={onSkip}
          isDisabled={installing}
          data-testid="missing-plugin-skip"
          className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Skip for now
        </Button>
        <div className="flex items-center gap-2">
          <Button
            onPress={onUseDifferentSource}
            isDisabled={installing}
            data-testid="missing-plugin-use-different-source"
            className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {pluginSource ? "Use a different source" : "Choose a source"}
          </Button>
          {pluginSource && (
            <Button
              onPress={onOneClickInstall}
              isDisabled={installing}
              data-testid="missing-plugin-one-click-install"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Download size={13} />
              {installing ? "Inspecting..." : `Install from ${truncateSource(pluginSource)}`}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
