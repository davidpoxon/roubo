import { useMemo, useState } from "react";
import { Button, DialogTrigger } from "react-aria-components";
import { Plus, Loader2 } from "lucide-react";
import type { PluginRecord } from "@roubo/shared";
import { usePlugins, useOpportunisticRecheckOnMount } from "../../../hooks/usePlugins";
import PluginCard from "./PluginCard";
import InstallPluginDialog from "./InstallPluginDialog";

const STRINGS = {
  heading: "Plugins",
  descriptionPrefix:
    "Integrations that fetch issues into Roubo. Bundled plugins ship with the app; third-party plugins live under ",
  descriptionSuffix: ".",
  pluginsDir: "~/.roubo/plugins/",
  installCta: "Install plugin",
  loadingPlugins: "Loading plugins...",
  loadFailedPrefix: "Failed to load plugins: ",
  bundledHeading: "Bundled",
  thirdPartyHeading: "Third-party",
  bundledAriaLabel: "Bundled plugins",
  thirdPartyAriaLabel: "Third-party plugins",
  noBundled: "No bundled plugins found.",
  noThirdParty: "No third-party plugins installed yet.",
  thirdPartyHintPrefix: "Click ",
  thirdPartyHintCta: "Install plugin",
  thirdPartyHintSuffix: " to add one from a Git URL or local directory.",
};

function partition(plugins: PluginRecord[]) {
  const bundled = plugins.filter((p) => p.source === "bundled");
  const user = plugins.filter((p) => p.source === "user");
  return { bundled, user };
}

export default function PluginsTab() {
  const { data, isLoading, error } = usePlugins();
  const [installOpen, setInstallOpen] = useState(false);

  // WU-050: opening the tab triggers a fresh connection-status re-check for
  // every enabled plugin. Disabled plugins are skipped per FR-054.
  const enabledIds = useMemo(
    () => (data?.plugins ?? []).filter((p) => p.status === "enabled").map((p) => p.id),
    [data],
  );
  useOpportunisticRecheckOnMount(enabledIds);

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {STRINGS.heading}
          </h3>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
            {STRINGS.descriptionPrefix}
            <span className="font-mono">{STRINGS.pluginsDir}</span>
            {STRINGS.descriptionSuffix}
          </p>
        </div>
        <DialogTrigger isOpen={installOpen} onOpenChange={setInstallOpen}>
          <Button
            data-testid="install-plugin"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <Plus size={13} />
            {STRINGS.installCta}
          </Button>
          <InstallPluginDialog />
        </DialogTrigger>
      </header>

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
          <Loader2 size={14} className="animate-spin" />
          {STRINGS.loadingPlugins}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300"
        >
          {STRINGS.loadFailedPrefix}
          {(error as Error).message}
        </div>
      )}

      {data && <PluginList plugins={data.plugins} hostApiVersion={data.hostApiVersion} />}
    </div>
  );
}

function PluginList({
  plugins,
  hostApiVersion,
}: {
  plugins: PluginRecord[];
  hostApiVersion: string;
}) {
  const { bundled, user } = partition(plugins);
  return (
    <>
      <section aria-label={STRINGS.bundledAriaLabel} className="space-y-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
          {STRINGS.bundledHeading}
        </h4>
        {bundled.length === 0 ? (
          <p className="text-xs text-stone-500 dark:text-stone-400">{STRINGS.noBundled}</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-4">
            {bundled.map((p) => (
              <PluginCard key={p.id} plugin={p} hostApiVersion={hostApiVersion} />
            ))}
          </div>
        )}
      </section>

      <section aria-label={STRINGS.thirdPartyAriaLabel} className="space-y-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
          {STRINGS.thirdPartyHeading}
        </h4>
        {user.length === 0 ? (
          <div className="rounded-xl border border-dashed border-stone-200 dark:border-stone-800 px-4 py-6 text-center">
            <p className="text-xs text-stone-500 dark:text-stone-400">{STRINGS.noThirdParty}</p>
            <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-600">
              {STRINGS.thirdPartyHintPrefix}
              <span className="font-medium">{STRINGS.thirdPartyHintCta}</span>
              {STRINGS.thirdPartyHintSuffix}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-4">
            {user.map((p) => (
              <PluginCard key={p.id} plugin={p} hostApiVersion={hostApiVersion} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
