import {
  AGENT_TOOL_DEFAULT_AGENT,
  BUILTIN_AGENT_PRESETS,
  type AgentPresetSource,
  type AgentToolPreset,
  type ConfigFieldError,
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
import { getEffectiveAgentConfig } from "./agent-overrides.js";
import { mergeAgentConfig } from "./agent-project-overrides.js";

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
  // Omitting `defaults` means "read the stored default here". A caller
  // resolving a batch passes the object instead, having read the default once
  // itself, so the batch costs one settings read rather than one per preset
  // (issue #649). The object wrapper is what makes that work: `loadSettings` is
  // uncached, and a bare optional parameter could not tell "no default is set"
  // (an explicit `undefined`) apart from "not supplied", so every no-default
  // preset would re-read the file.
  defaults?: { defaultAgentPluginId: string | undefined },
): ResolvedAgentPreset {
  const defaultAgentPluginId =
    defaults === undefined
      ? loadSettings().jigs?.defaultAgentPluginId
      : defaults.defaultAgentPluginId;
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
 *
 * Two carve-outs keep the shipped built-ins launchable, and they are distinct:
 *
 * 1. A preset's params are a partial override, not a whole config, so they are
 *    validated against the app defaults they overlay rather than on their own,
 *    exactly as a project-level override is (`routes/project-agents.ts`).
 *    Checking the bare bag would let a `configSchema` that marks any field
 *    required reject every preset that overrides only some other field, which
 *    would take `Agent (Plan)` and `Agent (Auto)` down with it (issue #516).
 *    That case is an error on a key the preset does NOT set, which is why the
 *    filter below drops it.
 * 2. The built-ins hardcode `mode`, which is a per-plugin `configSchema` key
 *    rather than a host concept, so an agent whose schema closes
 *    `additionalProperties` and never declares `mode` rejects a key the preset
 *    DOES set. The filter cannot help there, and a built-in can be neither
 *    edited nor deleted, so a hard rejection would leave two of the three
 *    built-ins permanently unlaunchable. Built-ins therefore degrade: the
 *    rejected keys are dropped from the resolved params (`Agent (Plan)` becomes
 *    plain `Agent`) and the reduced overlay is revalidated, which keeps a
 *    built-in that genuinely cannot be made valid surfaced (issue #654).
 *    `app` and `project` presets keep the hard rejection, because a user can
 *    actually edit those.
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

  let overlay = params;
  let errors = presetParamErrors(agent, overlay);

  if (errors.length > 0 && base.source === "builtin") {
    // A root-level error (`path === ""`) names no key, so there is nothing to
    // drop for it; such a built-in stays surfaced rather than degrading.
    const rejected = new Set(
      errors.map((err) => err.path.split(".")[0] ?? "").filter((key) => key !== ""),
    );
    if (rejected.size > 0) {
      overlay = Object.fromEntries(Object.entries(params).filter(([key]) => !rejected.has(key)));
      // Dropping a key can surface a fresh error (a `required` field the
      // dropped key was satisfying), so the reduced overlay is revalidated
      // rather than assumed good.
      errors = presetParamErrors(agent, overlay);
    }
  }

  if (errors.length === 0) return { ...resolved, params: overlay };

  const detail = errors.map((err) => `${err.path || "config"}: ${err.message}`).join("; ");
  return {
    ...resolved,
    unresolved: {
      reason: "invalid-params",
      message: `Agent tool "${preset.name}" has invalid parameters for ${resolved.resolvedAgentName} (${detail}).`,
    },
  };
}

/**
 * The errors an overlay of `params` over the agent's app-level config produces,
 * narrowed to the keys the overlay actually sets. A defect inherited from the
 * app-level config is surfaced by the AI Agents form that owns it, not by
 * disabling every preset bound to the agent.
 */
function presetParamErrors(
  agent: ResolvedAgent,
  params: Record<string, unknown>,
): ConfigFieldError[] {
  const effective = mergeAgentConfig(getEffectiveAgentConfig(agent.pluginId), params);
  return validateAgentConfig(agent.manifest, effective).filter((err) => {
    const [root = ""] = err.path.split(".");
    return err.path === "" || root in params;
  });
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
    resolveAgentPreset(preset, source, { defaultAgentPluginId }),
  );
}
