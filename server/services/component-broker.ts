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
import * as ledger from "./resource-ownership-ledger.js";

// JSON-RPC server-error range; mirrors the conventions in plugin-host-api.ts so
// broker errors look identical to the rest of the host surface. The
// permission-denied code matches plugin-fs.ts / plugin-spawn.ts /
// plugin-host-api.ts so every host surface speaks one denial code (F2.1, #618).
const INVALID_PARAMS_CODE = -32602;
const INTERNAL_ERROR_CODE = -32603;
const PERMISSION_DENIED_CODE = -32001;
// Same code vscode-jsonrpc auto-replies for an unhandled method; the broker
// keeps the code but replaces the bare "Method not found" text with one that
// names the method and, when known, its minimum host version (#409, FR-017).
const METHOD_NOT_FOUND_CODE = -32601;

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

/**
 * Methods introduced in a host API version newer than the current surface
 * (BROKER_API_VERSION), mapped to the minimum host version that provides each.
 * This is the forward-compat extension point (#409): when a later additive
 * change ships a method a running host does not yet register, add it here so the
 * broker's method-not-found error can still name the version that provides it.
 * Empty today: BROKER_METHODS is the whole registered v1 surface, so no method
 * is yet "known but from a newer version".
 */
export const FUTURE_BROKER_METHODS: Readonly<Record<string, string>> = Object.freeze({});

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

/**
 * The subset of the ResourceOwnershipLedger the broker writes to (FR-015). Every
 * process the broker spawns on a plugin's behalf is recorded so the pre-restart
 * crash cleanup and the startup orphan sweep can reap it (#396, AC4).
 */
export type LedgerLike = Pick<typeof ledger, "recordProcess">;

export interface BrokerLogger {
  (level: "info" | "warn" | "error", text: string): void;
}

export interface CreateBrokerOptions {
  processManager?: ProcessManagerLike;
  docker?: DockerLike;
  /**
   * Ledger the broker records host-spawned processes into. Supplied by the
   * production caller (plugin-manager) so a broker-spawned process is
   * ledger-tracked; omitted in unit tests that do not assert ledger writes, in
   * which case no ledger I/O happens.
   */
  ledger?: LedgerLike;
  log?: BrokerLogger;
}

/**
 * How a registered set of broker handlers obtains the BrokerContext to service a
 * call. A component plugin is spawned ONCE per plugin and multiplexes benches
 * over the single shared connection (architecture.md 'Components'), but a
 * BrokerContext is per-(pluginId, benchId): it carries that bench's ports,
 * permission check, and audit sink. Every broker call now carries the `benchId`
 * it acts for in its params (the SDK stamps it from the in-flight lifecycle
 * call, #685), so the resolver routes the call to the exact bench by that key
 * rather than guessing. A host that owns the per-plugin connection registers the
 * handlers once and supplies this resolver; privileged calls then accumulate
 * audit entries into the originating bench's AuditLog. A plain BrokerContext (the
 * unit-test shape) is accepted too and is wrapped into a constant resolver that
 * ignores the benchId.
 *
 * Returning `null` (no bench bound to this plugin for the given benchId) makes a
 * privileged call fail with an internal-error rather than crashing the host.
 */
export type BrokerContextResolver = (benchId: number) => BrokerContext | null;

function invalidParams(method: string, message: string): never {
  throw new ResponseError(INVALID_PARAMS_CODE, `${method}: ${message}`, {
    code: "invalid-params",
  });
}

/**
 * Structured data attached to a method-not-found error so a plugin can react
 * programmatically: `introducedIn` is present only when the method is in the
 * known surface catalogue (a newer-version method, or a v1 method this host
 * build did not register).
 */
interface BrokerMethodNotFoundData {
  code: "method-not-found";
  method: string;
  introducedIn?: string;
}

/**
 * Build the broker's descriptive method-not-found error (#409, FR-017).
 * vscode-jsonrpc would otherwise auto-reply a bare -32601 that names nothing;
 * this keeps the -32601 code but names the method and, when the method is in the
 * known surface catalogue (FUTURE_BROKER_METHODS for a newer-version method,
 * unioned with BROKER_METHODS so a v1 method this host build did not register
 * still resolves), the minimum host version that provides it. A method in
 * neither catalogue is reported as not part of any known surface.
 */
function methodNotFound(method: string): never {
  const introducedIn = FUTURE_BROKER_METHODS[method] ?? BROKER_METHODS[method];
  if (introducedIn) {
    throw new ResponseError<BrokerMethodNotFoundData>(
      METHOD_NOT_FOUND_CODE,
      `Method not found: "${method}" is not registered on this host; the minimum host API version that provides it is ${introducedIn}.`,
      { code: "method-not-found", method, introducedIn },
    );
  }
  throw new ResponseError<BrokerMethodNotFoundData>(
    METHOD_NOT_FOUND_CODE,
    `Method not found: "${method}" is not part of any known host API surface.`,
    { code: "method-not-found", method },
  );
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

/**
 * Structured payload on the ResponseError a timed-out `host.process.run` rejects
 * with (#411). `code: "process-timeout"` lets a caller (or the SDK) distinguish a
 * timeout kill from a generic internal error, and `timeoutMs` names the configured
 * budget the run breached so the failure is self-describing on the component
 * surface rather than an anonymous exit code 124.
 */
interface ProcessTimeoutData {
  code: "process-timeout";
  timeoutMs: number;
  exitCode: number;
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
  ctx: BrokerContext | BrokerContextResolver,
  options: CreateBrokerOptions = {},
): void {
  const pm: ProcessManagerLike = options.processManager ?? processManager;
  const docker: DockerLike = options.docker ?? dockerService;
  // No default: only the production caller wires a ledger. A test that does not
  // pass one records nothing (and does no state.json I/O), preserving behaviour.
  const led: LedgerLike | undefined = options.ledger;
  const log: BrokerLogger = options.log ?? (() => {});

  // Accept either a fixed BrokerContext (the unit-test / single-bench shape) or
  // a resolver the host calls per request to obtain the call's bench context
  // (the multiplexed live-connection shape). Both collapse to one resolver so the
  // handlers below never branch on which form was passed; the constant form
  // ignores the benchId.
  const resolve: BrokerContextResolver = typeof ctx === "function" ? ctx : () => ctx;

  // Resolve the per-bench context for a privileged call by the `benchId` the
  // call carries in its params, or throw an internal-error when no bench is bound
  // to this connection's plugin for that id (resolver returned null). A
  // privileged call with no context cannot be audited or permission-checked, so
  // it must not reach the host delegate.
  const requireCtx = (method: string, params: unknown): BrokerContext => {
    const benchId = requireNumber(method, "benchId", (params as { benchId?: unknown })?.benchId);
    const resolved = resolve(benchId);
    if (!resolved) {
      throw new ResponseError(INTERNAL_ERROR_CODE, `${method}: no active bench context`, {
        code: "no-broker-context",
      });
    }
    return resolved;
  };

  // Resolve the per-bench context for a NOTIFICATION (no id to error back on):
  // return null on a missing/unroutable benchId rather than throwing, so a
  // malformed push is dropped (and logged) instead of surfacing an unhandled
  // rejection on the connection (#396).
  const resolveCtxLoose = (params: unknown): BrokerContext | null => {
    const benchId = (params as { benchId?: unknown })?.benchId;
    if (typeof benchId !== "number" || !Number.isFinite(benchId)) return null;
    return resolve(benchId);
  };

  // --- host.process.* (delegate to process-manager) -------------------------

  connection.onRequest<ProcessStartParams, { pid: number }>(
    "host.process.start",
    async (params) => {
      const method = "host.process.start";
      const ctx = requireCtx(method, params);
      enforcePermission(ctx, method, "process", params, log);
      const id = requireString(method, "id", params?.id);
      const command = requireString(method, "command", params?.command);
      const args = requireStringArray(method, "args", params?.args);
      const env = requireEnv(method, params?.env);
      const cwd = requireString(method, "cwd", params?.cwd);
      try {
        const result = await pm.startProcess(id, command, args, env, cwd);
        // Record the now-running process so crash cleanup / the startup sweep can
        // reap it (#396, AC4). Recorded after a successful spawn: the process is
        // live and owned by the host, mirroring the LifecycleEngine's long-lived
        // process path (lifecycle-engine.ts runProcess).
        led?.recordProcess(ctx.pluginId, ctx.benchId, id);
        return result;
      } catch (err) {
        wrapInternal(method, log, err);
      }
    },
  );

  connection.onRequest<ProcessRunParams, { exitCode: number }>(
    "host.process.run",
    async (params) => {
      const method = "host.process.run";
      const ctx = requireCtx(method, params);
      enforcePermission(ctx, method, "process", params, log);
      const id = requireString(method, "id", params?.id);
      const command = requireString(method, "command", params?.command);
      const args = requireStringArray(method, "args", params?.args);
      const env = requireEnv(method, params?.env);
      const cwd = requireString(method, "cwd", params?.cwd);
      const timeoutMs =
        params?.timeoutMs === undefined ? 0 : requireNumber(method, "timeoutMs", params.timeoutMs);
      // Record before the (blocking) run so a host crash mid-run still leaves a
      // ledger entry the cleanup sweep can reap (#396, AC4), mirroring the
      // LifecycleEngine's one-shot path (lifecycle-engine.ts runOneshot).
      led?.recordProcess(ctx.pluginId, ctx.benchId, id);
      let result: { exitCode: number; timedOut: boolean };
      try {
        result = await pm.runProcess(id, command, args, env, cwd, timeoutMs);
      } catch (err) {
        wrapInternal(method, log, err);
      }
      // A timeoutMs breach force-kills the run and resolves exitCode 124; name it
      // at the component surface instead of returning an anonymous 124 the plugin
      // cannot distinguish from a genuine exit(124) (#411). Reject with a typed,
      // descriptive timeout error that carries the configured timeoutMs, which is
      // what the imperative plugin awaits and propagates into its ComponentStatus.
      if (result.timedOut) {
        const message =
          `${method}: process "${id}" exceeded its ${timeoutMs}ms timeout and was ` +
          `force-killed (exit code ${result.exitCode})`;
        log("error", message);
        throw new ResponseError<ProcessTimeoutData>(INTERNAL_ERROR_CODE, message, {
          code: "process-timeout",
          timeoutMs,
          exitCode: result.exitCode,
        });
      }
      // Leave the non-timeout return shape unchanged: exit code only.
      return { exitCode: result.exitCode };
    },
  );

  connection.onRequest<{ id?: unknown }, null>("host.process.stop", async (params) => {
    const method = "host.process.stop";
    enforcePermission(requireCtx(method, params), method, "process", params, log);
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
      enforcePermission(requireCtx(method, params), method, "process", params, log);
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
    enforcePermission(requireCtx(method, params), method, "process", params, log);
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
    enforcePermission(requireCtx(method, params), method, "docker", params, log);
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
    enforcePermission(requireCtx(method, params), method, "docker", params, log);
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
      enforcePermission(requireCtx(method, params), method, "docker", params, log);
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
      enforcePermission(requireCtx(method, params), method, "docker", params, log);
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
    enforcePermission(requireCtx(method, params), method, "docker", params, log);
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
      const c = requireCtx(method, params);
      enforcePermission(c, method, "docker", params, log);
      const componentName = requireString(method, "componentName", params?.componentName);
      const containerId = requireString(method, "containerId", params?.containerId);
      try {
        // The ResourceOwnershipLedger is out of scope (T1.6); v1 records the
        // assignment through the injected sink only.
        c.assignContainer?.(componentName, containerId);
        return null;
      } catch (err) {
        wrapInternal(method, log, err);
      }
    },
  );

  // --- host.ports.* (read from pre-resolved context) ------------------------

  connection.onRequest<{ componentName?: unknown }, number>("host.ports.get", (params) => {
    const method = "host.ports.get";
    const c = requireCtx(method, params);
    enforcePermission(c, method, "ports", params, log);
    const componentName = requireString(method, "componentName", params?.componentName);
    const port = c.ports[componentName];
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
      requireCtx(method, params).reportStatus(params);
      return null;
    } catch (err) {
      wrapInternal(method, log, err);
    }
  });

  // The SDK sends `host.component.reportStatus` as a JSON-RPC NOTIFICATION
  // (component-host-client.ts calls sendNotification), so an imperative plugin's
  // status pushes never reach the onRequest handler above. Handle the
  // notification form too (#396, AC2). The notification carries no `name` (the
  // SDK stamps only `benchId`), so route the push to the component this context
  // is currently driving when the status omits one. Notifications have no reply,
  // so a malformed or unroutable push is logged and dropped, never thrown.
  connection.onNotification<ComponentStatus & { benchId?: unknown }>(
    "host.component.reportStatus",
    (params) => {
      const method = "host.component.reportStatus";
      if (!params || typeof params !== "object") return;
      const status = (params as { status?: unknown }).status;
      if (typeof status !== "string" || status.length === 0) return;
      const ctx = resolveCtxLoose(params);
      if (!ctx) {
        log("warn", `${method} notification dropped: no active bench context`);
        return;
      }
      const rawName = (params as { name?: unknown }).name;
      const name = typeof rawName === "string" && rawName.length > 0 ? rawName : ctx.componentName;
      if (typeof name !== "string" || name.length === 0) {
        log("warn", `${method} notification dropped: no component name`);
        return;
      }
      try {
        ctx.reportStatus({ ...(params as ComponentStatus), name });
      } catch (err) {
        log(
          "error",
          `${method} notification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  connection.onRequest<Partial<ComponentLogLine> & { componentName?: unknown }, null>(
    "host.component.reportLog",
    (params) => {
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
      // Route to the component the call named, so two components sharing one
      // bench each get their own log instead of overwriting whichever
      // provisioned last (#685).
      const componentName = requireString(method, "componentName", params?.componentName);
      try {
        requireCtx(method, params).reportLog(componentName, { source, text, ts });
        return null;
      } catch (err) {
        wrapInternal(method, log, err);
      }
    },
  );

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

  // --- fallback for any method not registered above -------------------------

  // Registered LAST so it catches only methods none of the handlers above
  // claimed: vscode-jsonrpc routes a request to this star handler only when no
  // specific handler matched, so every registered method still wins. Without it,
  // the transport auto-replies a bare -32601 that names nothing; this emits the
  // broker's own descriptive -32601 that names the method and, when known, the
  // minimum host version that provides it (#409, FR-017).
  connection.onRequest((method: string) => methodNotFound(method));
}
