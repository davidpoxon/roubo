import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";

// Whether a launch surface may actually start a given agent or preset
// (AP-TC-038, issue #517).
//
// One predicate for every surface: the menu row's disabled state, the
// split-button's disabled state, and the guard inside the launch handler all
// read the same answer, so an entry can never render enabled and then refuse,
// or render disabled and still be launchable through another path.

/**
 * Why an entry cannot launch, or `null`. `label` is the short chip text: an
 * agent whose config does not validate gets an actionable one, since the fix is
 * a visit to its form rather than an install.
 */
export interface LaunchBlocker {
  message: string;
  label: "configure first" | "unavailable";
}

/**
 * One agent's launchability. Two different blockers, one answer: the registry
 * says the plugin cannot connect, the host's validator says its config does not
 * hold up. Either way it must not launch, or the session starts and dies.
 */
export function agentLaunchBlocker(agent: ProjectAgentState | undefined): LaunchBlocker | null {
  if (!agent) return null;
  if (agent.unavailable) return { message: agent.unavailable.message, label: "unavailable" };
  if (agent.misconfigured)
    return { message: agent.misconfigured.message, label: "configure first" };
  return null;
}

/**
 * One preset's launchability: its own resolution AND the state of the agent it
 * resolves to.
 *
 * The second half is not redundant. Preset resolution validates only the keys
 * the preset itself sets (`agent-presets.ts`, `withValidatedParams`), so a
 * preset that overrides nothing, which is every built-in, resolves cleanly no
 * matter how broken the bound agent's own configuration is. Without this the
 * All-agents row for an unconfigured agent would be disabled while the preset
 * bound to that same agent launched it anyway.
 */
export function presetLaunchBlocker(
  preset: ResolvedAgentPreset,
  agents: ProjectAgentState[],
): LaunchBlocker | null {
  if (preset.unresolved) return { message: preset.unresolved.message, label: "unavailable" };
  if (!preset.agentPluginId)
    return { message: `${preset.name} resolves to no agent.`, label: "unavailable" };
  return agentLaunchBlocker(agents.find((agent) => agent.id === preset.agentPluginId));
}

/** What pressing an entry will actually start, and whether it may. */
export interface LaunchTarget {
  agentPluginId: string | undefined;
  agentName: string;
  blocked: LaunchBlocker | null;
}

/**
 * Which agent a preset launches, and whether it may (AP-FR-006, AP-TC-038).
 *
 * `jigAgent` is the agent bound by the jig this launch would carry, already
 * looked up, or `undefined` when there is no jig or it binds nothing.
 *
 * A jig's own binding beats the DEFAULT agent. The host applies that order
 * itself, but only for a request naming no agent: an explicit `agentPluginId`
 * deliberately short-circuits `resolveLaunchAgentId`. Every launch from the
 * Terminal tab names one, so the order is applied here instead.
 *
 * Two guards keep the redirect honest:
 *
 * - Only a preset that binds the DEFAULT agent is redirected. A preset pinned
 *   to a specific agent named it, and a jig does not get to overrule that.
 * - Only a preset that overrides NO params is redirected. A preset's params are
 *   validated host-side against the agent the preset resolves to, and nothing
 *   re-validates them at launch, so sending them to a different agent would
 *   ship keys that agent's schema never saw (AP-TC-033). `Agent (Plan)` and
 *   `Agent (Auto)` therefore stay on the default agent their `mode` was checked
 *   against, while the bare `Agent` preset follows the jig, which is exactly
 *   what the built-in launch button did before it grew a preset.
 *
 * The binding is availability-gated as the host gates it, so a jig pointing at
 * an agent that is gone or unconfigured falls back to the preset's own agent
 * rather than failing the launch (AP-TC-035 S002).
 */
export function resolveLaunchTarget(
  preset: ResolvedAgentPreset,
  agents: ProjectAgentState[],
  jigAgent: ProjectAgentState | undefined,
): LaunchTarget {
  const redirectable = preset.bindsDefaultAgent && Object.keys(preset.params).length === 0;
  if (redirectable && jigAgent && agentLaunchBlocker(jigAgent) === null) {
    return { agentPluginId: jigAgent.id, agentName: jigAgent.name, blocked: null };
  }
  return {
    agentPluginId: preset.agentPluginId,
    agentName: preset.resolvedAgentName ?? preset.name,
    blocked: presetLaunchBlocker(preset, agents),
  };
}
