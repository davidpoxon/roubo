import { Link } from "react-router-dom";
import { AlertCircle } from "lucide-react";

// FR-014 / TC-016: cut-list banner shown when /api/projects/:id/issues is
// served from the snapshot cache because the active integration plugin is
// errored or disabled. Sits above the issue list so the user understands why
// the list is frozen and how to repair the plugin.

interface Props {
  pluginName: string;
}

export default function StaleSnapshotBanner({ pluginName }: Props) {
  return (
    <div
      role="status"
      data-testid="stale-snapshot-banner"
      className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2"
    >
      <AlertCircle
        size={14}
        className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden
      />
      <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
        Showing the last successful issue snapshot from {pluginName}. The plugin is currently
        unavailable.{" "}
        <Link
          to="/settings#plugins"
          className="font-medium underline decoration-amber-400 hover:decoration-amber-600 dark:hover:decoration-amber-300 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-sm"
        >
          Manage plugins
        </Link>
      </div>
    </div>
  );
}
