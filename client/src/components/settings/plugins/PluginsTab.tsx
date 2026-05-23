import { useState } from "react";
import { Button, DialogTrigger } from "react-aria-components";
import { Plus, Loader2 } from "lucide-react";
import type { PluginRecord } from "@roubo/shared";
import { usePlugins } from "../../../hooks/usePlugins";
import PluginCard from "./PluginCard";
import InstallPluginDialog from "./InstallPluginDialog";

function partition(plugins: PluginRecord[]) {
  const bundled = plugins.filter((p) => p.source === "bundled");
  const user = plugins.filter((p) => p.source === "user");
  return { bundled, user };
}

export default function PluginsTab() {
  const { data, isLoading, error } = usePlugins();
  const [installOpen, setInstallOpen] = useState(false);

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Plugins</h3>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
            Integrations that fetch issues into Roubo. Bundled plugins ship with the app;
            third-party plugins live under <span className="font-mono">~/.roubo/plugins/</span>.
          </p>
        </div>
        <DialogTrigger isOpen={installOpen} onOpenChange={setInstallOpen}>
          <Button
            data-testid="install-plugin"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <Plus size={13} />
            Install plugin
          </Button>
          <InstallPluginDialog />
        </DialogTrigger>
      </header>

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
          <Loader2 size={14} className="animate-spin" />
          Loading plugins...
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300"
        >
          Failed to load plugins: {(error as Error).message}
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
      <section aria-label="Bundled plugins" className="space-y-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
          Bundled
        </h4>
        {bundled.length === 0 ? (
          <p className="text-xs text-stone-500 dark:text-stone-400">No bundled plugins found.</p>
        ) : (
          <div className="space-y-3">
            {bundled.map((p) => (
              <PluginCard key={p.id} plugin={p} hostApiVersion={hostApiVersion} />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Third-party plugins" className="space-y-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
          Third-party
        </h4>
        {user.length === 0 ? (
          <div className="rounded-xl border border-dashed border-stone-200 dark:border-stone-800 px-4 py-6 text-center">
            <p className="text-xs text-stone-500 dark:text-stone-400">
              No third-party plugins installed yet.
            </p>
            <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-600">
              Click <span className="font-medium">Install plugin</span> to add one from a Git URL or
              local directory.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {user.map((p) => (
              <PluginCard key={p.id} plugin={p} hostApiVersion={hostApiVersion} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
