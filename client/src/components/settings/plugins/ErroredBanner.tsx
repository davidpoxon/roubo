import { useState } from "react";
import { Button } from "react-aria-components";
import { AlertCircle } from "lucide-react";
import type {
  InstallPreview,
  PermissionCategory,
  PluginError,
  PluginManifest,
} from "@roubo/shared";
import { ApiError } from "../../../lib/api";
import { useGrantConsent, useRestartPlugin } from "../../../hooks/usePlugins";
import {
  useMarketplaceInstallCancel,
  useMarketplaceInstallConfirm,
  useMarketplaceUpdatePreview,
} from "../../../hooks/useMarketplace";
import { useToast } from "../../../hooks/useToast";
import MarketplaceConsentModal from "../../marketplace/MarketplaceConsentModal";

const STRINGS = {
  // Shown only for integration plugins, which fall back to a cached snapshot
  // when their process cannot start. Component plugins have no such fallback.
  snapshotNotice: "Showing your last successful issue snapshot.",
  // Defensive fallback for an errored plugin with no structured lastError.
  genericError: "Plugin failed to start.",
  restart: "Restart",
  restarting: "Restarting...",
  // #496: component plugins are installed from the marketplace, so an errored
  // component offers a Reinstall recovery affordance distinct from Restart.
  reinstall: "Reinstall",
  reinstalling: "Reinstalling...",
  reinstallFailed: "Reinstall failed.",
  reinstalledToast: (name: string) => `Reinstalled ${name}.`,
  viewLogs: "View logs",
};

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

interface Props {
  pluginId: string;
  lastError: PluginError | null;
  kind: PluginManifest["kind"] | undefined;
  onViewLogs: () => void;
}

export default function ErroredBanner({ pluginId, lastError, kind, onViewLogs }: Props) {
  const restart = useRestartPlugin();
  // #496: reuse the marketplace update -> consent -> commit machinery (the same
  // staging/consent flow the Marketplace view drives) to reinstall an errored
  // component plugin. Pressing Reinstall stages the marketplace update-preview
  // for this plugin id and surfaces the existing consent dialog on success.
  const updatePreview = useMarketplaceUpdatePreview();
  const confirmMutation = useMarketplaceInstallConfirm();
  const cancelMutation = useMarketplaceInstallCancel();
  const grantConsent = useGrantConsent();
  const { addToast } = useToast();
  const [pending, setPending] = useState<InstallPreview | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);

  const isComponent = kind === "component";

  function beginReinstall() {
    setConsentError(null);
    // No source choice here: this banner reinstalls a known-errored plugin by id.
    // If that id turns out to be served by several sources the server refuses it
    // (409 ambiguous-source, issue #558) and its message surfaces as the toast,
    // pointing the consumer at the Marketplace, which owns the pick-a-source UI.
    updatePreview.mutate(
      { id: pluginId },
      {
        onSuccess: (preview) => setPending(preview),
        onError: (err) => addToast(errorMessage(err, STRINGS.reinstallFailed)),
      },
    );
  }

  function handleConsentCancel() {
    if (!pending) return;
    cancelMutation.mutate(pending.stagingToken);
    setPending(null);
    setConsentError(null);
  }

  function handleConsentConfirm(acknowledgedCategories: PermissionCategory[]) {
    if (!pending) return;
    const preview = pending;
    confirmMutation.mutate(preview.stagingToken, {
      onSuccess: () => {
        // Re-mint the plugin's ConsentRecord with the acknowledged categories so
        // the component-plugin consent gate admits it after the reinstall (issue
        // #399), mirroring the Marketplace view's confirm handler.
        grantConsent.mutate({ pluginId: preview.manifest.id, acknowledgedCategories });
        addToast(STRINGS.reinstalledToast(preview.manifest.name));
        setPending(null);
        setConsentError(null);
      },
      onError: (err) => setConsentError(errorMessage(err, STRINGS.reinstallFailed)),
    });
  }

  return (
    <div
      role="alert"
      data-testid="plugin-errored-banner"
      className="flex items-start gap-3 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2.5"
    >
      <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0 flex-1">
        {lastError ? (
          <div className="min-w-0">
            <span className="inline-block rounded bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 font-mono text-[11px] text-red-800 dark:text-red-200 break-all">
              {lastError.code}
            </span>
            <p className="mt-1.5 text-[13px] text-red-800 dark:text-red-300 leading-relaxed break-words whitespace-pre-wrap">
              {lastError.message}
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-red-800 dark:text-red-300 leading-relaxed">
            {STRINGS.genericError}
          </p>
        )}
        {kind === "integration" && (
          <p className="mt-1.5 text-[13px] text-red-700 dark:text-red-400 leading-relaxed">
            {STRINGS.snapshotNotice}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Button
            isDisabled={restart.isPending}
            onPress={() => restart.mutate(pluginId)}
            className="px-2 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50 rounded transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {restart.isPending ? STRINGS.restarting : STRINGS.restart}
          </Button>
          {isComponent && (
            <Button
              isDisabled={updatePreview.isPending}
              onPress={beginReinstall}
              data-testid="plugin-reinstall-action"
              className="px-2 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50 rounded transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {updatePreview.isPending ? STRINGS.reinstalling : STRINGS.reinstall}
            </Button>
          )}
          <Button
            onPress={onViewLogs}
            className="px-2 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {STRINGS.viewLogs}
          </Button>
        </div>
      </div>
      {pending && (
        <MarketplaceConsentModal
          preview={pending}
          mode="update"
          error={consentError}
          isPending={confirmMutation.isPending}
          onCancel={handleConsentCancel}
          onConfirm={handleConsentConfirm}
        />
      )}
    </div>
  );
}
