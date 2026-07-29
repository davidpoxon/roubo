import { useState } from "react";
import { Button } from "react-aria-components";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import {
  AGENT_TOOL_DEFAULT_AGENT,
  AGENT_TOOL_JIG_NONE,
  BUILTIN_AGENT_PRESETS,
} from "@roubo/shared";
import type { AgentPluginState, AgentToolPreset, JigMeta } from "@roubo/shared";
import { useAgentTools, newAgentToolId } from "../../../hooks/useAgentTools";
import { useToast } from "../../../hooks/useToast";
import { agentDotClass } from "./agent-color";
import AgentToolEditorModal from "./AgentToolEditorModal";

interface Props {
  /** Agents that resolve to a live, consented connection. */
  agents: AgentPluginState[];
  /** The current default agent, if one resolves. */
  defaultAgent?: AgentPluginState;
  jigs: JigMeta[];
}

/** The subtitle line: how the preset binds, and what it overrides. */
function describeParams(preset: AgentToolPreset): string {
  const values = Object.values(preset.params ?? {})
    .filter(
      (value): value is string | number | boolean =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean",
    )
    .map(String)
    .filter((value) => value.length > 0);
  const jig =
    preset.jig === undefined
      ? undefined
      : preset.jig === AGENT_TOOL_JIG_NONE
        ? "no jig"
        : `jig: ${preset.jig}`;
  const parts = [...values, ...(jig ? [jig] : [])];
  return parts.length > 0 ? parts.join(" · ") : "no overrides";
}

function AgentToolRow({
  preset,
  builtin,
  agents,
  defaultAgent,
  onEdit,
  onDelete,
}: {
  preset: AgentToolPreset;
  builtin: boolean;
  agents: AgentPluginState[];
  defaultAgent?: AgentPluginState;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const bindsDefault = preset.agent === AGENT_TOOL_DEFAULT_AGENT;
  // Resolution is done on render, never stored, so a default-agent change
  // re-points every default-bound row on the next paint (AP-TC-031, AP-TC-039,
  // AP-TC-045) while plugin-bound rows stay exactly where they were pinned.
  const resolved = bindsDefault ? defaultAgent : agents.find((a) => a.id === preset.agent);
  const unresolved = resolved === undefined;
  const binding = bindsDefault
    ? `default agent → ${resolved?.name ?? "none"}`
    : (resolved?.name ?? preset.agent);

  return (
    <div
      data-testid="agent-tool-row"
      className="flex items-center gap-3 px-4 py-3 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${agentDotClass(resolved?.id)}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-stone-900 dark:text-stone-200 truncate">
            {preset.name}
          </span>
          {builtin && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-100 dark:bg-stone-800 text-stone-500">
              built-in
            </span>
          )}
        </div>
        <div className="text-[11px] font-mono text-stone-400 dark:text-stone-600 truncate">
          {binding} · {describeParams(preset)}
        </div>
        {unresolved && (
          <div
            data-testid="agent-tool-unresolved"
            className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-500"
          >
            <AlertTriangle size={11} className="shrink-0" />
            {bindsDefault
              ? "No default agent is configured, so this tool cannot launch."
              : `Agent plugin "${preset.agent}" is not installed or not available, so this tool cannot launch.`}
          </div>
        )}
      </div>
      {onEdit && (
        <Button
          onPress={onEdit}
          aria-label={`Edit ${preset.name}`}
          className="p-1.5 rounded-lg text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
        >
          <Pencil size={13} />
        </Button>
      )}
      {onDelete && (
        <Button
          onPress={onDelete}
          aria-label={`Delete ${preset.name}`}
          className="p-1.5 rounded-lg text-stone-400 hover:text-red-500 hover:bg-stone-100 dark:hover:bg-stone-800 outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
        >
          <Trash2 size={13} />
        </Button>
      )}
    </div>
  );
}

/**
 * The Agent tools section of Settings, Jigs (AP-FR-008, AP-FR-009, issue #516).
 *
 * Lists the built-in presets Roubo ships followed by the app-level presets the
 * editor writes. Project-level presets declared in `roubo.yaml tools:` are not
 * listed here: they belong to a project, not to app settings, and surface in
 * that project's bench launch menu instead.
 */
export default function AgentToolsSection({ agents, defaultAgent, jigs }: Props) {
  const { agentTools, saveAgentTool, deleteAgentTool } = useAgentTools();
  const { addToast } = useToast();
  const [editing, setEditing] = useState<{ preset: AgentToolPreset | null } | null>(null);

  const handleSave = (preset: AgentToolPreset) => {
    saveAgentTool({ ...preset, id: preset.id || newAgentToolId() });
    setEditing(null);
    addToast("Agent tool saved.");
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
          Agent tools
        </h3>
        <Button
          onPress={() => setEditing({ preset: null })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
        >
          <Plus size={12} />
          New agent tool
        </Button>
      </div>

      <p className="text-xs text-stone-400 dark:text-stone-600 mb-4 leading-relaxed">
        Named launch presets shown in every bench&apos;s Terminal tab. Built-in presets follow the
        default agent; project presets come from{" "}
        <span className="font-mono text-stone-500 dark:text-stone-500">roubo.yaml</span>.
      </p>

      <div className="flex flex-col gap-2">
        {BUILTIN_AGENT_PRESETS.map((preset) => (
          <AgentToolRow
            key={preset.id}
            preset={preset}
            builtin
            agents={agents}
            defaultAgent={defaultAgent}
          />
        ))}
        {agentTools.map((preset) => (
          <AgentToolRow
            key={preset.id}
            preset={preset}
            builtin={false}
            agents={agents}
            defaultAgent={defaultAgent}
            onEdit={() => setEditing({ preset })}
            onDelete={() => {
              deleteAgentTool(preset.id);
              addToast("Agent tool deleted.");
            }}
          />
        ))}
      </div>

      {editing && (
        <AgentToolEditorModal
          key={editing.preset?.id ?? "new"}
          isOpen
          preset={editing.preset}
          agents={agents}
          {...(defaultAgent && { defaultAgent })}
          jigs={jigs}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </section>
  );
}
