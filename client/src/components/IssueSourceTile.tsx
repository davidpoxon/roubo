import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, DialogTrigger } from "react-aria-components";
import { Plug, AlertTriangle, Download } from "lucide-react";
import type { IntegrationCaptionKey, ProjectIntegrationState } from "@roubo/shared";
import Tile from "./settings/Tile";
import Spinner from "./Spinner";
import SwitchIntegrationDialog from "./SwitchIntegrationDialog";
import PluginConfigureDialog from "./PluginConfigureDialog";
import {
  derivePluginConnectionState,
  primaryActionLabelFor,
} from "./settings/plugins/derivePluginConnectionState";
import { useConnectionStatus } from "../hooks/usePlugins";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
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
  noIssueSource: "No issue source configured yet.",
  noIssueSourceHint: "Choose an installed integration to start pulling issues into this project.",
  chooseIntegration: "Choose integration",
  missingPluginPrefix: "The plugin ",
  missingPluginSuffix: " is referenced by this project but isn't installed locally.",
  installPlugin: "Install plugin",
};

const TRIGGER_BUTTON_CLASS =
  "px-3 py-1.5 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:border-stone-400 dark:hover:border-stone-500 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

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
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-500 dark:text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          {integrationName}
        </span>
        {instance && (
          <span className="text-[11px] font-mono text-stone-500 dark:text-stone-500 truncate max-w-full">
            {instance}
          </span>
        )}
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
                {(values ?? []).map((v, i) => (
                  <span
                    key={`${key}-${i}`}
                    className="px-2 py-0.5 rounded-md text-[11px] font-mono text-stone-600 dark:text-stone-300 bg-stone-100 dark:bg-stone-800/70"
                  >
                    {String(v)}
                  </span>
                ))}
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
            <Button className={TRIGGER_BUTTON_CLASS}>{primaryLabel}</Button>
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
          <Button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950">
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
