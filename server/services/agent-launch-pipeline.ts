import type { PluginManifest } from "@roubo/shared";
import type { AgentLaunchDescriptor } from "@roubo/shared/agent-launch-descriptor-schema";
import { getEffectiveAgentConfig } from "./agent-overrides.js";
import { getProjectAgentOverrides, mergeAgentConfig } from "./agent-project-overrides.js";
import {
  describeAgentNotAvailable,
  isAgentNotAvailable,
  requestLaunchDescriptor,
  resolveAgent,
  type AgentNotAvailable,
} from "./agent-plugin-registry.js";
import { validateDescriptor } from "./agent-launch-executor.js";

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

export interface PrepareAgentLaunchParams {
  pluginId: string;
  projectId: string;
  benchId: number;
  workspacePath: string;
  /** Minted by the caller (terminal.createAgentSession) BEFORE this runs. */
  sessionId: string;
  initialPrompt?: string;
  layers?: AgentConfigLayers;
  timeoutMs?: number;
}

export interface PreparedAgentLaunch {
  pluginId: string;
  manifest: PluginManifest;
  descriptor: AgentLaunchDescriptor;
  effectiveConfig: Record<string, unknown>;
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

  const effectiveConfig = resolveEffectiveAgentConfig(
    params.projectId,
    params.pluginId,
    params.layers,
  );

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

  return {
    pluginId: params.pluginId,
    manifest: resolved.manifest,
    descriptor: validateDescriptor(raw),
    effectiveConfig,
  };
}
