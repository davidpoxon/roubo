import { ResponseError } from "vscode-jsonrpc/node.js";
import type {
  BrokerContext,
  BrokerPermissionCategory,
  BrokerPermissionDeniedData,
  CapabilityQueryResult,
  ComponentLogLine,
  ComponentStatus,
} from "@roubo/shared";
import type { JsonRpcConnection } from "./plugin-rpc.js";
import * as processManager from "./process-manager.js";
import * as dockerService from "./docker.js";

// JSON-RPC server-error range; mirrors the conventions in plugin-host-api.ts so
// broker errors look identical to the rest of the host surface. The
// permission-denied code matches plugin-fs.ts / plugin-spawn.ts /
// plugin-host-api.ts so every host surface speaks one denial code (F2.1, #618).
const INVALID_PARAMS_CODE = -32602;
const INTERNAL_ERROR_CODE = -32603;
const PERMISSION_DENIED_CODE = -32001;

/**
 * The broker API version. Every method in the v1 surface ships in this version,
 * so `host.capability.query` reports it as each known method's `introducedIn`.
 * Bump this (and split the registry) when a later additive change introduces a
 * method in a newer version. This is the call-time per-method gate from SPK-3;
 * the load-time `HOST_API_VERSION` semver gate is a separate concern handled at
 * plugin validation, not here.
 */
export const BROKER_API_VERSION = "1.0.0";

/**
 * Canonical registry of every broker method and the version it was introduced
 * in. This is the single source of truth for both `host.capability.query`
 * (known vs unknown) and the set of methods the broker registers. An unknown
 * method (not in this map) reports `{ available: false }` from the query and, if
 * actually invoked, returns the built-in JSON-RPC METHOD_NOT_FOUND (-32601)
 * error from vscode-jsonrpc, never a host crash (FR-017).
 */
export const BROKER_METHODS: Readonly<Record<string, string>> = Object.freeze({
  "host.process.start": BROKER_API_VERSION,
  "host.process.run": BROKER_API_VERSION,
  "host.process.stop": BROKER_API_VERSION,
  "host.process.status": BROKER_API_VERSION,
  "host.process.logs": BROKER_API_VERSION,
  "host.docker.composeUp": BROKER_API_VERSION,
  "host.docker.waitForHealthy": BROKER_API_VERSION,
  "host.docker.composeRunInit": BROKER_API_VERSION,
  "host.docker.composeStop": BROKER_API_VERSION,
  "host.docker.composeDown": BROKER_API_VERSION,
  "host.docker.assignContainer": BROKER_API_VERSION,
  "host.ports.get": BROKER_API_VERSION,
  "host.component.reportStatus": BROKER_API_VERSION,
  "host.component.reportLog": BROKER_API_VERSION,
  "host.capability.query": BROKER_API_VERSION,
});

export type ProcessManagerLike = Pick<
  typeof processManager,
  "startProcess" | "runProcess" | "stopProcess" | "getProcessStatus" | "getProcessLogs"
>;

export type DockerLike = Pick<
  typeof dockerService,
  | "composeUp"
  | "waitForHealthy"
  | "composeRunInit"
  | "composeStop"
  | "composeDown"
  | "getContainerId"
>;

export interface BrokerLogger {
  (level: "info" | "warn" | "error", text: string): void;
}

export interface CreateBrokerOptions {
  processManager?: ProcessManagerLike;
  docker?: DockerLike;
  log?: BrokerLogger;
}

function invalidParams(method: string, message: string): never {
  throw new ResponseError(INVALID_PARAMS_CODE, `${method}: ${message}`, {
    code: "invalid-params",
  });
}

function wrapInternal(method: string, log: BrokerLogger, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "internal-error";
  log("error", `${method} failed: ${code}: ${message}`);
  throw new ResponseError(INTERNAL_ERROR_CODE, message, { code });
}

function requireString(method: string, name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidParams(method, `${name} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(method: string, name: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    invalidParams(method, `${name} must be an array of strings`);
  }
  return value as string[];
}

function requireEnv(method: string, value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    invalidParams(method, "env must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      invalidParams(method, `env["${k}"] must be a string`);
    }
    out[k] = v;
  }
  return out;
}

function requireNumber(method: string, name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidParams(method, `${name} must be a finite number`);
  }
  return value;
}

/**
 * Permission gate (F2.1, #618). Throws a permission-denied ResponseError when
 * the plugin did not declare the category the method needs, so a broker call
 * outside the consented categories never reaches the host delegate. Mirrors the
 * denyFs / denyProcesses pattern in plugin-fs.ts / plugin-spawn.ts: same
 * permission-denied code and structured data shape across every host surface.
 * Centralised here because the broker is the single privileged choke-point, so
 * one gate covers every host.process.* / host.docker.* / host.ports.* method.
 *
 * Every gated (privileged) call also records one AuditEntry through
 * `ctx.recordAudit` (FR-019): outcome "allowed" when the plugin holds the
 * category, "denied" when it does not. The raw incoming `params` are captured
 * here, before per-param validation, and the entry is recorded BEFORE the
 * permission-denied throw, so a denied call (now hard-enforced) still appears in
 * the audit log with its arguments and a "denied" outcome.
 */
function enforcePermission(
  ctx: BrokerContext,
  method: string,
  category: BrokerPermissionCategory,
  params: unknown,
  log: BrokerLogger,
): void {
  const allowed = ctx.hasPermission(category);
  ctx.recordAudit({
    ts: new Date().toISOString(),
    pluginId: ctx.pluginId,
    benchId: ctx.benchId,
    method,
    params,
    outcome: allowed ? "allowed" : "denied",
  });
  if (!allowed) {
    const data: BrokerPermissionDeniedData = {
      code: "permission-denied",
      category,
      method,
      reason: "category-not-declared",
    };
    log("warn", `${method} denied: category="${category}" reason="${data.reason}"`);
    throw new ResponseError<BrokerPermissionDeniedData>(
      PERMISSION_DENIED_CODE,
      `Permission denied: ${data.reason} for category "${category}"`,
      data,
    );
  }
}

interface ProcessStartParams {
  id?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}

interface ProcessRunParams extends ProcessStartParams {
  timeoutMs?: unknown;
}

interface ComposeBaseParams {
  projectName?: unknown;
  composeFile?: unknown;
  cwd?: unknown;
}

/**
 * Register every HostComponentBroker RPC handler on a per-bench JSON-RPC
 * connection. Mirrors registerHostHandlers in plugin-host-api.ts: a thin
 * adapter per method that validates params, delegates to the existing
 * process-manager / docker services, and maps the service shape to the frozen
 * broker contract (architecture.md "Interfaces / contracts", SPK-3).
 *
 * Permission is enforced (F2.1, #618): each handler calls enforcePermission
 * before delegating, so a call outside the plugin's consented categories throws
 * a permission-denied error and the host delegate never runs.
 */
export function registerBrokerHandlers(
  connection: JsonRpcConnection,
  ctx: BrokerContext,
  options: CreateBrokerOptions = {},
): void {
  const pm: ProcessManagerLike = options.processManager ?? processManager;
  const docker: DockerLike = options.docker ?? dockerService;
  const log: BrokerLogger = options.log ?? (() => {});

  // --- host.process.* (delegate to process-manager) -------------------------

  connection.onRequest<ProcessStartParams, { pid: number }>(
    "host.process.start",
    async (params) => {
      const method = "host.process.start";
      enforcePermission(ctx, method, "process", params, log);
      const id = requireString(method, "id", params?.id);
      const command = requireString(method, "command", params?.command);
      const args = requireStringArray(method, "args", params?.args);
      const env = requireEnv(method, params?.env);
      const cwd = requireString(method, "cwd", params?.cwd);
      try {
        return await pm.startProcess(id, command, args, env, cwd);
      } catch (err) {
        wrapInternal(method, log, err);
      }
    },
  );

  connection.onRequest<ProcessRunParams, { exitCode: number }>(
    "host.process.run",
    async (params) => {
      const method = "host.process.run";
      enforcePermission(ctx, method, "process", params, log);
      const id = requireString(method, "id", params?.id);
      const command = requireString(method, "command", params?.command);
      const args = requireStringArray(method, "args", params?.args);
      const env = requireEnv(method, params?.env);
      const cwd = requireString(method, "cwd", params?.cwd);
      const timeoutMs =
        params?.timeoutMs === undefined ? 0 : requireNumber(method, "timeoutMs", params.timeoutMs);
      try {
        return await pm.runProcess(id, command, args, env, cwd, timeoutMs);
      } catch (err) {
        wrapInternal(method, log, err);
      }
    },
  );

  connection.onRequest<{ id?: unknown }, null>("host.process.stop", async (params) => {
    const method = "host.process.stop";
    enforcePermission(ctx, method, "process", params, log);
    const id = requireString(method, "id", params?.id);
    try {
      await pm.stopProcess(id);
      return null;
    } catch (err) {
      wrapInternal(method, log, err);
    }
  });

  connection.onRequest<{ id?: unknown }, { alive: boolean; exitCode?: number }>(
    "host.process.status",
    (params) => {
      const method = "host.process.status";
      enforcePermission(ctx, method, "process", params, log);
      const id = requireString(method, "id", params?.id);
      try {
        const status = pm.getProcessStatus(id);
        return status.exitCode === null
          ? { alive: status.alive }
          : { alive: status.alive, exitCode: status.exitCode };
      } catch (err) {
        wrapInternal(method, log, err);
      }
    },
  );

  connection.onRequest<{ id?: unknown }, string[]>("host.process.logs", (params) => {
    const method = "host.process.logs";
    enforcePermission(ctx, method, "process", params, log);
    const id = requireString(method, "id", params?.id);
    try {
      return pm.getProcessLogs(id);
    } catch (err) {
      wrapInternal(method, log, err);
    }
  });

  // --- host.docker.* (delegate to the docker facade) ------------------------

  connection.onRequest<
    ComposeBaseParams & { service?: unknown; env?: unknown },
    { containerId: string }
  >("host.docker.composeUp", async (params) => {
    const method = "host.docker.composeUp";
    enforcePermission(ctx, method, "docker", params, log);
    const projectName = requireString(method, "projectName", params?.projectName);
    const composeFile = requireString(method, "composeFile", params?.composeFile);
    const cwd = requireString(method, "cwd", params?.cwd);
    const service = requireString(method, "service", params?.service);
    // The frozen contract names this `env`; the docker facade calls it
    // `portOverrides` (env vars for compose interpolation). Same shape, so we
    // reconcile by passing the broker `env` straight through.
    const env = requireEnv(method, params?.env);
    try {
      const result = await docker.composeUp({
        projectName,
        composeFile,
        cwd,
        service,
        portOverrides: env,
      });
      if (!result.success) {
        throw new ResponseError(INTERNAL_ERROR_CODE, result.error ?? "composeUp failed", {
          code: "compose-up-failed",
        });
      }
      // composeUp does not return a containerId, so resolve it after success.
      const containerId = await docker.getContainerId(projectName, service);
      if (!containerId) {
        throw new ResponseError(
          INTERNAL_ERROR_CODE,
          `composeUp succeeded but no container found for service "${service}"`,
          { code: "container-not-found" },
        );
      }
      return { containerId };
    } catch (err) {
      if (err instanceof ResponseError) throw err;
      wrapInternal(method, log, err);
    }
  });

  connection.onRequest<
    { projectName?: unknown; service?: unknown; timeoutMs?: unknown },
    { healthy: boolean }
  >("host.docker.waitForHealthy", async (params) => {
    const method = "host.docker.waitForHealthy";
    enforcePermission(ctx, method, "docker", params, log);
    const projectName = requireString(method, "projectName", params?.projectName);
    const service = requireString(method, "service", params?.service);
    const timeoutMs =
      params?.timeoutMs === undefined
        ? undefined
        : requireNumber(method, "timeoutMs", params.timeoutMs);
    try {
      const healthy = await docker.waitForHealthy(projectName, service, timeoutMs);
      return { healthy };
    } catch (err) {
      wrapInternal(method, log, err);
    }
  });

  connection.onRequest<ComposeBaseParams & { initService?: unknown }, null>(
    "host.docker.composeRunInit",
    async (params) => {
      const method = "host.docker.composeRunInit";
      enforcePermission(ctx, method, "docker", params, log);
      const projectName = requireString(method, "projectName", params?.projectName);
      const composeFile = requireString(method, "composeFile", params?.composeFile);
      const cwd = requireString(method, "cwd", params?.cwd);
      const initService = requireString(method, "initService", params?.initService);
      try {
        const result = await docker.composeRunInit({
          projectName,
          composeFile,
          cwd,
          initService,
          portOverrides: {},
        });
        if (!result.success) {
          throw new ResponseError(INTERNAL_ERROR_CODE, result.error ?? "composeRunInit failed", {
            code: "compose-run-init-failed",
          });
        }
        return null;
      } catch (err) {
        if (err instanceof ResponseError) throw err;
        wrapInternal(method, log, err);
      }
    },
  );

  connection.onRequest<ComposeBaseParams & { service?: unknown }, null>(
    "host.docker.composeStop",
    async (params) => {
      const method = "host.docker.composeStop";
      enforcePermission(ctx, method, "docker", params, log);
      const projectName = requireString(method, "projectName", params?.projectName);
      const composeFile = requireString(method, "composeFile", params?.composeFile);
      const cwd = requireString(method, "cwd", params?.cwd);
      // service is optional; when absent the docker facade stops the whole project.
      const service =
        params?.service === undefined
          ? undefined
          : requireString(method, "service", params.service);
      try {
        await docker.composeStop(projectName, composeFile, cwd, service);
        return null;
      } catch (err) {
        wrapInternal(method, log, err);
      }
    },
  );

  connection.onRequest<ComposeBaseParams, null>("host.docker.composeDown", async (params) => {
    const method = "host.docker.composeDown";
    enforcePermission(ctx, method, "docker", params, log);
    const projectName = requireString(method, "projectName", params?.projectName);
    const composeFile = requireString(method, "composeFile", params?.composeFile);
    const cwd = requireString(method, "cwd", params?.cwd);
    try {
      await docker.composeDown(projectName, composeFile, cwd);
      return null;
    } catch (err) {
      wrapInternal(method, log, err);
    }
  });

  connection.onRequest<{ componentName?: unknown; containerId?: unknown }, null>(
    "host.docker.assignContainer",
    (params) => {
      const method = "host.docker.assignContainer";
      // assignContainer is gated on the docker permission category (SPK-3 AC3).
      enforcePermission(ctx, method, "docker", params, log);
      const componentName = requireString(method, "componentName", params?.componentName);
      const containerId = requireString(method, "containerId", params?.containerId);
      try {
        // The ResourceOwnershipLedger is out of scope (T1.6); v1 records the
        // assignment through the injected sink only.
        ctx.assignContainer?.(componentName, containerId);
        return null;
      } catch (err) {
        wrapInternal(method, log, err);
      }
    },
  );

  // --- host.ports.* (read from pre-resolved context) ------------------------

  connection.onRequest<{ componentName?: unknown }, number>("host.ports.get", (params) => {
    const method = "host.ports.get";
    enforcePermission(ctx, method, "ports", params, log);
    const componentName = requireString(method, "componentName", params?.componentName);
    const port = ctx.ports[componentName];
    if (typeof port !== "number") {
      invalidParams(method, `no host-allocated port for component "${componentName}"`);
    }
    return port;
  });

  // --- host.component.* (push to injected sinks, no polling) -----------------

  connection.onRequest<ComponentStatus, null>("host.component.reportStatus", (params) => {
    const method = "host.component.reportStatus";
    if (!params || typeof params !== "object") {
      invalidParams(method, "status must be a ComponentStatus object");
    }
    requireString(method, "name", params.name);
    requireString(method, "status", params.status);
    try {
      ctx.reportStatus(params);
      return null;
    } catch (err) {
      wrapInternal(method, log, err);
    }
  });

  connection.onRequest<Partial<ComponentLogLine>, null>("host.component.reportLog", (params) => {
    const method = "host.component.reportLog";
    const source = params?.source;
    if (source !== "stdout" && source !== "stderr") {
      invalidParams(method, 'source must be "stdout" or "stderr"');
    }
    const text =
      typeof params?.text === "string"
        ? params.text
        : invalidParams(method, "text must be a string");
    const ts = requireString(method, "ts", params?.ts);
    try {
      ctx.reportLog({ source, text, ts });
      return null;
    } catch (err) {
      wrapInternal(method, log, err);
    }
  });

  // --- host.capability.query (version gate; never errors, FR-017) -----------

  connection.onRequest<{ method?: unknown }, CapabilityQueryResult>(
    "host.capability.query",
    (params) => {
      const queried = params?.method;
      if (typeof queried !== "string" || queried.length === 0) {
        // A malformed query is the one error case; an unknown-but-valid method
        // name returns { available: false }, never an error.
        invalidParams("host.capability.query", "method must be a non-empty string");
      }
      const introducedIn = BROKER_METHODS[queried];
      return introducedIn ? { available: true, introducedIn } : { available: false };
    },
  );
}
