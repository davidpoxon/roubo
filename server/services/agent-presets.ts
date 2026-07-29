import {
  AGENT_TOOL_DEFAULT_AGENT,
  BUILTIN_AGENT_PRESETS,
  type AgentPresetSource,
  type AgentToolPreset,
  type ResolvedAgentPreset,
  type ToolConfig,
} from "@roubo/shared";
import { loadSettings } from "./state.js";
import * as projectRegistry from "./project-registry.js";
import {
  describeAgentNotAvailable,
  isAgentNotAvailable,
  resolveAgent,
  type AgentNotAvailable,
  type ResolvedAgent,
} from "./agent-plugin-registry.js";
import { resolveLaunchAgentId } from "./agent-launch-pipeline.js";
import { validateAgentConfig } from "./agent-config-validator.js";

// Agent tool presets (AP-FR-008, AP-FR-009, issue #516).
//
// The producer for the `preset` layer that `agent-launch-pipeline` already
// accepts. A preset is a named launch configuration: an agent binding, a bag of
// parameter overrides, and jig behavior. Three sources feed one list, in
// increasing specificity: the built-ins Roubo ships, the app-level presets the
// editor writes into `~/.roubo/settings.json`, and the project-level presets a
// repo declares under `roubo.yaml tools:`.
//
// Two rules make the whole thing work:
//
// 1. Resolution is lazy and never persisted. A preset stores `default` or a
//    concrete plugin id, and the agent it launches is computed on every read
//    through the same `resolveLaunchAgentId` a jig launch uses. Switching the
//    default agent therefore re-points every default-bound preset with nothing
//    to invalidate and no stored value to rewrite (AP-TC-027, AP-TC-031,
//    AP-TC-039, AP-TC-045).
// 2. An unresolvable preset is surfaced, never launched. A binding to an
//    uninstalled plugin (AP-TC-032) and params the bound agent's `configSchema`
//    rejects (AP-TC-033) both mark the preset `unresolved` with a message that
//    names the preset and, for a bad param, the parameter. Launch surfaces
//    disable such an entry, which is what keeps a dead PTY session from ever
//    being created for one.

const DEFAULT_AGENT_TOOL_ICON = "bot";

/** The project-preset id namespace. `roubo.yaml` presets are keyed by name. */
function projectPresetId(name: string): string {
  return `project:${name}`;
}

/**
 * Resolve one preset against the live agent registry and the current default
 * agent. Pure apart from the registry and settings reads, so a caller can
 * resolve the same preset twice and get two answers when the default moved
 * between them, which is exactly the contract.
 */
export function resolveAgentPreset(
  preset: AgentToolPreset,
  source: AgentPresetSource,
  // Omitted means "read the stored default", which is the same value
  // `listAgentPresets` hoists out of its loop so a batch resolves off one read.
  defaultAgentPluginId: string | undefined = loadSettings().jigs?.defaultAgentPluginId,
): ResolvedAgentPreset {
  const bindsDefaultAgent = preset.agent === AGENT_TOOL_DEFAULT_AGENT;
  const base: ResolvedAgentPreset = {
    id: preset.id,
    name: preset.name,
    icon: preset.icon ?? DEFAULT_AGENT_TOOL_ICON,
    source,
    agent: preset.agent,
    bindsDefaultAgent,
    params: preset.params ?? {},
    ...(preset.jig !== undefined && { jig: preset.jig }),
  };

  if (bindsDefaultAgent) {
    // The default agent is resolved through the same availability-gated
    // fallback chain a jig launch uses, so a preset can never resolve to an
    // agent the jig picker would not.
    const pluginId = resolveLaunchAgentId({
      ...(defaultAgentPluginId !== undefined && { defaultAgentPluginId }),
    });
    if (pluginId === undefined) {
      return {
        ...base,
        unresolved: {
          reason: "no-default-agent",
          message: `Agent tool "${preset.name}" follows the default agent, but no default agent is available. Choose one under Settings, Jigs.`,
        },
      };
    }
    // `resolveLaunchAgentId` only ever returns an id it already availability-
    // gated, so this second resolve is a manifest lookup, not a second gate.
    const agent = resolveAgent(pluginId);
    if (isAgentNotAvailable(agent)) {
      return { ...base, unresolved: unavailable(preset, agent) };
    }
    return withValidatedParams(base, preset, agent);
  }

  const resolved = resolveAgent(preset.agent);
  if (isAgentNotAvailable(resolved)) {
    return { ...base, unresolved: unavailable(preset, resolved) };
  }
  return withValidatedParams(base, preset, resolved);
}

function unavailable(
  preset: AgentToolPreset,
  notAvailable: AgentNotAvailable,
): NonNullable<ResolvedAgentPreset["unresolved"]> {
  return {
    reason: "agent-unavailable",
    message: `Agent tool "${preset.name}": ${describeAgentNotAvailable(notAvailable)}`,
  };
}

/**
 * Attach the resolved agent, then gate the preset's params on that agent's
 * `configSchema`. An invalid param names both the offending parameter and the
 * preset it belongs to (AP-TC-033), because a `roubo.yaml` author needs to know
 * which of several presets to fix, not just that "a param is invalid".
 */
function withValidatedParams(
  base: ResolvedAgentPreset,
  preset: AgentToolPreset,
  agent: ResolvedAgent,
): ResolvedAgentPreset {
  const resolved: ResolvedAgentPreset = {
    ...base,
    agentPluginId: agent.pluginId,
    resolvedAgentName: agent.manifest.name ?? agent.pluginId,
  };

  const params = preset.params ?? {};
  if (Object.keys(params).length === 0) return resolved;

  const errors = validateAgentConfig(agent.manifest, params);
  if (errors.length === 0) return resolved;

  const detail = errors.map((err) => `${err.path || "config"}: ${err.message}`).join("; ");
  return {
    ...resolved,
    unresolved: {
      reason: "invalid-params",
      message: `Agent tool "${preset.name}" has invalid parameters for ${resolved.resolvedAgentName} (${detail}).`,
    },
  };
}

/** The app-level presets the editor saved, or an empty list. */
export function listAppAgentPresets(): AgentToolPreset[] {
  return loadSettings().agentTools ?? [];
}

/** The `roubo.yaml tools:` entries of type `agent`, as presets. */
export function listProjectAgentPresets(projectId: string): AgentToolPreset[] {
  const project = projectRegistry.getProject(projectId);
  const tools = project?.config?.tools ?? [];
  return tools.filter((tool) => tool.type === "agent").map(toolConfigToPreset);
}

/** One `roubo.yaml` agent tool as a preset. Project presets are keyed by name. */
export function toolConfigToPreset(tool: ToolConfig): AgentToolPreset {
  return {
    id: projectPresetId(tool.name),
    name: tool.name,
    ...(tool.icon !== undefined && { icon: tool.icon }),
    agent: tool.agent ?? AGENT_TOOL_DEFAULT_AGENT,
    ...(tool.params !== undefined && { params: tool.params }),
    ...(tool.jig !== undefined && { jig: tool.jig }),
  };
}

/**
 * Every preset a launch surface offers for one project, resolved: built-ins
 * first, then app-level presets, then the project's own (AP-TC-026). Ordering
 * is the surface's grouping order, not a precedence: presets do not override
 * each other, they sit side by side.
 */
export function listAgentPresets(projectId?: string): ResolvedAgentPreset[] {
  const defaultAgentPluginId = loadSettings().jigs?.defaultAgentPluginId;
  const entries: { preset: AgentToolPreset; source: AgentPresetSource }[] = [
    ...BUILTIN_AGENT_PRESETS.map((preset) => ({ preset, source: "builtin" as const })),
    ...listAppAgentPresets().map((preset) => ({ preset, source: "app" as const })),
    ...(projectId
      ? listProjectAgentPresets(projectId).map((preset) => ({ preset, source: "project" as const }))
      : []),
  ];
  return entries.map(({ preset, source }) =>
    resolveAgentPreset(preset, source, defaultAgentPluginId),
  );
}
