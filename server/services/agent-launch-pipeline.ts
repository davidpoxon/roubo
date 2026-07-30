import type { PluginManifest } from "@roubo/shared";
import type {
  AgentLaunchDescriptor,
  AgentPermissionsModel,
} from "@roubo/shared/agent-launch-descriptor-schema";
import { getEffectiveAgentConfig } from "./agent-overrides.js";
import { getProjectAgentOverrides, mergeAgentConfig } from "./agent-project-overrides.js";
import {
  describeAgentNotAvailable,
  isAgentNotAvailable,
  listAgents,
  requestLaunchDescriptor,
  resolveAgent,
  type AgentNotAvailable,
} from "./agent-plugin-registry.js";
import { validateDescriptor } from "./agent-launch-executor.js";
import {
  invalidateAgentVersionProbe,
  probeAgentVersion,
  type AgentVersionProbeResult,
} from "./agent-version-probe.js";
import { AgentLaunchFailureError, belowFloorFailure } from "./agent-launch-failure.js";

// Agent launch pipeline (issue #510, AP-FR-011, AP-NFR-002).
//
// The join between the two halves earlier slices built independently: the
// four-layer effective configuration (agent-overrides.ts for app defaults,
// agent-project-overrides.ts for project overrides) and the descriptor contract
// (agent-plugin-registry.requestLaunchDescriptor plus
// agent-launch-executor.validateDescriptor).
//
// Everything here is deliberately I/O-light and spawn-free: it resolves config,
// asks the plugin for a descriptor, and validates it. The privileged half
// (template resolution, path-validated workspace writes, and the PTY spawn)
// lives in terminal.createAgentSession, because the session id must be minted
// before any of it happens: the plugin receives that id in its launch context,
// the http-hook carrier write embeds it, and argv carries it. One mint, one
// session, no divergence.

/**
 * The two launch-time layers that sit above the stored app and project layers.
 * Neither has a producer yet (presets are AP-WU-015 / #516, per-launch overrides
 * are AP-WU-017 / #518); they are accepted here so the AP-FR-011 resolution
 * order is complete and testable rather than retro-fitted later.
 */
export interface AgentConfigLayers {
  preset?: Record<string, unknown>;
  perLaunch?: Record<string, unknown>;
}

/** An agent that could not be resolved to a live, consented plugin connection. */
export class AgentUnavailableError extends Error {
  constructor(public notAvailable: AgentNotAvailable) {
    super(describeAgentNotAvailable(notAvailable));
    this.name = "AgentUnavailableError";
  }
}

/**
 * A launch blocked by the pre-spawn version gate: the detected agent CLI is
 * below the floor the plugin declares (AP-FR-014, AP-TC-071).
 *
 * It is an `AgentLaunchFailureError` so the HTTP layer maps it through exactly
 * the same structured surface as every other failure class; the distinct name
 * exists so a caller can tell "never started" from "started and died".
 */
export class AgentVersionGateError extends AgentLaunchFailureError {
  constructor(
    failure: ConstructorParameters<typeof AgentLaunchFailureError>[0],
    public readonly probe: AgentVersionProbeResult,
  ) {
    super(failure);
    this.name = "AgentVersionGateError";
  }
}

/**
 * The effective launch configuration for one agent plugin, resolved in the
 * AP-FR-011 order: application defaults, then project overrides, then the
 * preset, then per-launch overrides. Later layers win per field.
 *
 * Four shallow overlays, not a deep merge, matching `mergeAgentConfig`'s
 * contract: a key present in a layer IS the override, and a key absent falls
 * through so it keeps tracking the layer beneath it. Pure apart from the two
 * stored-layer reads, which is what keeps the whole chain inside AP-TC-048's
 * 50ms budget.
 */
export function resolveEffectiveAgentConfig(
  projectId: string,
  pluginId: string,
  layers: AgentConfigLayers = {},
): Record<string, unknown> {
  const appDefaults = getEffectiveAgentConfig(pluginId);
  const projectOverrides = getProjectAgentOverrides(projectId, pluginId);
  const withProject = mergeAgentConfig(appDefaults, projectOverrides);
  const withPreset = mergeAgentConfig(withProject, layers.preset ?? {});
  return mergeAgentConfig(withPreset, layers.perLaunch ?? {});
}

/**
 * Which agent a jig-driven launch runs (AP-FR-006, issue #515).
 *
 * The order is the whole contract: a jig's own binding wins, the app-level
 * default agent is the fallback for every jig that carries none, and a lone
 * configured agent is the default nobody had to choose (AP-TC-041 S001), which
 * is what keeps launch resolution agreeing with the picker that already renders
 * that single agent as selected.
 *
 * Every layer is availability-gated, never just the binding: a jig left
 * pointing at an agent that was since uninstalled falls back to the default
 * (AP-TC-035 S002), and a default whose plugin has gone away likewise falls
 * through rather than failing the launch with `AgentUnavailableError`. Neither
 * stored value is ever rewritten, so re-installing the plugin makes it take
 * effect again.
 *
 * Returns `undefined` when no layer names an agent that resolves, which is the
 * signal to stay on the built-in command path.
 */
export function resolveLaunchAgentId({
  jigAgentPluginId,
  defaultAgentPluginId,
}: {
  jigAgentPluginId?: string;
  defaultAgentPluginId?: string;
}): string | undefined {
  if (jigAgentPluginId && !isAgentNotAvailable(resolveAgent(jigAgentPluginId))) {
    return jigAgentPluginId;
  }
  if (defaultAgentPluginId && !isAgentNotAvailable(resolveAgent(defaultAgentPluginId))) {
    return defaultAgentPluginId;
  }
  // With exactly one agent actually available there is nothing to choose
  // between, so it is the default whether or not anything was ever persisted.
  // This is also what rescues a default left pointing at an agent that has since
  // gone away: resolution degrades to the one agent that is really there rather
  // than to no agent at all.
  const available = listAgents().filter(
    (manifest) => !isAgentNotAvailable(resolveAgent(manifest.id)),
  );
  return available.length === 1 ? available[0].id : undefined;
}

/**
 * The project's permissions model as a plugin sees it (AP-FR-016). Both axes
 * travel together so a plugin maps whichever it declares support for: the
 * universal `posture` (absent when the project has never chosen one, so the
 * agent keeps its own configured mode) and the fine-grained rule strings, which
 * only a plugin declaring the rules capability carries anywhere.
 *
 * It reaches the plugin as `config.permissions`, layered on top of the resolved
 * four-layer configuration rather than merged into it: project permissions are
 * managed on their own screen and are not an agent config field a preset or a
 * per-launch override may quietly outrank.
 */
export type LaunchPermissions = AgentPermissionsModel;

export interface PrepareAgentLaunchParams {
  pluginId: string;
  projectId: string;
  benchId: number;
  workspacePath: string;
  /** Minted by the caller (terminal.createAgentSession) BEFORE this runs. */
  sessionId: string;
  initialPrompt?: string;
  layers?: AgentConfigLayers;
  permissions?: LaunchPermissions;
  timeoutMs?: number;
}

export interface PreparedAgentLaunch {
  pluginId: string;
  manifest: PluginManifest;
  descriptor: AgentLaunchDescriptor;
  effectiveConfig: Record<string, unknown>;
  /**
   * The pre-spawn version probe, when the descriptor declared one. A prepared
   * launch never carries `below-floor` here: that throws `AgentVersionGateError`
   * instead, which is what makes "no PTY is spawned" structural rather than
   * incidental (AP-TC-071, AP-TC-100 S001).
   */
  compatibility?: AgentVersionProbeResult;
}

/**
 * Resolve an agent to a validated launch descriptor: availability gate, then
 * four-layer effective config, then the `translateLaunch` RPC, then the Zod
 * gate. Nothing here touches the filesystem or spawns anything.
 *
 * Throws `AgentUnavailableError` when the plugin is not installed, not an agent,
 * incompatible, unconsented, or not running, and `AgentDescriptorError` when the
 * plugin answers with something the schema rejects.
 */
export async function prepareAgentLaunch(
  params: PrepareAgentLaunchParams,
): Promise<PreparedAgentLaunch> {
  // Availability first: an unconsented or incompatible plugin must not have its
  // config read or its process asked for anything (AP-TC-014 S002).
  const resolved = resolveAgent(params.pluginId);
  if (isAgentNotAvailable(resolved)) throw new AgentUnavailableError(resolved);

  const resolvedConfig = resolveEffectiveAgentConfig(
    params.projectId,
    params.pluginId,
    params.layers,
  );

  // The permissions model sits ABOVE all four config layers. `posture` is also
  // surfaced flat because that is the key the executor reads when it picks a
  // descriptor's posture binding, and a project that has chosen no posture must
  // leave whatever the agent's own config selected untouched.
  const effectiveConfig: Record<string, unknown> = params.permissions
    ? {
        ...resolvedConfig,
        permissions: params.permissions,
        ...(params.permissions.posture !== undefined && { posture: params.permissions.posture }),
      }
    : resolvedConfig;

  const raw = await requestLaunchDescriptor(
    params.pluginId,
    {
      config: effectiveConfig,
      context: {
        projectId: params.projectId,
        benchId: params.benchId,
        workspacePath: params.workspacePath,
        sessionId: params.sessionId,
        effectiveConfig,
        ...(params.initialPrompt !== undefined && { initialPrompt: params.initialPrompt }),
      },
    },
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : undefined,
  );

  const descriptor = validateDescriptor(raw);

  // The version gate runs HERE, in the deliberately spawn-free half of the
  // launch, rather than beside the PTY: a below-floor agent is refused with
  // nothing having been spawned and no workspace file having been written.
  let compatibility: AgentVersionProbeResult | undefined;
  const probeSpec = descriptor.capabilities?.versionProbe;
  if (probeSpec) {
    // The child's PATH, not the server's. `createAgentSession` layers descriptor
    // env over the host environment and PATH is not among the keys core withholds,
    // so a descriptor-supplied `env.PATH` replaces the host's outright. Handing it
    // to the probe is what keeps the gate reading the binary the launch will spawn
    // rather than a same-named one on the server's PATH (#660).
    compatibility = await probeAgentVersion(
      params.pluginId,
      descriptor.command,
      probeSpec,
      descriptor.env?.PATH ?? process.env.PATH,
    );
    if (compatibility.status === "below-floor") {
      // The refusal tells the user to update the CLI and launch again, and the
      // Retry action re-enters this same gate. Drop the cached detection so that
      // retry re-probes the (now possibly updated) binary instead of replaying
      // the stale version until the TTL lapses.
      invalidateAgentVersionProbe(params.pluginId);
      throw new AgentVersionGateError(
        belowFloorFailure(
          { agentPluginId: params.pluginId, agentName: resolved.manifest.name },
          compatibility,
        ),
        compatibility,
      );
    }
  }

  return {
    pluginId: params.pluginId,
    manifest: resolved.manifest,
    descriptor,
    effectiveConfig,
    ...(compatibility !== undefined && { compatibility }),
  };
}
