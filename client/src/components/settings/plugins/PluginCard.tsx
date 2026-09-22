import { useState } from "react";
import { Button, Dialog, DialogTrigger, Modal, ModalOverlay, Switch } from "react-aria-components";
import { stampAriaModal } from "../../../lib/aria-modal";
import { Plug, Puzzle } from "lucide-react";
import type { ConnectionStatus, PluginRecord } from "@roubo/shared";
import {
  useConnectionStatus,
  useConsentStatus,
  useDisablePlugin,
  useEnablePlugin,
  useUninstallPlugin,
} from "../../../hooks/usePlugins";
import { useGlobalPluginIntegration } from "../../../hooks/useGlobalPluginIntegration";
import PluginConfigureDialog from "../../PluginConfigureDialog";
import ProvenanceBadge from "../../marketplace/ProvenanceBadge";
import { recordProvenance } from "../../marketplace/plugin-provenance";
import Spinner from "../../Spinner";
import ConnectionStatusPill from "./ConnectionStatusPill";
import ConsentReviewDialog from "./ConsentReviewDialog";
import SourceLabel from "./SourceLabel";
import ErroredBanner from "./ErroredBanner";
import IncompatibleBanner from "./IncompatibleBanner";
import InvalidBanner from "./InvalidBanner";
import IsolationNoticeBanner from "./IsolationNoticeBanner";
import ViewLogsDialog from "./ViewLogsDialog";
import UninstallPluginDialog from "./UninstallPluginDialog";
import { derivePluginConnectionState, primaryActionLabelFor } from "./derivePluginConnectionState";

const SECONDARY_BUTTON_CLASS =
  "px-2.5 py-1 text-12 font-medium rounded-control text-text-secondary not-disabled:hover:bg-bg-hover not-disabled:hover:text-text-primary disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

const PRIMARY_BUTTON_CLASS =
  "px-3 py-1 text-12 font-medium rounded-control border border-border-strong bg-bg-surface text-text-primary not-disabled:hover:bg-accent-muted not-disabled:hover:border-accent-border disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

const STRINGS = {
  viewLogs: "View logs",
  reviewPermissions: "Review permissions",
  uninstall: "Uninstall",
  uninstalling: "Uninstalling...",
  enabled: "Enabled",
  disabled: "Disabled",
  versionPrefix: "v",
  loadingConfig: "Loading plugin configuration…",
  configLoadFailed: "Couldn't load plugin configuration",
  configLoadFallback: "Failed to load plugin configuration",
  close: "Close",
  retry: "Retry",
};

interface Props {
  plugin: PluginRecord;
  hostApiVersion: string;
}

export default function PluginCard({ plugin, hostApiVersion }: Props) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const enable = useEnablePlugin();
  const disable = useDisablePlugin();
  const uninstall = useUninstallPlugin();
  const isEnabled = plugin.status === "enabled";
  // For enabled plugins we eagerly fetch the effective integration so the
  // chip and primary-action label reflect credential state on first paint.
  // Disabled plugins always derive to "Connect" without a fetch. The query
  // also re-runs while the Configure dialog is open (existing dialog needs
  // the same data).
  const integrationQuery = useGlobalPluginIntegration(plugin.id, isEnabled || configureOpen);
  // Live connection-status probe. Disabled plugins skip the fetch (the server
  // short-circuits to `{ state: "disabled" }` anyway). Opportunistic prefetches
  // from `PluginsTab` / `PluginConfigureDialog` populate the same query key.
  const connectionQuery = useConnectionStatus(plugin.id, isEnabled);

  // #938, widened by #1026: component AND agent plugins are consent-gated
  // (the server refuses to start a bench-bound component, or to resolve an agent
  // for launch, whose plugin has no ConsentRecord). Integration plugins are never
  // gated, so fetch consent (and offer the affordance) for those two kinds only.
  // `consentedAt` absent means the plugin is unconsented.
  const kind = plugin.manifest?.kind;
  const isConsentGated = kind === "component" || kind === "agent";
  const consentQuery = useConsentStatus(plugin.id, isConsentGated);
  const consentStatus = consentQuery.data;
  const needsConsent = isConsentGated && consentStatus !== undefined && !consentStatus.consentedAt;

  const provenance = recordProvenance(plugin);
  const displayName = plugin.manifest?.name ?? plugin.id;
  const version = plugin.manifest?.version;
  const description = plugin.manifest?.description;
  const isUser = plugin.source === "user";
  const canToggle =
    plugin.status === "enabled" || plugin.status === "disabled" || plugin.status === "errored";
  const togglePending = enable.isPending || disable.isPending;

  const connectionState = derivePluginConnectionState(
    plugin.status,
    integrationQuery.data?.effective,
    connectionQuery.data,
  );
  const primaryLabel = primaryActionLabelFor(connectionState);
  const pillStatus: ConnectionStatus = {
    state: connectionState,
    detail: connectionQuery.data?.detail,
    checkedAt: connectionQuery.data?.checkedAt,
  };
  // Acceptance criterion 2: pressing Connect on a disabled bundled plugin
  // both enables it and opens the Configure modal in the same gesture.
  // DialogTrigger handles the open; we only own the side effect.
  const primaryEnablesPlugin = plugin.status === "disabled";

  function handlePrimaryPress() {
    if (primaryEnablesPlugin) enable.mutate(plugin.id);
  }

  function handleSwitchChange(selected: boolean) {
    if (selected) enable.mutate(plugin.id);
    else disable.mutate(plugin.id);
  }

  return (
    <article
      data-testid="plugin-card"
      data-plugin-id={plugin.id}
      className="rounded-xl border border-border bg-bg-surface p-4 transition-colors hover:border-border-strong"
    >
      <header className="flex items-start gap-3">
        <PluginIcon plugin={plugin} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="text-14 font-semibold text-text-primary truncate">{displayName}</h3>
            {version && (
              <span className="font-mono text-11 text-text-secondary">
                {STRINGS.versionPrefix}
                {version}
              </span>
            )}
          </div>
          {/*
            SourceLabel says where the plugin lives on THIS machine (bundled with
            the app, or unpacked under ~/.roubo/plugins); the badge says which
            marketplace source served it and at what trust level (CPHMTP-FR-006,
            #977). Different facts, so both render: the installed tab is one
            of the surfaces the persistent Unverified badge must reach, and an
            orphaned plugin (its source deregistered) is flagged here too.
          */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <SourceLabel source={plugin.source} pluginId={plugin.id} />
            <ProvenanceBadge provenance={provenance} />
          </div>
        </div>
        <ConnectionStatusPill status={pillStatus} rechecking={connectionQuery.isFetching} />
      </header>

      {description && (
        <p className="mt-3 text-13 text-text-secondary leading-relaxed line-clamp-2">
          {description}
        </p>
      )}

      {plugin.status === "errored" && (
        <div className="mt-3">
          <ErroredBanner
            pluginId={plugin.id}
            lastError={plugin.lastError}
            kind={plugin.manifest?.kind}
            provenance={provenance}
            onViewLogs={() => setLogsOpen(true)}
          />
        </div>
      )}

      {plugin.status === "incompatible" && plugin.manifest && (
        <div className="mt-3">
          <IncompatibleBanner pluginRange={plugin.manifest.roubo} hostApiVersion={hostApiVersion} />
        </div>
      )}

      {/* An incompatible record with NO manifest: the manifest declared a key this
          host does not know, so the strict parse never produced one and the host
          reported the declared range instead (#1118). There is no range to
          hand IncompatibleBanner, but lastError.message already names the required
          Roubo version, so it is rendered rather than left silent. */}
      {plugin.status === "incompatible" && !plugin.manifest && plugin.lastError && (
        <div className="mt-3">
          <InvalidBanner message={plugin.lastError.message} />
        </div>
      )}

      {plugin.status === "invalid" && plugin.lastError && (
        <div className="mt-3">
          <InvalidBanner message={plugin.lastError.message} />
        </div>
      )}

      {plugin.isolationNotices && plugin.isolationNotices.length > 0 && (
        <div className="mt-3">
          <IsolationNoticeBanner
            notices={plugin.isolationNotices}
            pluginId={plugin.id}
            source={plugin.source}
          />
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 pt-3 border-t border-border">
        <EnableSwitch
          isEnabled={isEnabled}
          isDisabled={!canToggle || togglePending}
          onChange={handleSwitchChange}
        />

        <div className="flex items-center gap-1">
          <Button onPress={() => setLogsOpen(true)} className={SECONDARY_BUTTON_CLASS}>
            {STRINGS.viewLogs}
          </Button>

          {needsConsent && (
            <Button onPress={() => setConsentOpen(true)} className={SECONDARY_BUTTON_CLASS}>
              {STRINGS.reviewPermissions}
            </Button>
          )}

          {isUser && (
            <DialogTrigger isOpen={uninstallOpen} onOpenChange={setUninstallOpen}>
              <Button isDisabled={uninstall.isPending} className={SECONDARY_BUTTON_CLASS}>
                {uninstall.isPending ? STRINGS.uninstalling : STRINGS.uninstall}
              </Button>
              <UninstallPluginDialog
                pluginName={displayName}
                onConfirm={() => uninstall.mutate(plugin.id)}
                isPending={uninstall.isPending}
              />
            </DialogTrigger>
          )}

          <DialogTrigger isOpen={configureOpen} onOpenChange={setConfigureOpen}>
            <Button
              onPress={handlePrimaryPress}
              isDisabled={!plugin.manifest}
              className={PRIMARY_BUTTON_CLASS}
            >
              {primaryLabel}
            </Button>
            {integrationQuery.isError ? (
              <ConfigureErrorDialog
                error={integrationQuery.error}
                onRetry={() => {
                  void integrationQuery.refetch();
                }}
              />
            ) : integrationQuery.data ? (
              <PluginConfigureDialog
                scope="global"
                plugin={integrationQuery.data.plugin}
                effective={integrationQuery.data.effective}
              />
            ) : (
              <ConfigureLoadingDialog />
            )}
          </DialogTrigger>
        </div>
      </div>

      <ViewLogsDialog
        pluginId={plugin.id}
        pluginName={displayName}
        isOpen={logsOpen}
        onClose={() => setLogsOpen(false)}
      />

      {consentOpen && needsConsent && consentStatus && (
        <ConsentReviewDialog
          pluginId={plugin.id}
          pluginName={displayName}
          declared={consentStatus.declared}
          provenance={provenance}
          version={version}
          onClose={() => setConsentOpen(false)}
        />
      )}
    </article>
  );
}

function PluginIcon({ plugin }: { plugin: PluginRecord }) {
  const icon = plugin.manifest?.icon;
  // Bundled plugins ship `data:` URIs; path-based icons aren't served by the
  // host today.
  const usable = typeof icon === "string" && icon.startsWith("data:");
  if (usable) {
    return (
      <img
        src={icon}
        alt=""
        data-testid="plugin-icon"
        className="h-8 w-8 shrink-0 rounded-md"
        width={32}
        height={32}
      />
    );
  }
  const Fallback = plugin.source === "user" ? Puzzle : Plug;
  return (
    <div
      data-testid="plugin-icon-fallback"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-text-body"
    >
      <Fallback size={16} aria-hidden />
    </div>
  );
}

function EnableSwitch({
  isEnabled,
  isDisabled,
  onChange,
}: {
  isEnabled: boolean;
  isDisabled: boolean;
  onChange: (selected: boolean) => void;
}) {
  return (
    <Switch
      isSelected={isEnabled}
      isDisabled={isDisabled}
      onChange={onChange}
      data-testid="plugin-enable-switch"
      className={`group flex items-center gap-2 outline-none ${isDisabled ? "opacity-40" : ""}`}
    >
      {({ isFocusVisible }) => (
        <>
          <div
            className={[
              "relative shrink-0 w-9 h-5 rounded-full border transition-colors",
              isEnabled ? "bg-accent border-accent" : "bg-transparent border-border-control",
              isFocusVisible ? "ring-2 ring-focus-ring ring-offset-2 ring-offset-bg-base" : "",
            ].join(" ")}
          >
            <div
              className={[
                "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-colors",
                isEnabled ? "left-[18px] bg-bg-surface" : "left-0.5 bg-border-control",
              ].join(" ")}
            />
          </div>
          <span className="text-12 font-medium text-text-body">
            {isEnabled ? STRINGS.enabled : STRINGS.disabled}
          </span>
        </>
      )}
    </Switch>
  );
}

function ConfigureLoadingDialog() {
  return (
    <ModalOverlay className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm">
      <Modal className="animate-rise-in w-full max-w-sm mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none px-5 py-6"
        >
          <div role="status" className="flex items-center gap-2 text-12 text-text-secondary">
            <Spinner />
            {STRINGS.loadingConfig}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function ConfigureErrorDialog({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : STRINGS.configLoadFallback;
  return (
    <ModalOverlay className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm">
      <Modal className="animate-rise-in w-full max-w-sm mx-4">
        <Dialog
          ref={stampAriaModal}
          role="alertdialog"
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none px-5 py-6"
        >
          {({ close }) => (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-16 font-medium text-text-primary">
                  {STRINGS.configLoadFailed}
                </h2>
                <p className="mt-2 text-12 text-text-secondary break-words">{message}</p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button onPress={close} className={SECONDARY_BUTTON_CLASS}>
                  {STRINGS.close}
                </Button>
                <Button onPress={onRetry} className={SECONDARY_BUTTON_CLASS}>
                  {STRINGS.retry}
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
