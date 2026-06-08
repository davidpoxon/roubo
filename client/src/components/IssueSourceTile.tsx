import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, DialogTrigger } from "react-aria-components";
import { Plug, AlertTriangle, Download } from "lucide-react";
import type { IntegrationCaptionKey, ProjectIntegrationState } from "@roubo/shared";
import Tile from "./settings/Tile";
import Spinner from "./Spinner";
import SwitchIntegrationDialog from "./SwitchIntegrationDialog";
import PluginConfigureDialog from "./PluginConfigureDialog";
import ConnectionStatusPill from "./settings/plugins/ConnectionStatusPill";
import {
  derivePluginConnectionState,
  primaryActionLabelFor,
} from "./settings/plugins/derivePluginConnectionState";
import { useConnectionStatus } from "../hooks/usePlugins";
import {
  useProjectIntegration,
  usePromoteProjectIntegration,
} from "../hooks/useProjectIntegration";
import { ApiError } from "../lib/api";
import { titleCase } from "../lib/title-case";

const CAPTION_TEXT: Record<IntegrationCaptionKey, string> = {
  "yaml-only": "Configuration from roubo.yaml",
  "override-only": "Configuration from your override; roubo.yaml has no integration block",
  "yaml-and-override": "Configuration merged from roubo.yaml and your override",
  none: "",
};

const STRINGS = {
  defaultTitle: "Source",
  secondary: "The integration that supplies this project's issues",
  loading: "Loading…",
  loadFailedPrefix: "Failed to load integration: ",
  unknownError: "unknown error",
  noSources: "No sources selected yet.",
  switchIntegration: "Switch integration",
  updateRouboYaml: "Update roubo.yaml",
  updatingRouboYaml: "Updating…",
  promoteFailedFallback: "Failed to update roubo.yaml",
  mismatchLead: "This project's ",
  mismatchRoubo: "roubo.yaml",
  mismatchTrailing: ".",
  noInstance: "no host",
  // Same sentence shape for both divergence axes; only the verbs and the
  // highlighted value (plugin id vs instance host) change.
  mismatchPlugin: {
    specifies: " specifies ",
    active: ", but the active integration is ",
    teammates: ". Teammates who clone the repo will get ",
  },
  mismatchInstance: {
    specifies: " points at ",
    active: ", but the active integration uses ",
    teammates: ". Teammates who clone the repo will connect to ",
  },
  noIssueSource: "No issue source configured yet.",
  noIssueSourceHint: "Choose an installed integration to start pulling issues into this project.",
  chooseIntegration: "Choose integration",
  missingPluginPrefix: "The plugin ",
  missingPluginSuffix: " is referenced by this project but isn't installed locally.",
  installPlugin: "Install plugin",
};

const TRIGGER_BUTTON_CLASS =
  "px-3 py-1.5 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:border-stone-400 dark:hover:border-stone-500 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

function IntegrationMismatchBanner({
  projectId,
  mismatch,
}: {
  projectId: string;
  mismatch: NonNullable<ProjectIntegrationState["integrationMismatch"]>;
}) {
  const promote = usePromoteProjectIntegration(projectId);
  const errorMessage = promote.isError
    ? promote.error instanceof ApiError || promote.error instanceof Error
      ? promote.error.message
      : STRINGS.promoteFailedFallback
    : null;

  // Plugin drift is the headline; when the plugin id agrees, the divergence is
  // the instance (which host the same plugin talks to).
  const pluginDiffers = mismatch.committedPlugin !== mismatch.effectivePlugin;
  const copy = pluginDiffers ? STRINGS.mismatchPlugin : STRINGS.mismatchInstance;
  const committedValue = pluginDiffers
    ? mismatch.committedPlugin
    : (mismatch.committedInstance ?? STRINGS.noInstance);
  const effectiveValue = pluginDiffers
    ? mismatch.effectivePlugin
    : (mismatch.effectiveInstance ?? STRINGS.noInstance);

  return (
    <div
      data-testid="issue-source-integration-mismatch"
      className="flex flex-col gap-2.5 p-3 rounded-md bg-amber-500/10 border border-amber-500/20"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[12px] leading-relaxed text-stone-700 dark:text-stone-300">
          {STRINGS.mismatchLead}
          <span className="font-mono">{STRINGS.mismatchRoubo}</span>
          {copy.specifies}
          <span className="font-mono text-stone-900 dark:text-stone-100">{committedValue}</span>
          {copy.active}
          <span className="font-mono text-stone-900 dark:text-stone-100">{effectiveValue}</span>
          {copy.teammates}
          <span className="font-mono text-stone-900 dark:text-stone-100">{committedValue}</span>
          {STRINGS.mismatchTrailing}
        </p>
      </div>
      <div className="flex items-center gap-2 pl-6">
        <Button
          isDisabled={promote.isPending}
          onPress={() => promote.mutate()}
          data-testid="issue-source-promote"
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-amber-500/40 text-amber-700 dark:text-amber-300 hover:border-amber-500/70 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {promote.isPending ? STRINGS.updatingRouboYaml : STRINGS.updateRouboYaml}
        </Button>
        {errorMessage && (
          <span role="alert" className="text-[11px] text-red-400">
            {errorMessage}
          </span>
        )}
      </div>
    </div>
  );
}

function ConfiguredBody({
  projectId,
  state,
}: {
  projectId: string;
  // The "configured" variant only renders when `plugin` is non-null and
  // installed, so this prop carries a narrowed plugin type.
  state: ProjectIntegrationState & { plugin: NonNullable<ProjectIntegrationState["plugin"]> };
}) {
  const { plugin } = state;
  const integrationName = plugin.manifest?.name ?? plugin.id;
  const instance = state.effective.instance;
  const sources = state.effective.sources ?? {};
  const caption = CAPTION_TEXT[state.captionKey];

  const [switchOpen, setSwitchOpen] = useState(false);
  const [configureOpen, setConfigureOpen] = useState(false);

  // WU-058 (FR-072): the per-project tile shows one context-aware primary
  // action that flips Connect / Configure / Sign in again with the plugin's
  // connection state. The same modal opens in every case; source selection
  // lives inside it, so the legacy "Choose sources" button is gone.
  const connectionQuery = useConnectionStatus(plugin.id, plugin.status === "enabled");
  const connectionState = derivePluginConnectionState(
    plugin.status,
    state.effective,
    connectionQuery.data,
  );
  const primaryLabel = primaryActionLabelFor(connectionState);

  return (
    <div className="space-y-4">
      {state.integrationMismatch && (
        <IntegrationMismatchBanner projectId={projectId} mismatch={state.integrationMismatch} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-500 dark:text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          {integrationName}
        </span>
        {instance && (
          <span
            data-testid="issue-source-instance"
            className="text-[11px] font-mono text-stone-500 dark:text-stone-500 truncate max-w-full"
          >
            {instance}
          </span>
        )}
        <ConnectionStatusPill
          status={{
            state: connectionState,
            detail: connectionQuery.data?.detail,
            checkedAt: connectionQuery.data?.checkedAt,
          }}
          rechecking={connectionQuery.isFetching}
        />
      </div>

      {Object.keys(sources).length === 0 ? (
        <p className="text-xs text-stone-400 dark:text-stone-600">{STRINGS.noSources}</p>
      ) : (
        <dl className="space-y-2">
          {Object.entries(sources).map(([key, values]) => (
            <div key={key} className="flex flex-col gap-1.5">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
                {titleCase(key)}
              </dt>
              <dd className="flex flex-wrap gap-1.5">
                {(values ?? []).map((v, i) => {
                  // Prefer the display label captured at pick time; the raw id /
                  // sublabel becomes the mono secondary line beneath it.
                  const primary = typeof v === "object" ? (v.label ?? v.externalId) : String(v);
                  const secondary =
                    typeof v === "object"
                      ? v.label
                        ? (v.sublabel ?? v.externalId)
                        : v.sublabel
                      : undefined;
                  return (
                    <span
                      key={`${key}-${i}`}
                      className="flex flex-col gap-0.5 px-2 py-0.5 rounded-md text-[11px] text-stone-600 dark:text-stone-300 bg-stone-100 dark:bg-stone-800/70"
                    >
                      <span>{primary}</span>
                      {secondary && (
                        <span className="font-mono text-stone-400 dark:text-stone-600">
                          {secondary}
                        </span>
                      )}
                    </span>
                  );
                })}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {caption && (
        <p className="text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">{caption}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <DialogTrigger isOpen={switchOpen} onOpenChange={setSwitchOpen}>
          <Button className={TRIGGER_BUTTON_CLASS}>{STRINGS.switchIntegration}</Button>
          <SwitchIntegrationDialog projectId={projectId} currentPluginId={plugin.id} />
        </DialogTrigger>
        {plugin.manifest && (
          <DialogTrigger isOpen={configureOpen} onOpenChange={setConfigureOpen}>
            <Button data-testid="issue-source-primary-action" className={TRIGGER_BUTTON_CLASS}>
              {primaryLabel}
            </Button>
            <PluginConfigureDialog
              scope="project"
              projectId={projectId}
              plugin={plugin}
              effective={state.effective}
            />
          </DialogTrigger>
        )}
      </div>
    </div>
  );
}

function UnconfiguredBody({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-600 dark:text-stone-400">{STRINGS.noIssueSource}</p>
      <p className="text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
        {STRINGS.noIssueSourceHint}
      </p>
      <div>
        <DialogTrigger isOpen={open} onOpenChange={setOpen}>
          <Button
            data-testid="issue-source-choose-integration"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
          >
            <Plug size={12} />
            {STRINGS.chooseIntegration}
          </Button>
          <SwitchIntegrationDialog projectId={projectId} currentPluginId={null} />
        </DialogTrigger>
      </div>
    </div>
  );
}

function MissingPluginBody({ pluginId }: { pluginId: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-sm text-stone-700 dark:text-stone-300 leading-relaxed">
          {STRINGS.missingPluginPrefix}
          <span className="font-mono text-stone-900 dark:text-stone-100">{pluginId}</span>
          {STRINGS.missingPluginSuffix}
        </p>
      </div>
      <Link
        to="/settings/plugins"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
      >
        <Download size={12} />
        {STRINGS.installPlugin}
      </Link>
    </div>
  );
}

export default function IssueSourceTile({
  projectId,
  title = STRINGS.defaultTitle,
}: {
  projectId: string;
  title?: string;
}) {
  const { data, isLoading, isError, error } = useProjectIntegration(projectId);

  const variant = (() => {
    if (!data) return "loading";
    if (!data.plugin) return "unconfigured";
    if (!data.plugin.installed) return "missing-plugin";
    return "configured";
  })();

  return (
    <Tile
      icon={<Plug size={13} aria-hidden />}
      title={title}
      secondary={STRINGS.secondary}
      data-testid="issue-source-tile"
    >
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
          <Spinner />
          {STRINGS.loading}
        </div>
      )}

      {isError && (
        <p role="alert" className="text-sm text-red-400">
          {STRINGS.loadFailedPrefix}
          {error instanceof Error ? error.message : STRINGS.unknownError}
        </p>
      )}

      {!isLoading && !isError && variant === "configured" && data?.plugin && (
        <ConfiguredBody
          projectId={projectId}
          state={
            data as ProjectIntegrationState & {
              plugin: NonNullable<ProjectIntegrationState["plugin"]>;
            }
          }
        />
      )}
      {!isLoading && !isError && variant === "unconfigured" && (
        <UnconfiguredBody projectId={projectId} />
      )}
      {!isLoading && !isError && variant === "missing-plugin" && data?.plugin && (
        <MissingPluginBody pluginId={data.plugin.id} />
      )}
    </Tile>
  );
}
