import { Button } from "react-aria-components";
import { AlertCircle } from "lucide-react";
import type { PluginError, PluginManifest } from "@roubo/shared";
import { useRestartPlugin } from "../../../hooks/usePlugins";

const STRINGS = {
  // Shown only for integration plugins, which fall back to a cached snapshot
  // when their process cannot start. Component plugins have no such fallback.
  snapshotNotice: "Showing your last successful issue snapshot.",
  // Defensive fallback for an errored plugin with no structured lastError.
  genericError: "Plugin failed to start.",
  restart: "Restart",
  restarting: "Restarting...",
  viewLogs: "View logs",
};

interface Props {
  pluginId: string;
  lastError: PluginError | null;
  kind: PluginManifest["kind"] | undefined;
  onViewLogs: () => void;
}

export default function ErroredBanner({ pluginId, lastError, kind, onViewLogs }: Props) {
  const restart = useRestartPlugin();
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
          <Button
            onPress={onViewLogs}
            className="px-2 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {STRINGS.viewLogs}
          </Button>
        </div>
      </div>
    </div>
  );
}
