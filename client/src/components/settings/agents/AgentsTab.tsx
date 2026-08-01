import { Loader2 } from "lucide-react";
import { useAgentPlugins } from "../../../hooks/useAgentPlugins";
import AgentPluginCard from "./AgentPluginCard";
import AgentMigrationNotice from "./AgentMigrationNotice";

const STRINGS = {
  heading: "AI Agents",
  description:
    "AI coding agents you can launch benches with. Each installed agent plugin keeps its own application-level defaults, saved to ",
  descriptionSuffix: ". Projects inherit these defaults.",
  agentsDir: "~/.roubo/agents/_global/",
  loading: "Loading agents...",
  loadFailedPrefix: "Failed to load agents: ",
  installedHeading: "Installed",
  installedAriaLabel: "Installed agent plugins",
  emptyTitle: "No agent plugins installed yet.",
  emptyBodyPrefix: "Install one from the ",
  emptyBodyLink: "Marketplace",
  emptyBodySuffix: " tab to configure its defaults here.",
};

/**
 * Settings > AI Agents (AP-FR-002, AP-FR-003, issue #508).
 *
 * Lists every installed `agent`-kind plugin, each with its own schema-driven
 * config form. With no agent plugins installed the screen renders a usable
 * empty state pointing at the marketplace rather than an error or a blank
 * panel (AP-TC-012).
 */
export default function AgentsTab() {
  const { data, isLoading, error } = useAgentPlugins();
  const agents = data?.agents ?? [];

  return (
    <div className="space-y-8">
      <header>
        <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          {STRINGS.heading}
        </h3>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
          {STRINGS.description}
          <span className="font-mono">{STRINGS.agentsDir}</span>
          {STRINGS.descriptionSuffix}
        </p>
      </header>

      <AgentMigrationNotice />

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
          <Loader2 size={14} className="animate-spin" />
          {STRINGS.loading}
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

      {data && (
        <section aria-label={STRINGS.installedAriaLabel} className="space-y-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
            {STRINGS.installedHeading}
          </h4>

          {agents.length === 0 ? (
            <div
              data-testid="agents-empty-state"
              className="rounded-xl border border-dashed border-stone-200 dark:border-stone-800 px-4 py-6 text-center"
            >
              <p className="text-xs text-stone-500 dark:text-stone-400">{STRINGS.emptyTitle}</p>
              <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">
                {STRINGS.emptyBodyPrefix}
                <span className="font-medium">{STRINGS.emptyBodyLink}</span>
                {STRINGS.emptyBodySuffix}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-4">
              {agents.map((agent) => (
                <AgentPluginCard key={agent.id} agent={agent} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
