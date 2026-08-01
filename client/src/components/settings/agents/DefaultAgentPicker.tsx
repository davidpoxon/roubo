import { RadioGroup } from "react-aria-components";
import type { AgentPluginState } from "@roubo/shared";
import DefaultAgentTile from "./DefaultAgentTile";

/**
 * The Settings, Jigs default-agent picker (AP-FR-005, issue #515).
 *
 * Lifted out of `ProjectSettings`'s Jigs tab so the radiogroup can be scanned
 * and driven on its own (AP-TC-050) without mounting the whole settings screen.
 * The markup is the tab's, unchanged: a `RadioGroup` of `DefaultAgentTile`s, or
 * the dashed empty state when no agent is configured yet.
 */
export default function DefaultAgentPicker({
  agents,
  selectedAgentId,
  onChange,
}: {
  /** The configured, launchable agents, in the order the tab lists them. */
  agents: AgentPluginState[];
  /** The current default, or `null` when nothing is selected yet. */
  selectedAgentId: string | null;
  onChange: (pluginId: string) => void;
}) {
  if (agents.length === 0) {
    return (
      <p
        data-testid="default-agent-empty-state"
        className="rounded-lg border border-dashed border-stone-200 dark:border-stone-800 px-4 py-3 text-xs text-stone-500 dark:text-stone-400"
      >
        No configured agents yet. Install and configure one under Settings, AI Agents.
      </p>
    );
  }

  return (
    <RadioGroup
      value={selectedAgentId}
      onChange={onChange}
      aria-label="Default agent"
      className="flex flex-col gap-2"
    >
      {agents.map((agent) => (
        <DefaultAgentTile key={agent.id} agent={agent} />
      ))}
    </RadioGroup>
  );
}
