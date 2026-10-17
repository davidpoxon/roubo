// Binds a Spec Bench to its delivery session (SB-FR-002, SB-FR-003, SB-US-001,
// SB-US-002).
//
//   launch  Once the bench workspace exists, mint a delivery token, build the
//           launch descriptor and pass it to the agent launch executor, which
//           starts the main delivery session in the bench workspace.
//   attach  Adopt the delivery whose record is already in the spec folder of
//           the bench workspace, and launch nothing. The token of the session
//           that already runs the delivery is minted on request, by POST
//           /delivery/attach, which hands that session's operator the
//           descriptor with the plain token.
//   resume  Launch again with the record's resume argument, on a fresh token.
//   launch  again, by POST /delivery/launch: a launch-mode bench with no record
//           yet launches with no resume argument, so a create-time launch that
//           failed can be tried again.
//
// One main session per bench: the bench keeps the id of the session it last
// launched as `deliverySessionId`, and no launch again, resume or attach handout
// goes ahead while that session is live, while a launch is in flight, or while
// the bench is clearing or in error (deliveryLaunchBlock). A new mint revokes
// the token before it, so going ahead then would cut off the live session.
//
// The executor is a port. The default one starts an AI coding agent session
// through the terminal service with the descriptor in its environment; a test,
// or a later launch path, swaps it with setDeliveryLaunchExecutor.
import type { Bench } from "@roubo/shared";
import {
  buildDeliveryLaunchDescriptor,
  type DeliveryLaunchDescriptor,
} from "@roubo/shared/delivery-bench";
import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as stateService from "./state.js";
import * as terminalService from "./terminal.js";
import { createNotification } from "./notification.js";
import { resolveLaunchAgentId } from "./agent-launch-pipeline.js";
import { toLaunchPermissions } from "./agent-permissions.js";
import { mintDeliveryToken } from "./delivery-token-registry.js";

const DEFAULT_ROUBO_PORT = "3335";

export interface DeliveryLaunchRequest {
  projectId: string;
  benchId: number;
  // The bench workspace: the session starts here.
  workspacePath: string;
  // The `.specifications/<slug>` folder name of the delivered spec.
  specSlug: string;
  descriptor: DeliveryLaunchDescriptor;
}

export interface DeliveryLaunchResult {
  sessionId?: string;
}

export interface DeliveryLaunchExecutor {
  launch(request: DeliveryLaunchRequest): Promise<DeliveryLaunchResult>;
}

export class DeliveryLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryLaunchError";
  }
}

// The env keys the default executor hands the session the descriptor in.
export const DELIVERY_ENV_KEYS = {
  eventUrl: "ROUBO_DELIVERY_EVENT_URL",
  controlsUrl: "ROUBO_DELIVERY_CONTROLS_URL",
  token: "ROUBO_DELIVERY_TOKEN",
  resume: "ROUBO_DELIVERY_RESUME",
} as const;

export function deliveryLaunchEnv(descriptor: DeliveryLaunchDescriptor): Record<string, string> {
  return {
    [DELIVERY_ENV_KEYS.eventUrl]: descriptor.eventUrl,
    [DELIVERY_ENV_KEYS.controlsUrl]: descriptor.controlsUrl,
    [DELIVERY_ENV_KEYS.token]: descriptor.token,
    ...(descriptor.resume !== undefined && { [DELIVERY_ENV_KEYS.resume]: descriptor.resume }),
  };
}

// The opening instruction of the session. It names the env keys, never the
// token itself: the prompt may be shown in a terminal or a process list.
export function deliveryLaunchPrompt(request: DeliveryLaunchRequest): string {
  const lines = [
    request.descriptor.resume === undefined
      ? `Deliver the spec ${request.specSlug}.`
      : `Resume the delivery ${request.descriptor.resume} of the spec ${request.specSlug}.`,
    `Post each delivery event to $${DELIVERY_ENV_KEYS.eventUrl} with $${DELIVERY_ENV_KEYS.token} as the bearer token, and read the operator's controls from $${DELIVERY_ENV_KEYS.controlsUrl}.`,
  ];
  return lines.join(" ");
}

export const defaultDeliveryLaunchExecutor: DeliveryLaunchExecutor = {
  async launch(request) {
    const project = projectRegistry.getProject(request.projectId);
    const settings = stateService.loadSettings();
    const agentPluginId = resolveLaunchAgentId({
      ...(settings.jigs?.defaultAgentPluginId !== undefined && {
        defaultAgentPluginId: settings.jigs.defaultAgentPluginId,
      }),
    });
    if (agentPluginId === undefined) {
      throw new DeliveryLaunchError(
        "No AI coding agent is available to run the delivery. Install an agent plugin from Settings > AI Agents.",
      );
    }
    const { session } = await terminalService.createAgentSession({
      projectId: request.projectId,
      benchId: request.benchId,
      workspacePath: request.workspacePath,
      projectName: project?.config?.project?.displayName ?? request.projectId,
      agentPluginId,
      initialInput: deliveryLaunchPrompt(request),
      env: deliveryLaunchEnv(request.descriptor),
      permissions: toLaunchPermissions(stateService.getProjectPermissions(request.projectId)),
    });
    return { sessionId: session.id };
  },
};

let executor: DeliveryLaunchExecutor = defaultDeliveryLaunchExecutor;

/** Swaps the agent launch executor. */
export function setDeliveryLaunchExecutor(next: DeliveryLaunchExecutor): void {
  executor = next;
}

/** Puts the default agent launch executor back. */
export function resetDeliveryLaunchExecutor(): void {
  executor = defaultDeliveryLaunchExecutor;
}

/** The origin a session on this machine reaches the server at. */
export function deliveryOrigin(): string {
  return `http://localhost:${process.env.ROUBO_PORT || DEFAULT_ROUBO_PORT}`;
}

function specSlugOf(bench: Bench): string {
  const folder = bench.focusedSpecPath ?? "";
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function bindingKey(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

// The benches whose launch is in flight: the executor has not answered yet, so
// no session id is recorded, but a second launch must still wait.
const launching = new Set<string>();

/** Why a new delivery token cannot be minted for a bench now. */
export type DeliveryLaunchBlock = "clearing" | "error" | "session_live";

/**
 * The block on minting a new delivery token for the bench, or undefined when
 * there is none: the bench is clearing or in error, or the main session it
 * launched is still live or still starting.
 */
export function deliveryLaunchBlock(bench: Bench): DeliveryLaunchBlock | undefined {
  if (bench.status === "clearing" || bench.status === "error") return bench.status;
  if (launching.has(bindingKey(bench.projectId, bench.id))) return "session_live";
  const sessionId = bench.deliverySessionId;
  if (sessionId !== undefined && terminalService.getSession(sessionId)?.status === "live") {
    return "session_live";
  }
  return undefined;
}

/** Thrown by launchDeliverySession when deliveryLaunchBlock refuses the launch. */
export class DeliveryLaunchBlockedError extends Error {
  constructor(readonly block: DeliveryLaunchBlock) {
    super(
      block === "session_live"
        ? "The delivery session of this bench is still running"
        : `The bench is ${block === "clearing" ? "being cleared" : "in error"}`,
    );
    this.name = "DeliveryLaunchBlockedError";
  }
}

function descriptorFor(bench: Bench, token: string, resume?: string): DeliveryLaunchDescriptor {
  return buildDeliveryLaunchDescriptor({
    origin: deliveryOrigin(),
    projectId: bench.projectId,
    benchId: bench.id,
    token,
    ...(resume !== undefined && { resume }),
  });
}

/**
 * Mints a token and launches the main delivery session in the bench workspace,
 * then records the launched session's id on the bench. `resume` is the
 * record's resume argument when the session continues a delivery. Throws
 * DeliveryLaunchBlockedError, launching nothing and minting nothing, when
 * deliveryLaunchBlock refuses.
 */
export async function launchDeliverySession(
  bench: Bench,
  options: { resume?: string } = {},
): Promise<DeliveryLaunchResult> {
  const block = deliveryLaunchBlock(bench);
  if (block !== undefined) throw new DeliveryLaunchBlockedError(block);
  const k = bindingKey(bench.projectId, bench.id);
  launching.add(k);
  try {
    const token = mintDeliveryToken(bench);
    const result = await executor.launch({
      projectId: bench.projectId,
      benchId: bench.id,
      workspacePath: bench.workspacePath,
      specSlug: specSlugOf(bench),
      descriptor: descriptorFor(bench, token, options.resume),
    });
    bench.deliverySessionId = result.sessionId;
    return result;
  } finally {
    launching.delete(k);
  }
}

/**
 * Attach mode's token handout: mints a token for the session that already runs
 * the delivery and returns its descriptor, which carries the plain token, so
 * the operator can hand it to that session. Launches nothing. Throws
 * DeliveryLaunchBlockedError when deliveryLaunchBlock refuses, since the new
 * mint would revoke the token of the session the bench launched.
 */
export function handOutDeliveryToken(bench: Bench): DeliveryLaunchDescriptor {
  const block = deliveryLaunchBlock(bench);
  if (block !== undefined) throw new DeliveryLaunchBlockedError(block);
  return descriptorFor(bench, mintDeliveryToken(bench));
}

const bindings = new Map<string, Promise<void>>();

/**
 * Binds a newly created Spec Bench to its delivery, once its workspace is
 * provisioned: launch mode launches, attach mode launches nothing and mints
 * nothing (its token is minted when POST /delivery/attach hands it out). A
 * launch that fails leaves a notification on the bench; it never fails the
 * create, which has already answered. Cleanup & Retry calls it again for the
 * re-provisioned workspace, and POST /delivery/launch tries a failed launch
 * again.
 */
export function bindDeliveryOnCreate(bench: Bench): Promise<void> {
  const k = bindingKey(bench.projectId, bench.id);
  const binding = (async () => {
    await benchManager.whenWorkspaceProvisioned(bench.projectId, bench.id);
    const live = benchManager.getBench(bench.projectId, bench.id);
    if (!live || live.variant !== "specbench") return;
    if (live.status === "error" || live.status === "clearing") return;
    if (live.deliveryBindMode === "attach") return;
    try {
      await launchDeliverySession(live);
    } catch (err) {
      // The status was checked above and nothing else launches before this
      // binding settles, so a block here means a session already runs or is
      // starting: that is no failure to report.
      if (err instanceof DeliveryLaunchBlockedError) return;
      const reason = err instanceof Error && err.message ? err.message : String(err);
      console.warn(`[delivery] the delivery session of bench ${live.id} did not start:`, err);
      createNotification(live, "agent-launch-failed", undefined, {
        message: `The delivery session did not start: ${reason}`,
      });
    }
  })().finally(() => {
    if (bindings.get(k) === binding) bindings.delete(k);
  });
  bindings.set(k, binding);
  return binding;
}

/** Resolves once a bench's create-time binding has run. */
export function whenDeliveryBound(projectId: string, benchId: number): Promise<void> {
  return bindings.get(bindingKey(projectId, benchId)) ?? Promise.resolve();
}
