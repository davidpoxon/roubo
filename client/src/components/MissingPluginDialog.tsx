import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { AlertTriangle, Download, Store } from "lucide-react";
import type {
  InstallPreview,
  MissingPluginResolution,
  MissingPluginSourceOffer,
} from "@roubo/shared";
import { ApiError } from "../lib/api";
import {
  useInstallPluginCancel,
  useInstallPluginConfirm,
  useInstallPluginPreview,
} from "../hooks/usePlugins";
import { useMarketplaceInstallPreview } from "../hooks/useMarketplace";
import { useToast } from "../hooks/useToast";
import { PermissionsScreen, SourceScreen } from "./settings/plugins/install-screens";
import {
  initialSourceStep,
  type PermissionsStep,
  type SourceStep,
  type SourceTab,
} from "./settings/plugins/install-screens-state";

const STRINGS = {
  title: "Plugin needed for this project",
  descriptionPrefix: "This project's ",
  descriptionRoubo: "roubo.yaml",
  descriptionReferences: " references plugin ",
  promptDescriptionSuffix:
    ", which isn't installed locally. Install it to load issues, or skip for now and load the project without it.",
  sourceDescriptionSuffix:
    ", which isn't installed locally. Provide a Git URL or local directory to install it, or skip for now.",
  suggestedSourceHeading: "Suggested source",
  skipForNow: "Skip for now",
  useDifferentSource: "Use a different source",
  chooseASource: "Choose a source",
  inspecting: "Inspecting...",
  installFromPrefix: "Install from ",
  install: "Install",
  installFailedFallback: "Install failed.",
  installFromSourceFallback: "Couldn't install from that source.",
  enterGitUrl: "Enter the Git URL of a plugin repository.",
  enterLocalPath: "Enter the absolute path to a local plugin directory.",
  installedToast: (name: string) => `Installed ${name}.`,
  // Marketplace-resolved missing plugin (CPHMTP-FR-008, issue #566).
  componentTitle: "Plugin needed for this component",
  componentDescriptionPrefix: "Component ",
  componentDescriptionBinds: " binds plugin ",
  singleSourceSuffix:
    ", which isn't installed locally. It's available from the marketplace source below.",
  ambiguousSuffix:
    ", which isn't installed locally. Two or more sources serve this plugin id, so pick the one to install from.",
  availableFromHeading: "Available from",
  pickASourceHeading: "Choose a source",
  registeredMarker: "registered",
  viewInMarketplace: "View in marketplace",
  installFromSource: (label: string) => `Install from ${label}`,
};

/** The deep-linked Marketplace tab (ProjectSettings pre-selects a tab from the hash). */
const MARKETPLACE_ROUTE = "/settings#marketplace";

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

/**
 * `resolution` switches the dialog from the project-integration flow (install a
 * plugin id from a roubo.yaml-suggested Git URL / local path) to the
 * marketplace-resolved component flow (install a bound component plugin from the
 * marketplace source that serves it, CPHMTP-FR-008, issue #566).
 *
 * The two install paths stay DISTINCT rather than generalised into one, because
 * they are genuinely different operations: `pluginSource` is a raw Git URL or
 * local directory, while a marketplace install names a `sourceId` and goes through
 * the catalog's own preview endpoint. Only the consent step (`PermissionsScreen`)
 * is shared, which is the one part that really is identical.
 *
 * `componentName` names the component whose binding pulled the plugin in, and
 * `onInstalled` is the resume-bench-start hook the caller supplies (CPHMTP-TC-077
 * S003-O02).
 */
export default function MissingPluginDialog({
  projectId,
  pluginId,
  pluginSource,
  resolution,
  componentName,
  onClose,
  onSkip,
  onInstalled,
}: {
  projectId: string;
  pluginId: string;
  pluginSource: string | undefined;
  resolution?: MissingPluginResolution;
  componentName?: string;
  onClose: () => void;
  onSkip: () => void;
  onInstalled?: () => void;
}) {
  return (
    <MissingPluginDialogContent
      projectId={projectId}
      pluginId={pluginId}
      pluginSource={pluginSource}
      resolution={resolution}
      componentName={componentName}
      onClose={onClose}
      onSkip={onSkip}
      onInstalled={onInstalled}
    />
  );
}

function MissingPluginDialogContent({
  projectId,
  pluginId,
  pluginSource,
  resolution,
  componentName,
  onClose,
  onSkip,
  onInstalled,
}: {
  projectId: string;
  pluginId: string;
  pluginSource: string | undefined;
  resolution?: MissingPluginResolution;
  componentName?: string;
  onClose: () => void;
  onSkip: () => void;
  onInstalled?: () => void;
}) {
  const previewMutation = useInstallPluginPreview();
  const marketplacePreviewMutation = useMarketplaceInstallPreview();
  const confirmMutation = useInstallPluginConfirm();
  const cancelMutation = useInstallPluginCancel();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // A resolution carries the id the SERVER resolved against the catalog, so it is
  // authoritative over the prop wherever one exists: the install and the id on
  // screen must name the same plugin the sources were resolved for, and deriving
  // both from one value is what makes that structural rather than a caller
  // convention.
  const effectivePluginId = resolution?.pluginId ?? pluginId;

  // A resolved marketplace source is its own entry screen: there is no Git URL to
  // suggest and nothing to type, so the prompt IS the source list.
  const [state, setState] = useState<State>(() =>
    resolution || pluginSource
      ? { step: "prompt", error: null }
      : initialSourceStep(detectSourceTab("")),
  );

  const isSubmitting =
    previewMutation.isPending || marketplacePreviewMutation.isPending || confirmMutation.isPending;

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
            error: errorMessage(err, STRINGS.installFromSourceFallback),
          });
        },
      },
    );
  }

  /**
   * Stage an install from ONE named marketplace source. The source is always named
   * explicitly (`sourceId`), including in the single-source case: the server refuses
   * an unnamed install of an ambiguous id, and naming the source the consumer
   * actually pressed is what keeps the install honest either way.
   */
  function handleInstallFromSource(sourceId: string) {
    marketplacePreviewMutation.mutate(
      { id: effectivePluginId, sourceId },
      {
        onSuccess: onPreviewSuccess,
        onError: (err) => {
          setState({
            step: "prompt",
            error: errorMessage(err, STRINGS.installFromSourceFallback),
          });
        },
      },
    );
  }

  function handleViewInMarketplace() {
    void navigate(MARKETPLACE_ROUTE);
    onClose();
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
        error: state.tab === "git" ? STRINGS.enterGitUrl : STRINGS.enterLocalPath,
      });
      return;
    }
    setState({ ...state, error: null });
    previewMutation.mutate(
      { source: state.tab, value },
      {
        onSuccess: onPreviewSuccess,
        onError: (err) => {
          setState({ ...state, error: errorMessage(err, STRINGS.installFailedFallback) });
        },
      },
    );
  }

  function handleConfirm() {
    if (state.step !== "permissions") return;
    confirmMutation.mutate(state.preview.stagingToken, {
      onSuccess: (result) => {
        const name = result.plugin.manifest?.name ?? result.plugin.id;
        addToast(STRINGS.installedToast(name));
        void queryClient.invalidateQueries({ queryKey: ["project-integration", projectId] });
        // Resume whatever the missing plugin blocked (bench start, for the
        // component flow: CPHMTP-TC-077 S003-O02). Fired only after the install is
        // COMMITTED, so the retried start finds the plugin actually installed.
        onInstalled?.();
        onClose();
      },
      onError: (err) => {
        setState({ ...state, error: errorMessage(err, STRINGS.installFailedFallback) });
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
          {state.step === "prompt" && resolution && (
            <MarketplaceSourceScreen
              pluginId={effectivePluginId}
              componentName={componentName}
              resolution={resolution}
              error={state.error}
              installing={marketplacePreviewMutation.isPending}
              onInstallFromSource={handleInstallFromSource}
              onViewInMarketplace={handleViewInMarketplace}
              onSkip={handleSkip}
            />
          )}
          {state.step === "prompt" && !resolution && (
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
              title={STRINGS.title}
              subtitle={
                <>
                  {STRINGS.descriptionPrefix}
                  <span className="font-mono">{STRINGS.descriptionRoubo}</span>
                  {STRINGS.descriptionReferences}
                  <span className="font-mono text-stone-700 dark:text-stone-200">{pluginId}</span>
                  {STRINGS.sourceDescriptionSuffix}
                </>
              }
              cancelLabel={STRINGS.skipForNow}
              submitLabel={STRINGS.install}
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

/** The offered sources, flattened: one for single-source, several for ambiguous. */
function offeredSources(resolution: MissingPluginResolution): MissingPluginSourceOffer[] {
  if (resolution.state === "single-source") return [resolution.source];
  if (resolution.state === "ambiguous") return resolution.sources;
  // `unresolvable` offers nothing: an id no source serves keeps the plain dead end
  // with no install affordance (CPHMTP-TC-082). Callers do not open this dialog at
  // all in that state; returning an empty list keeps the invariant local too.
  return [];
}

/**
 * The marketplace-resolved missing-plugin screen (CPHMTP-FR-008, issue #566).
 *
 * One source renders one primary install action; two or more render one action per
 * source with NO primary among them, which is the whole point of the FR-005
 * no-precedence rule: nothing here may pick a source for the consumer, so the
 * ambiguous case is a flat, equally-weighted list rather than a defaulted button.
 */
function MarketplaceSourceScreen({
  pluginId,
  componentName,
  resolution,
  error,
  installing,
  onInstallFromSource,
  onViewInMarketplace,
  onSkip,
}: {
  pluginId: string;
  componentName: string | undefined;
  resolution: MissingPluginResolution;
  error: string | null;
  installing: boolean;
  onInstallFromSource: (sourceId: string) => void;
  onViewInMarketplace: () => void;
  onSkip: () => void;
}) {
  const sources = offeredSources(resolution);
  const ambiguous = resolution.state === "ambiguous";

  return (
    <>
      <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
        <Heading slot="title" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          {componentName ? STRINGS.componentTitle : STRINGS.title}
        </Heading>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          {componentName ? (
            <>
              {STRINGS.componentDescriptionPrefix}
              <span className="font-mono text-stone-700 dark:text-stone-200">{componentName}</span>
              {STRINGS.componentDescriptionBinds}
            </>
          ) : (
            <>
              {STRINGS.descriptionPrefix}
              <span className="font-mono">{STRINGS.descriptionRoubo}</span>
              {STRINGS.descriptionReferences}
            </>
          )}
          <span className="font-mono text-stone-700 dark:text-stone-200">{pluginId}</span>
          {ambiguous ? STRINGS.ambiguousSuffix : STRINGS.singleSourceSuffix}
        </p>
      </div>

      <div className="px-5 py-4 space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
          {ambiguous ? STRINGS.pickASourceHeading : STRINGS.availableFromHeading}
        </div>

        <div className="space-y-2" data-testid="missing-plugin-source-list">
          {sources.map((source) => (
            <div
              key={source.sourceId}
              className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-[13px] text-stone-800 dark:text-stone-200 truncate">
                  {source.label}
                </div>
                {source.registered && (
                  <div className="text-[11px] text-stone-500 dark:text-stone-400">
                    {STRINGS.registeredMarker}
                  </div>
                )}
              </div>
              <Button
                onPress={() => onInstallFromSource(source.sourceId)}
                isDisabled={installing}
                data-testid={`missing-plugin-install-from-${source.sourceId}`}
                className="inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <Download size={13} />
                {installing ? STRINGS.inspecting : STRINGS.installFromSource(source.label)}
              </Button>
            </div>
          ))}
        </div>

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
          {STRINGS.skipForNow}
        </Button>
        <Button
          onPress={onViewInMarketplace}
          isDisabled={installing}
          data-testid="missing-plugin-view-in-marketplace"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <Store size={13} />
          {STRINGS.viewInMarketplace}
        </Button>
      </div>
    </>
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
          {STRINGS.title}
        </Heading>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          {STRINGS.descriptionPrefix}
          <span className="font-mono">{STRINGS.descriptionRoubo}</span>
          {STRINGS.descriptionReferences}
          <span className="font-mono text-stone-700 dark:text-stone-200">{pluginId}</span>
          {STRINGS.promptDescriptionSuffix}
        </p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {pluginSource && (
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
              {STRINGS.suggestedSourceHeading}
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
          {STRINGS.skipForNow}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            onPress={onUseDifferentSource}
            isDisabled={installing}
            data-testid="missing-plugin-use-different-source"
            className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {pluginSource ? STRINGS.useDifferentSource : STRINGS.chooseASource}
          </Button>
          {pluginSource && (
            <Button
              onPress={onOneClickInstall}
              isDisabled={installing}
              data-testid="missing-plugin-one-click-install"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <Download size={13} />
              {installing
                ? STRINGS.inspecting
                : `${STRINGS.installFromPrefix}${truncateSource(pluginSource)}`}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
