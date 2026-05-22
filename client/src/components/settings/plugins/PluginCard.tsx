import { useState } from "react";
import { Button, Tooltip, TooltipTrigger } from "react-aria-components";
import type { PluginRecord } from "@roubo/shared";
import { useDisablePlugin, useEnablePlugin } from "../../../hooks/usePlugins";
import StatusPill from "./StatusPill";
import SourceLabel from "./SourceLabel";
import ErroredBanner from "./ErroredBanner";
import IncompatibleBanner from "./IncompatibleBanner";
import InvalidBanner from "./InvalidBanner";
import ViewLogsDialog from "./ViewLogsDialog";

const TOOLTIP_COMING_SOON = "Ships in a later work unit";

const TOOLTIP_CLASS =
  "bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg";

const ACTION_BUTTON_CLASS =
  "px-2.5 py-1 text-xs font-medium rounded text-stone-600 dark:text-stone-300 not-disabled:hover:bg-stone-100 not-disabled:hover:text-stone-900 dark:not-disabled:hover:bg-stone-800 dark:not-disabled:hover:text-stone-100 disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

interface Props {
  plugin: PluginRecord;
  hostApiVersion: string;
}

export default function PluginCard({ plugin, hostApiVersion }: Props) {
  const [logsOpen, setLogsOpen] = useState(false);
  const enable = useEnablePlugin();
  const disable = useDisablePlugin();

  const displayName = plugin.manifest?.name ?? plugin.id;
  const version = plugin.manifest?.version;
  const description = plugin.manifest?.description;
  const isUser = plugin.source === "user";
  const isEnabled = plugin.status === "enabled";
  const canToggle =
    plugin.status === "enabled" || plugin.status === "disabled" || plugin.status === "errored";
  const togglePending = enable.isPending || disable.isPending;

  return (
    <article
      data-testid="plugin-card"
      data-plugin-id={plugin.id}
      className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/60 p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-stone-900 dark:text-stone-100 truncate">
              {displayName}
            </h3>
            {version && (
              <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                v{version}
              </span>
            )}
          </div>
          <div className="mt-1">
            <SourceLabel source={plugin.source} pluginId={plugin.id} />
          </div>
        </div>
        <StatusPill status={plugin.status} />
      </header>

      {description && (
        <p className="mt-3 text-[13px] text-stone-600 dark:text-stone-400 leading-relaxed">
          {description}
        </p>
      )}

      {plugin.status === "errored" && (
        <div className="mt-3">
          <ErroredBanner pluginId={plugin.id} onViewLogs={() => setLogsOpen(true)} />
        </div>
      )}

      {plugin.status === "incompatible" && plugin.manifest && (
        <div className="mt-3">
          <IncompatibleBanner pluginRange={plugin.manifest.roubo} hostApiVersion={hostApiVersion} />
        </div>
      )}

      {plugin.status === "invalid" && plugin.lastError && (
        <div className="mt-3">
          <InvalidBanner message={plugin.lastError.message} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-1 pt-3 border-t border-stone-100 dark:border-stone-800/60">
        <TooltipTrigger delay={400}>
          <Button isDisabled className={ACTION_BUTTON_CLASS}>
            Configure
          </Button>
          <Tooltip className={TOOLTIP_CLASS}>{TOOLTIP_COMING_SOON}</Tooltip>
        </TooltipTrigger>

        <Button onPress={() => setLogsOpen(true)} className={ACTION_BUTTON_CLASS}>
          View logs
        </Button>

        <Button
          isDisabled={!canToggle || togglePending}
          onPress={() => {
            if (isEnabled) disable.mutate(plugin.id);
            else enable.mutate(plugin.id);
          }}
          className={ACTION_BUTTON_CLASS}
        >
          {togglePending ? "Working..." : isEnabled ? "Disable" : "Enable"}
        </Button>

        {isUser && (
          <TooltipTrigger delay={400}>
            <Button isDisabled className={ACTION_BUTTON_CLASS}>
              Uninstall
            </Button>
            <Tooltip className={TOOLTIP_CLASS}>{TOOLTIP_COMING_SOON}</Tooltip>
          </TooltipTrigger>
        )}
      </div>

      <ViewLogsDialog
        pluginId={plugin.id}
        pluginName={displayName}
        isOpen={logsOpen}
        onClose={() => setLogsOpen(false)}
      />
    </article>
  );
}
