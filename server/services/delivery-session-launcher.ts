// Binds a Spec Bench to its delivery session (SB-FR-002, SB-FR-003, SB-US-001,
// SB-US-002).
//
//   launch  Once the bench workspace exists, mint a delivery token, build the
//           launch descriptor and pass it to the agent launch executor, which
//           starts the main delivery session in the bench workspace.
//   attach  Adopt the delivery whose record is already in the spec folder. A
//           token is minted, so a session the operator points at the bench can
//           post events, but nothing is launched.
//   resume  Launch again with the record's resume argument, on a fresh token.
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

/**
 * Mints a token and launches the main delivery session in the bench workspace.
 * `resume` is the record's resume argument when the session continues a
 * delivery.
 */
export async function launchDeliverySession(
  bench: Bench,
  options: { resume?: string } = {},
): Promise<DeliveryLaunchResult> {
  const token = mintDeliveryToken(bench);
  const descriptor = buildDeliveryLaunchDescriptor({
    origin: deliveryOrigin(),
    projectId: bench.projectId,
    benchId: bench.id,
    token,
    ...(options.resume !== undefined && { resume: options.resume }),
  });
  return executor.launch({
    projectId: bench.projectId,
    benchId: bench.id,
    workspacePath: bench.workspacePath,
    specSlug: specSlugOf(bench),
    descriptor,
  });
}

const bindings = new Map<string, Promise<void>>();

function bindingKey(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

/**
 * Binds a newly created Spec Bench to its delivery, once its workspace is
 * provisioned: launch mode launches, attach mode only mints the token. A
 * launch that fails leaves a notification on the bench; it never fails the
 * create, which has already answered.
 */
export function bindDeliveryOnCreate(bench: Bench): Promise<void> {
  const k = bindingKey(bench.projectId, bench.id);
  const binding = (async () => {
    await benchManager.whenWorkspaceProvisioned(bench.projectId, bench.id);
    const live = benchManager.getBench(bench.projectId, bench.id);
    if (!live || live.variant !== "specbench") return;
    if (live.status === "error" || live.status === "clearing") return;
    if (live.deliveryBindMode === "attach") {
      mintDeliveryToken(live);
      return;
    }
    try {
      await launchDeliverySession(live);
    } catch (err) {
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
