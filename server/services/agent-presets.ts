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
import {
  unexpectedPropertyMessage,
  unknownConfigKeys,
  validateAgentConfig,
} from "./agent-config-validator.js";
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
//    being created for one. The bad-param half of that applies to `app` and
//    `project` presets only: a built-in can be neither edited nor deleted, so it
//    degrades instead of dying, dropping the rejected keys and launching with
//    what is left (issue #654, `withValidatedParams` below).

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
 *    plain `Agent`) and the reduced overlay is revalidated (issue #654). `app`
 *    and `project` presets keep the hard rejection, because a user can actually
 *    edit those.
 *
 * 3. A key the agent's schema never DECLARES is a third case, and it is routed
 *    by binding rather than by source (issue #743). Such a key raises no Ajv
 *    error at all on the shipped manifests, which set no `additionalProperties`,
 *    so it used to survive validation and reach an agent that drops it on the
 *    floor, unreported. It is now reported like any other rejected key, but a
 *    preset that binds `default` degrades on it WHATEVER its source, rather than
 *    only when it is a built-in. The mismatch there was caused by switching the
 *    default agent, an action taken elsewhere, not by the preset author writing
 *    something wrong, so hard-rejecting would disable a `roubo.yaml` tool that
 *    launches today over a change its author never made. A preset pinned to a
 *    named agent keeps the hard rejection: its author chose the agent and the
 *    param together, so the pair is theirs to fix.
 *
 *    This widening is deliberately confined to the undeclared-key case. A key
 *    the schema refuses OUTRIGHT (a bad value, or an unknown key under
 *    `additionalProperties: false`) still routes by source exactly as carve-out
 *    2 describes, because there the plugin author stated a rule and the preset
 *    author broke it.
 *
 *    Degrading deliberately stops at the dropped keys: an error the drop leaves
 *    behind ON one of them is swallowed, because plain `Agent` sets no params at
 *    all and so skips validation entirely, and holding `Agent (Plan)` to a
 *    stricter bar than `Agent` against the very same agent would resurrect the
 *    dead built-in this carve-out exists to prevent.
 *
 *    The drop is reported rather than silent (issue #665): a built-in that
 *    degrades carries `degraded`, naming the dropped keys, so a launch surface
 *    can say that `Agent (Plan)` will behave as plain `Agent` here. It is
 *    advisory and sits beside `unresolved`, never inside it, because the preset
 *    still launches. The two are mutually exclusive: `degraded` is attached
 *    only where the reduced overlay revalidates clean.
 */
function withValidatedParams(
  base: ResolvedAgentPreset,
  preset: AgentToolPreset,
  agent: ResolvedAgent,
): ResolvedAgentPreset {
  // Held as a local as well as on `resolved`, where the field is optional and so
  // reads back as `string | undefined` however it was assigned.
  const agentName = agent.manifest.name ?? agent.pluginId;
  const resolved: ResolvedAgentPreset = {
    ...base,
    agentPluginId: agent.pluginId,
    resolvedAgentName: agentName,
  };

  const params = preset.params ?? {};
  if (Object.keys(params).length === 0) return resolved;

  // Which keys this preset may degrade on rather than die for, per carve-outs 2
  // and 3 above: everything for a built-in, plus any key the agent's schema
  // never declares when the preset binds `default`, whatever its source.
  const undeclared = new Set(unknownConfigKeys(agent.manifest, Object.keys(params)));
  const isDroppable = (key: string): boolean =>
    base.source === "builtin" || (base.bindsDefaultAgent && undeclared.has(key));

  let overlay = params;
  let errors = presetParamErrors(agent, overlay);
  let droppedParams: string[] = [];

  if (errors.length > 0) {
    // A root-level error (`path === ""`) names no key, so there is nothing to
    // drop for it; such a preset stays surfaced rather than degrading. A key
    // this preset may not degrade on is left in place for the same reason: it
    // falls through to the hard rejection below.
    const rejected = new Set(
      errors
        .map((err) => err.path.split(".")[0] ?? "")
        .filter((key) => key !== "" && isDroppable(key)),
    );
    if (rejected.size > 0) {
      overlay = Object.fromEntries(Object.entries(params).filter(([key]) => !rejected.has(key)));
      droppedParams = [...rejected].sort();
      // Dropping a key can invalidate one that was KEPT (a schema whose
      // `if`/`then` or `dependentRequired` branch turned on the dropped key), so
      // the reduced overlay is revalidated rather than assumed good. An error
      // landing back on a dropped key is filtered out by `presetParamErrors`,
      // which is the intended degrade: see the second carve-out above.
      errors = presetParamErrors(agent, overlay);
    }
  }

  if (errors.length === 0) {
    return {
      ...resolved,
      params: overlay,
      // Attached on the clean return only, so `degraded` always means
      // "launchable, but not what its name says", never "broken" (issue #665).
      ...(droppedParams.length > 0 && {
        degraded: {
          droppedParams,
          message: degradedMessage(preset.name, agentName, droppedParams, overlay),
        },
      }),
    };
  }

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
 * The advisory a degraded preset carries.
 *
 * A built-in only ever carries the params it hardcodes, so dropping them leaves
 * nothing behind and "launches as a plain agent" says exactly what happened
 * (issue #665). A user-authored preset that degrades on an undeclared key can
 * keep other params the agent does accept (issue #743), and calling that a plain
 * agent would understate what still applies, so it reports the drop alone.
 */
function degradedMessage(
  presetName: string,
  agentName: string,
  droppedParams: string[],
  remaining: Record<string, unknown>,
): string {
  const dropped = `Agent tool "${presetName}" drops ${droppedParams.join(", ")}, which ${agentName} does not accept,`;
  return Object.keys(remaining).length === 0
    ? `${dropped} so it launches as a plain agent.`
    : `${dropped} so that part of its configuration does not apply.`;
}

/**
 * The errors an overlay of `params` over the agent's app-level config produces,
 * narrowed to the keys the overlay actually sets. A defect inherited from the
 * app-level config is surfaced by the AI Agents form that owns it, not by
 * disabling every preset bound to the agent.
 *
 * Ajv answers only for the keys a `configSchema` explicitly refuses, and the
 * bundled agent plugins leave `additionalProperties` unset, so a key their
 * schema merely omits used to validate clean and be passed through to an agent
 * that ignores it (issue #743). `unknownConfigKeys` supplies that second,
 * conservative signal, folded in here as the same `ConfigFieldError` shape so
 * the routing above treats both the same way. Deduped by path, because a schema
 * that does close `additionalProperties` must still report each key once.
 */
function presetParamErrors(
  agent: ResolvedAgent,
  params: Record<string, unknown>,
): ConfigFieldError[] {
  const effective = mergeAgentConfig(getEffectiveAgentConfig(agent.pluginId), params);
  const errors = validateAgentConfig(agent.manifest, effective).filter((err) => {
    const [root = ""] = err.path.split(".");
    return err.path === "" || root in params;
  });

  const reported = new Set(errors.map((err) => err.path));
  const undeclared = unknownConfigKeys(agent.manifest, Object.keys(params))
    .filter((key) => !reported.has(key))
    .map((key) => ({ path: key, message: unexpectedPropertyMessage(key) }));

  return [...errors, ...undeclared];
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
