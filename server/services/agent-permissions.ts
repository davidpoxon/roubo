import { randomUUID } from "node:crypto";
import type { AgentPermissionsCapabilities, ProjectPermissions } from "@roubo/shared";
import type { AgentPosture } from "@roubo/shared/agent-launch-descriptor-schema";
import {
  collectWorkspaceWrites,
  executeWorkspaceWrites,
  resolveWriteTemplates,
} from "./agent-launch-executor.js";
import {
  prepareAgentLaunch,
  resolveLaunchAgentId,
  type LaunchPermissions,
} from "./agent-launch-pipeline.js";
import { filterSafeRules } from "./permission-rule-guard.js";
import { loadSettings } from "./state.js";
import type { ResolvedTemplateContext } from "./config-parser.js";

// Agent permissions dispatch (issue #514, AP-FR-016, AP-FR-018).
//
// The seam that turns ONE per-project permissions model into whatever the
// project's agent actually understands. Core holds the model; the agent plugin
// declares, in its launch descriptor's `capabilities.permissions`, how the
// universal posture binds to its native mechanism and whether it carries
// fine-grained rules at all. Nothing here knows a rule's vocabulary, which is
// what keeps AP-NFR-001's "no agent specifics leak into shared types" true even
// as the permissions screen grows.
//
// There is exactly one carrier: `agent-plugin`. The project resolves to an
// installed agent plugin, and its descriptor's workspace writes carry the
// rules, executed core-side under the same path-confinement barriers every
// other descriptor write uses. The `built-in` carrier that wrote an
// agent-specific settings file straight from core went with the rest of the
// built-in path in #521; with no agent plugin installed there is nothing to
// write rules for, so nothing is written.

const DEFAULT_ROUBO_PORT = "3335";

/** Which carrier actually applied a project's permissions to a workspace. */
export type PermissionsCarrier = "agent-plugin" | "none";

export interface ApplyPermissionsResult {
  carrier: PermissionsCarrier;
  /** Absolute paths written, empty when the carrier wrote nothing. */
  written: string[];
}

/**
 * The stored model as a plugin sees it, with every path-escaping rule dropped
 * from the access-granting groups (AP-TC-081 S002); `deny` is subtractive and
 * passes through as written. The guard runs on the way in at the API boundary
 * too; running it again here is what keeps a state file written before the
 * guard existed, or edited by hand, from reaching a bench workspace.
 */
export function toLaunchPermissions(permissions: ProjectPermissions): LaunchPermissions {
  const safe = filterSafeRules(permissions);
  return {
    ...(safe.posture !== undefined && { posture: safe.posture }),
    rules: { allow: safe.allow, ask: safe.ask ?? [], deny: safe.deny },
  };
}

/**
 * The agent plugin a project's launches resolve to, or `undefined` when none
 * does. This is deliberately the PROJECT-level resolution, the app default plus
 * the lone-available-agent fallback, and it does not consult a jig's own
 * `agentPluginId` binding the way `routes/terminal.ts` does at launch. The
 * permissions model is per project (AP-FR-016) and neither the capabilities
 * probe nor the resync fan-out carries jig or session context: a bench can host
 * sessions started from several jigs, so there is no single launch agent to
 * find. The consequence is narrow but real: for a bench whose jig binds a
 * non-default agent, the editor describes the default agent's capabilities, and
 * a resync writes through the default agent's descriptor while still counting
 * that bench in `resynced`. Launch-time permissions are unaffected, since
 * `routes/terminal.ts` resolves the jig binding itself.
 */
export function resolveProjectAgentPluginId(): string | undefined {
  const settings = loadSettings();
  return resolveLaunchAgentId({
    ...(settings.jigs?.defaultAgentPluginId !== undefined && {
      defaultAgentPluginId: settings.jigs.defaultAgentPluginId,
    }),
  });
}

/**
 * What the project's agent honours, for the permissions screen to gate its
 * controls on (AP-FR-016: the rules editor is hidden for an agent that declares
 * no rules capability). Probing means asking the plugin for a descriptor, which
 * is the only place the capability is declared; nothing is written.
 *
 * A project with no agent plugin has no carrier at all (#521). Rules still
 * report as available, because the model is core's and stays editable so it is
 * ready for whichever agent plugin gets installed; resync does not, because
 * there is nothing to re-inject through until one is.
 */
export async function describeAgentPermissions(
  projectId: string,
  workspacePath: string,
): Promise<AgentPermissionsCapabilities> {
  const pluginId = resolveProjectAgentPluginId();
  if (pluginId === undefined) {
    return {
      agentPluginId: null,
      agentName: null,
      postures: [],
      rules: true,
      resync: false,
    };
  }

  const prepared = await prepareAgentLaunch({
    pluginId,
    projectId,
    benchId: 0,
    workspacePath,
    sessionId: randomUUID(),
  });
  const capability = prepared.descriptor.capabilities?.permissions;
  const postures = capability
    ? (Object.entries(capability.postures)
        .filter(([, binding]) => binding !== undefined)
        .map(([name]) => name) as AgentPosture[])
    : [];

  return {
    agentPluginId: pluginId,
    agentName: prepared.manifest.name,
    postures,
    rules: capability?.rules !== undefined,
    resync: capability?.rules?.resync === true,
  };
}

/**
 * Apply a project's permissions to one existing bench workspace: the resync
 * path (AP-TC-080, AP-TC-101).
 *
 * Dispatch, not translation. When an agent plugin resolves, its descriptor is
 * requested with the permissions model in the launch context and the workspace
 * writes it declares are executed; when it declares no rules capability, or
 * declares one that opts out of resync, nothing is written and the bench is
 * reported as skipped rather than silently counted as re-synced.
 */
export async function applyProjectPermissions(opts: {
  projectId: string;
  benchId: number;
  workspacePath: string;
  permissions: ProjectPermissions;
}): Promise<ApplyPermissionsResult> {
  const pluginId = resolveProjectAgentPluginId();
  const permissions = toLaunchPermissions(opts.permissions);

  if (pluginId === undefined) {
    // No agent plugin, so no carrier. Core writes no agent-specific file of its
    // own any more (#521): the bench is reported as skipped, exactly as it is
    // for a plugin that opts out of resync.
    return { carrier: "none", written: [] };
  }

  const sessionId = randomUUID();
  const prepared = await prepareAgentLaunch({
    pluginId,
    projectId: opts.projectId,
    benchId: opts.benchId,
    workspacePath: opts.workspacePath,
    sessionId,
    permissions,
  });

  const capability = prepared.descriptor.capabilities?.permissions;
  if (capability?.rules?.resync !== true) {
    return { carrier: "none", written: [] };
  }

  const ctx: ResolvedTemplateContext = {
    ports: {},
    portHttps: {},
    workspace: opts.workspacePath,
    components: {},
    sessionId,
    port: process.env.ROUBO_PORT || DEFAULT_ROUBO_PORT,
  };
  const writes = collectWorkspaceWrites(
    prepared.descriptor,
    permissions.posture ? { posture: permissions.posture } : {},
  );
  const written = executeWorkspaceWrites(opts.workspacePath, resolveWriteTemplates(writes, ctx));
  return { carrier: "agent-plugin", written };
}
