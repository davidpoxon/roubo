import { Link } from "react-router";
import { AlertCircle } from "lucide-react";

// IP-FR-014 / IP-TC-016: cut-list banner shown when /api/projects/:id/issues is
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
      className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-accent-border bg-accent-muted px-3 py-2"
    >
      <AlertCircle size={14} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
      <div className="min-w-0 flex-1 text-12 leading-relaxed text-accent-text">
        Showing the last successful issue snapshot from {pluginName}. The plugin is currently
        unavailable.{" "}
        <Link
          to="/settings#plugins"
          className="font-medium underline decoration-accent-border hover:decoration-accent-text transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded-sm"
        >
          Manage plugins
        </Link>
      </div>
    </div>
  );
}
