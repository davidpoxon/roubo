import { Button } from "react-aria-components";
import { AlertCircle } from "lucide-react";
import { useRestartPlugin } from "../../../hooks/usePlugins";

const STRINGS = {
  body: "Plugin failed to start after 3 restart attempts. Showing your last successful issue snapshot.",
  restart: "Restart",
  restarting: "Restarting...",
  viewLogs: "View logs",
};

interface Props {
  pluginId: string;
  onViewLogs: () => void;
}

export default function ErroredBanner({ pluginId, onViewLogs }: Props) {
  const restart = useRestartPlugin();
  return (
    <div
      role="alert"
      data-testid="plugin-errored-banner"
      className="flex items-start gap-3 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2.5"
    >
      <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-red-800 dark:text-red-300 leading-relaxed">{STRINGS.body}</p>
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
