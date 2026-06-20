import fs from "node:fs";
import path from "node:path";
import {
  ProvisionDescriptorSchema,
  SUPPORTED_PROVISION_SCHEMA_VERSION,
  type ProvisionDescriptor,
  type DockerProvisionDescriptor,
  type ProcessProvisionDescriptor,
  type OneshotProvisionDescriptor,
} from "@roubo/shared/provision-descriptor-schema";
import type { ComponentPhase, ComponentStatus } from "@roubo/shared";
import { parseCommand } from "./exec.js";
import * as processManager from "./process-manager.js";
import * as dockerService from "./docker.js";
import * as ledger from "./resource-ownership-ledger.js";

/**
 * The generic host-side LifecycleEngine (T1.5, issue #606).
 *
 * A component plugin's `translate(config)` emits a typed ProvisionDescriptor;
 * this engine is the declarative execution path that validates the descriptor's
 * schemaVersion, records ownership, and drives the docker / process / oneshot
 * phase sequence to completion. It pushes ComponentStatus (never polled,
 * NFR-002) and introduces the `completed` terminal state for a successful
 * one-shot (FR-014 / FR-022).
 *
 * Per spike #600 (SPK-3, architecture.md "Open questions"), the engine
 * sequences the fine-grained host operations (composeUp -> waitForHealthy ->
 * composeRunInit -> migration; startProcess / runProcess) coarsely IN-HOST to
 * stay within the NFR-002 budget. It does not call the broker over RPC to
 * itself; the broker remains the RPC surface only for the imperative escape
 * hatch. Host services are injected (mirroring the broker's
 * ProcessManagerLike / DockerLike dependency-injection style) so the engine is
 * unit-testable without real docker or real processes.
 *
 * Out of scope here (covered elsewhere): removing the bench-manager type
 * dispatch (F1.11) and crash cleanup / recovery (F1.12). The engine is added
 * ALONGSIDE the existing path; SSE wiring of the reportStatus sink is the
 * caller's concern, keeping the engine pure.
 */

/** The subset of process-manager the engine drives. Mirrors the broker's Pick. */
export type ProcessManagerLike = Pick<typeof processManager, "startProcess" | "runProcess">;

/** The subset of the docker facade the engine drives. Mirrors the broker's Pick. */
export type DockerLike = Pick<
  typeof dockerService,
  "composeUp" | "waitForHealthy" | "composeRunInit" | "getContainerId" | "getComposeProjectName"
>;

/** The subset of the ResourceOwnershipLedger the engine writes to (FR-015). */
export type LedgerLike = Pick<typeof ledger, "recordProcess" | "recordComposeProject">;

export interface LifecycleEngineDeps {
  processManager?: ProcessManagerLike;
  docker?: DockerLike;
  ledger?: LedgerLike;
}

/**
 * Per-bench-component execution context the engine needs. Ports are pre-resolved
 * host-side; `reportStatus` is the push sink (the caller wires it to SSE).
 */
export interface LifecycleContext {
  /** The owning plugin id, the ledger key alongside benchId (FR-015). */
  pluginId: string;
  /** The numeric project id, used to derive the compose project name. */
  projectId: string;
  /** The bench number, the ledger key alongside pluginId (FR-015). */
  benchId: number;
  /** The component this descriptor provisions. */
  componentName: string;
  /** The bench workspace directory; the cwd for compose / process operations. */
  workspacePath: string;
  /** Host-allocated ports for this bench, keyed by component name. */
  ports: Record<string, number>;
  /** Push sink for ComponentStatus updates (never polled, NFR-002). */
  reportStatus: (status: ComponentStatus) => void;
  /**
   * Whether the component's one-time `setup` has already run on this bench.
   * Lets a Stop -> Start cycle skip re-running setup (FR-007 parity). When
   * undefined, setup runs if the descriptor declares it.
   */
  setupComplete?: boolean;
}

/** The connection string resolved for a docker component, when one is templated. */
export interface LifecycleResult {
  status: ComponentStatus["status"];
  connection?: string;
}

const DEFAULT_PORT_ENV_VAR = "HOST_PORT";
const MIGRATION_TIMEOUT_MS = 300_000;
const INIT_TIMEOUT_MS = 120_000;

/**
 * Validate and execute one ProvisionDescriptor end-to-end. Resolves with the
 * terminal status (and the connection string for a docker component). The
 * descriptor is validated FIRST: a schemaVersion (or any shape) mismatch is
 * rejected before any host-service call or ledger write, and the component is
 * driven to `error` with a clear message (AC4).
 */
export async function runDescriptor(
  rawDescriptor: unknown,
  ctx: LifecycleContext,
  deps: LifecycleEngineDeps = {},
): Promise<LifecycleResult> {
  const pm = deps.processManager ?? processManager;
  const docker = deps.docker ?? dockerService;
  const led = deps.ledger ?? ledger;

  // --- Validation gate (AC4): reject before any host call or ledger write. ---
  const parsed = ProvisionDescriptorSchema.safeParse(rawDescriptor);
  if (!parsed.success) {
    const message = describeValidationFailure(rawDescriptor, parsed.error);
    return pushError(ctx, message);
  }

  const descriptor = parsed.data;
  try {
    switch (descriptor.kind) {
      case "docker":
        return await runDocker(descriptor, ctx, pm, docker, led);
      case "process":
        return await runProcess(descriptor, ctx, pm, led);
      case "oneshot":
        return await runOneshot(descriptor, ctx, pm, led);
    }
  } catch (err) {
    return pushError(ctx, err instanceof Error ? err.message : String(err));
  }
}

// --- docker phase machine (AC1) --------------------------------------------

async function runDocker(
  descriptor: DockerProvisionDescriptor,
  ctx: LifecycleContext,
  pm: ProcessManagerLike,
  docker: DockerLike,
  led: LedgerLike,
): Promise<LifecycleResult> {
  const phases: ComponentPhase[] = makeDockerPhases(descriptor);
  const projectName = docker.getComposeProjectName(ctx.projectId, ctx.benchId);

  // Resolve the allocated port into the compose env under portEnvVar.
  const port = ctx.ports[ctx.componentName];
  const portOverrides: Record<string, string> = {};
  if (typeof port === "number") {
    portOverrides[descriptor.portEnvVar ?? DEFAULT_PORT_ENV_VAR] = String(port);
  }

  push(ctx, "starting", phases, "Starting container");
  const up = await docker.composeUp({
    composeFile: descriptor.composeFile,
    service: descriptor.service,
    projectName,
    portOverrides,
    cwd: ctx.workspacePath,
  });
  if (!up.success) {
    throw new Error(up.error ?? "composeUp failed");
  }
  // Record the compose project as soon as it is up (AC5), so the orphan sweep
  // can reap it even if a later phase throws.
  led.recordComposeProject(ctx.pluginId, ctx.benchId, projectName);

  push(ctx, "starting", phases, "Waiting for healthy");
  const healthy = await docker.waitForHealthy(projectName, descriptor.service);
  if (!healthy) {
    throw new Error(`Container '${descriptor.service}' did not become healthy within timeout`);
  }

  if (descriptor.initService) {
    push(ctx, "starting", phases, "Running init component");
    const init = await docker.composeRunInit({
      composeFile: descriptor.composeFile,
      initService: descriptor.initService,
      projectName,
      portOverrides,
      cwd: ctx.workspacePath,
      timeoutMs: INIT_TIMEOUT_MS,
    });
    if (!init.success) {
      throw new Error(init.error ?? "init service failed");
    }
  }

  if (descriptor.migration) {
    push(ctx, "starting", phases, "Running migrations");
    const parts = parseCommand(descriptor.migration.command);
    if (parts.length === 0) {
      throw new Error("migration command is empty");
    }
    const migrationId = `${ctx.pluginId}:${ctx.benchId}:${ctx.componentName}:migration`;
    const { exitCode } = await pm.runProcess(
      migrationId,
      parts[0],
      parts.slice(1).concat(descriptor.migration.args ?? []),
      portOverrides,
      ctx.workspacePath,
      MIGRATION_TIMEOUT_MS,
    );
    if (exitCode !== 0) {
      throw new Error(`migration failed with exit code ${exitCode}`);
    }
  }

  const connection =
    descriptor.connection && typeof port === "number"
      ? resolveConnectionTemplate(descriptor.connection.template, ctx.componentName, port)
      : descriptor.connection?.template;

  completePhases(phases);
  push(ctx, "running", phases);
  return { status: "running", connection };
}

// --- process phase machine (AC2) -------------------------------------------

async function runProcess(
  descriptor: ProcessProvisionDescriptor,
  ctx: LifecycleContext,
  pm: ProcessManagerLike,
  led: LedgerLike,
): Promise<LifecycleResult> {
  const cwd = descriptor.cwd ? path.resolve(ctx.workspacePath, descriptor.cwd) : ctx.workspacePath;
  // envFile is the engine's concern (architecture.md "Data model"): read and
  // merge it into env, with the descriptor's explicit env winning on conflict.
  const env = mergeEnv(descriptor.env, descriptor.envFile, ctx.workspacePath);

  const phases: ComponentPhase[] = [];
  const needsSetup = !!descriptor.setup && ctx.setupComplete !== true;
  if (needsSetup) {
    phases.push({ label: "Installing dependencies", status: "pending" });
  }
  phases.push({ label: "Starting process", status: "pending" });

  // Optional one-time setup, skipped on a Stop -> Start cycle (FR-007 parity).
  if (needsSetup) {
    push(ctx, "starting", phases, "Installing dependencies");
    const parts = parseCommand(descriptor.setup as string);
    if (parts.length === 0) {
      throw new Error("setup command is empty");
    }
    const setupId = `${ctx.pluginId}:${ctx.benchId}:${ctx.componentName}:setup`;
    const { exitCode } = await pm.runProcess(setupId, parts[0], parts.slice(1), env, cwd, 0);
    if (exitCode !== 0) {
      throw new Error(`setup failed with exit code ${exitCode}`);
    }
  }

  push(ctx, "starting", phases, "Starting process");
  const parts = parseCommand(descriptor.command);
  if (parts.length === 0) {
    throw new Error("process command is empty");
  }
  const processId = `${ctx.pluginId}:${ctx.benchId}:${ctx.componentName}`;
  const { pid } = await pm.startProcess(processId, parts[0], parts.slice(1), env, cwd);
  led.recordProcess(ctx.pluginId, ctx.benchId, processId);

  completePhases(phases);
  push(ctx, "running", phases, undefined, { pid });
  return { status: "running" };
}

// --- oneshot phase machine (AC2, AC3) --------------------------------------

async function runOneshot(
  descriptor: OneshotProvisionDescriptor,
  ctx: LifecycleContext,
  pm: ProcessManagerLike,
  led: LedgerLike,
): Promise<LifecycleResult> {
  const cwd = descriptor.cwd ? path.resolve(ctx.workspacePath, descriptor.cwd) : ctx.workspacePath;
  const env = mergeEnv(descriptor.env, descriptor.envFile, ctx.workspacePath);

  const phases: ComponentPhase[] = [{ label: "Running", status: "pending" }];
  push(ctx, "starting", phases, "Running");

  const parts = parseCommand(descriptor.command);
  if (parts.length === 0) {
    throw new Error("oneshot command is empty");
  }
  const processId = `${ctx.pluginId}:${ctx.benchId}:${ctx.componentName}`;
  led.recordProcess(ctx.pluginId, ctx.benchId, processId);

  const { exitCode } = await pm.runProcess(
    processId,
    parts[0],
    parts.slice(1),
    env,
    cwd,
    descriptor.timeoutMs ?? 0,
  );

  if (exitCode !== 0) {
    // A non-zero exit (or a timeoutMs breach, which process-manager surfaces as
    // a non-zero exit code) drives the component to error, not completed.
    return pushError(ctx, `one-shot exited with code ${exitCode}`, completePhasesError(phases));
  }

  completePhases(phases);
  // A successful one-shot reaches the `completed` terminal state (AC3), distinct
  // from `stopped` (idle) and `error` (failed).
  push(ctx, "completed", phases);
  return { status: "completed" };
}

// --- helpers ---------------------------------------------------------------

function makeDockerPhases(descriptor: DockerProvisionDescriptor): ComponentPhase[] {
  const phases: ComponentPhase[] = [
    { label: "Starting container", status: "pending" },
    { label: "Waiting for healthy", status: "pending" },
  ];
  if (descriptor.initService) {
    phases.push({ label: "Running init component", status: "pending" });
  }
  if (descriptor.migration) {
    phases.push({ label: "Running migrations", status: "pending" });
  }
  return phases;
}

/**
 * Resolve a connection template against the allocated port. Supports `{{port}}`
 * and `{{ports.<componentName>}}` placeholders, the same brace syntax built-in
 * connection strings use, so a plugin's translate emits a template the engine
 * fills with the host-allocated port (FR-007 connection-templating parity).
 */
function resolveConnectionTemplate(template: string, componentName: string, port: number): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    const key = expr.trim();
    if (key === "port") return String(port);
    if (key === `ports.${componentName}`) return String(port);
    return `{{${key}}}`;
  });
}

/**
 * Read `envFile` (relative to the workspace root) and merge its KEY=VALUE lines
 * under the explicit `env`, which wins on conflict. A missing file is ignored
 * (the plugin may declare an envFile the host writes elsewhere). This merge is
 * the engine's responsibility, not the plugin's pure translate (architecture.md
 * "Data model"), preserving FR-005 / FR-007 env/envFile injection parity.
 */
function mergeEnv(
  env: Record<string, string> | undefined,
  envFile: string | undefined,
  workspacePath: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (envFile) {
    const filePath = path.join(workspacePath, envFile);
    let contents: string | undefined;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch {
      contents = undefined;
    }
    if (contents !== undefined) {
      for (const rawLine of contents.split("\n")) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = stripQuotes(line.slice(eq + 1).trim());
        merged[key] = value;
      }
    }
  }
  if (env) {
    for (const [k, v] of Object.entries(env)) merged[k] = v;
  }
  return merged;
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Build a clear validation-failure message. A schemaVersion mismatch is the
 * headline case: surface the supplied version and the supported one so the
 * operator sees exactly why the descriptor was rejected (FR-017).
 */
function describeValidationFailure(raw: unknown, error: { message: string }): string {
  if (raw && typeof raw === "object" && "schemaVersion" in raw) {
    const supplied = (raw as { schemaVersion: unknown }).schemaVersion;
    if (supplied !== SUPPORTED_PROVISION_SCHEMA_VERSION) {
      return `Unsupported descriptor schemaVersion ${JSON.stringify(
        supplied,
      )}; this host supports schemaVersion ${SUPPORTED_PROVISION_SCHEMA_VERSION}`;
    }
  }
  return `Invalid ProvisionDescriptor: ${error.message}`;
}

function push(
  ctx: LifecycleContext,
  status: ComponentStatus["status"],
  phases: ComponentPhase[],
  detail?: string,
  extra: Partial<ComponentStatus> = {},
): void {
  if (detail) {
    for (const phase of phases) {
      if (phase.label === detail) phase.status = "running";
      else if (phase.status === "running") phase.status = "done";
    }
  }
  ctx.reportStatus({
    name: ctx.componentName,
    status,
    phases: phases.length > 0 ? phases.map((p) => ({ ...p })) : undefined,
    setupComplete: ctx.setupComplete ?? true,
    statusDetail: detail,
    ...extra,
  });
}

function pushError(
  ctx: LifecycleContext,
  message: string,
  phases: ComponentPhase[] = [],
): LifecycleResult {
  ctx.reportStatus({
    name: ctx.componentName,
    status: "error",
    error: message,
    phases: phases.length > 0 ? phases.map((p) => ({ ...p })) : undefined,
    setupComplete: ctx.setupComplete ?? true,
  });
  return { status: "error" };
}

function completePhases(phases: ComponentPhase[]): void {
  for (const phase of phases) phase.status = "done";
}

/** Mark the currently-running phase as errored, leaving the rest. */
function completePhasesError(phases: ComponentPhase[]): ComponentPhase[] {
  for (const phase of phases) {
    if (phase.status === "running") phase.status = "error";
  }
  return phases;
}

export type { ProvisionDescriptor };
