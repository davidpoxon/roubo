import { useMemo, useState } from "react";
import { Button } from "react-aria-components";
import { Plus, Pencil, Trash2, AlertTriangle, Info } from "lucide-react";
import {
  AGENT_TOOL_DEFAULT_AGENT,
  AGENT_TOOL_JIG_NONE,
  BUILTIN_AGENT_PRESETS,
} from "@roubo/shared";
import type {
  AgentPluginState,
  AgentToolPreset,
  JigMeta,
  ResolvedAgentPreset,
} from "@roubo/shared";
import { useAgentTools, useAppAgentPresets, newAgentToolId } from "../../../hooks/useAgentTools";
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
  degraded,
  onEdit,
  onDelete,
}: {
  preset: AgentToolPreset;
  builtin: boolean;
  agents: AgentPluginState[];
  defaultAgent?: AgentPluginState;
  /** The server's advisory drop notice for this preset, if it reported one. */
  degraded?: ResolvedAgentPreset["degraded"];
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
        {!unresolved && degraded && (
          // Advisory, never a blocker (issue #672): the preset still launches,
          // it just will not do what its name promises, so this is stone rather
          // than the amber the unresolved notice above uses, and it leaves the
          // row's Edit and Delete controls alone. The wording and the Info mark
          // match the launch menu's chip, so both surfaces read the same.
          <div
            data-testid="agent-tool-degraded"
            title={degraded.message}
            className="mt-1 flex items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-400"
          >
            <Info size={11} className="shrink-0" />
            <span aria-hidden="true">drops {degraded.droppedParams.join(", ")}</span>
            {/* The chip is terse on screen; a screen reader gets the whole
                sentence rather than two words out of context. */}
            <span className="sr-only">{degraded.message}</span>
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
 *
 * Binding and params are rendered from the stored preset, which is all a row
 * needs. The one thing it cannot compute is whether the bound agent's
 * `configSchema` rejects a built-in's hardcoded params, because that answer
 * belongs to the server's resolution (issue #672). So the advisory `degraded`
 * field is read off the app-scoped resolved-preset endpoint and matched by id,
 * rather than re-derived here: a second client-side `validateAgentConfig` would
 * be a second source of truth for what a preset actually launches with.
 */
export default function AgentToolsSection({ agents, defaultAgent, jigs }: Props) {
  const { agentTools, saveAgentTool, deleteAgentTool } = useAgentTools();
  const { data: resolved } = useAppAgentPresets();
  const { addToast } = useToast();
  const [editing, setEditing] = useState<{ preset: AgentToolPreset | null } | null>(null);

  // Absent while the request is in flight or if it failed, in which case rows
  // render exactly as they did before: the marker is advisory, so its absence
  // must never hold the listing back.
  const degradedById = useMemo(() => {
    const map = new Map<string, NonNullable<ResolvedAgentPreset["degraded"]>>();
    for (const preset of resolved?.presets ?? []) {
      if (preset.degraded) map.set(preset.id, preset.degraded);
    }
    return map;
  }, [resolved]);

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
            degraded={degradedById.get(preset.id)}
          />
        ))}
        {agentTools.map((preset) => (
          <AgentToolRow
            key={preset.id}
            preset={preset}
            builtin={false}
            agents={agents}
            defaultAgent={defaultAgent}
            degraded={degradedById.get(preset.id)}
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
