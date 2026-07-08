import { promises as fsPromises, type Stats } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { ResponseError } from "vscode-jsonrpc/node";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import * as credentialStore from "./credential-store.js";
import {
  createPluginFetcher,
  PluginPermissionDeniedError,
  PluginUnsupportedResponseError,
  type FetchInit,
  type FetchResult,
  type PluginHttpLogLine,
} from "./plugin-http.js";
import type { JsonRpcConnection } from "./plugin-rpc.js";
import { assertPathAllowed, resolveAllowedRoots } from "./plugin-fs.js";
import { assertSpawnAllowed, resolveAllowedExecutables } from "./plugin-spawn.js";
import { getInstanceHost } from "./plugin-instance-registry.js";

// JSON-RPC server-error range; we use app-level codes and surface the
// specific reason via the structured `data` payload.
const PERMISSION_DENIED_CODE = -32001;
const UNSUPPORTED_RESPONSE_CODE = -32002;
const INVALID_PARAMS_CODE = -32602;
const INTERNAL_ERROR_CODE = -32603;

const MAX_SPAWN_OUTPUT_BYTES = 1024 * 1024;

export type HostLogger = (level: "info" | "warn" | "error", text: string) => void;

export interface PermissionDeniedData {
  code: "permission-denied";
  category: "credentials";
  slot: string;
  reason: "slot-not-declared" | "scope-read-only";
}

export interface CredentialStoreLike {
  get(pluginId: string, slot: string): Promise<string | null>;
  set(pluginId: string, slot: string, value: string): Promise<void>;
  deleteSlot(pluginId: string, slot: string): Promise<void>;
}

export interface FsLike {
  readFile(file: string, encoding: BufferEncoding): Promise<string>;
  writeFile(file: string, data: string, encoding: BufferEncoding): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  stat(file: string): Promise<Stats>;
  mkdir(dir: string, options?: { recursive?: boolean }): Promise<string | undefined>;
}

export interface SpawnExitSummary {
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type SpawnLike = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;

export type PluginFetcher = (url: string, init?: FetchInit) => Promise<FetchResult>;

export interface NetworkDeniedData {
  code: "network-denied";
  category: "network";
  host: string;
  url: string;
  reason: string;
}

export interface UnsupportedResponseData {
  code: "unsupported-response";
  category: "network";
  host: string;
  url: string;
  contentType: string | null;
  reason: string;
}

interface RegisterOptions {
  store?: CredentialStoreLike;
  fs?: FsLike;
  spawn?: SpawnLike;
  fetcher?: PluginFetcher;
}

const defaultFs: FsLike = {
  readFile: (file, encoding) => fsPromises.readFile(file, encoding),
  writeFile: (file, data, encoding) => fsPromises.writeFile(file, data, encoding),
  readdir: (dir) => fsPromises.readdir(dir),
  stat: (file) => fsPromises.stat(file),
  mkdir: (dir, options) => fsPromises.mkdir(dir, options ?? {}),
};

function findSlot(manifest: PluginManifest, slot: string) {
  return manifest.permissions.credentials.slots.find((s) => s.slot === slot);
}

function denyPermission(
  pluginId: string,
  methodName: string,
  log: HostLogger,
  data: PermissionDeniedData,
): never {
  log("warn", `${pluginId}.${methodName} denied: slot="${data.slot}" reason="${data.reason}"`);
  throw new ResponseError<PermissionDeniedData>(
    PERMISSION_DENIED_CODE,
    `Permission denied: ${data.reason} for slot "${data.slot}"`,
    data,
  );
}

function wrapInternal(pluginId: string, methodName: string, log: HostLogger, err: unknown): never {
  const baseMessage = err instanceof Error ? err.message : String(err);
  const topCode =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : undefined;
  // undici's fetch rejects with a bare TypeError("fetch failed") and hangs the
  // real reason (TLS/DNS/connection codes and their human-readable message) off
  // err.cause. Surface that cause into the wrapped message and code so the
  // integration-test classifier can detect TLS failures (e.g.
  // DEPTH_ZERO_SELF_SIGNED_CERT / "self signed certificate") and offer the
  // inline self-signed-TLS opt-in (issue #442). This is additive: when err has
  // no cause the message and code are byte-identical to the prior behaviour.
  const cause =
    err && typeof err === "object" && "cause" in err
      ? (err as { cause: unknown }).cause
      : undefined;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code)
      : undefined;
  const causeMessage =
    cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined;
  const detailParts: string[] = [];
  if (causeCode) detailParts.push(causeCode);
  if (causeMessage && causeMessage !== baseMessage) detailParts.push(causeMessage);
  const message =
    detailParts.length > 0 ? `${baseMessage}: ${detailParts.join(": ")}` : baseMessage;
  const code = topCode ?? causeCode ?? "internal-error";
  log("error", `${pluginId}.${methodName} failed: ${code}: ${message}`);
  throw new ResponseError(INTERNAL_ERROR_CODE, message, { code });
}

export async function registerHostHandlers(
  connection: JsonRpcConnection,
  record: PluginRecord,
  log: HostLogger,
  options: RegisterOptions = {},
): Promise<void> {
  const manifest = record.manifest;
  if (!manifest) return;
  const pluginId = record.id;
  const store: CredentialStoreLike = options.store ?? credentialStore;
  const fs: FsLike = options.fs ?? defaultFs;
  const spawn: SpawnLike = options.spawn ?? nodeSpawn;
  const fsRoots = await resolveAllowedRoots(record);
  const allowedExecutables = resolveAllowedExecutables(manifest);
  // Two fetchers per plugin process keep undici's connection pools warm without
  // forcing every host.fetch call to allocate a new Agent. The lax variant is
  // built lazily so plugins that never opt in to relaxed TLS pay no cost.
  // When tests inject options.fetcher we honour it for both modes; tests that
  // need to exercise per-call selection register without an override.
  const fetcherLogger = (line: PluginHttpLogLine): void => {
    log(line.level, `${pluginId}.host.fetch ${line.kind}: ${line.detail.reason}`);
  };
  // For integration plugins whose host is user-supplied (declared as `**`),
  // constrain host.fetch to the configured instance host recorded at activation
  // time. Read at call time so a fetcher built once here tracks instance
  // changes. Non-integration kinds (none today) and unconfigured plugins return
  // null, leaving the manifest allowlist to govern alone. See issue #338.
  const resolveInstanceHost = (): string | null =>
    manifest.kind === "integration" ? getInstanceHost(pluginId) : null;
  const strictFetcher: PluginFetcher =
    options.fetcher ??
    createPluginFetcher(manifest, {
      logger: fetcherLogger,
      getInstanceHost: resolveInstanceHost,
    });
  let laxFetcher: PluginFetcher | null = null;
  const getLaxFetcher = (): PluginFetcher => {
    if (options.fetcher) return options.fetcher;
    if (!laxFetcher) {
      laxFetcher = createPluginFetcher(manifest, {
        allowSelfSignedTls: true,
        logger: fetcherLogger,
        getInstanceHost: resolveInstanceHost,
      });
    }
    return laxFetcher;
  };

  connection.onRequest<{ slot: string }, string | null>("host.credentials.get", async (params) => {
    const slot = params?.slot;
    const method = "host.credentials.get";
    if (typeof slot !== "string" || slot.length === 0) {
      throw new ResponseError(PERMISSION_DENIED_CODE, `Missing slot parameter`, {
        code: "invalid-params",
        category: "credentials",
      });
    }
    const declared = findSlot(manifest, slot);
    if (!declared) {
      denyPermission(pluginId, method, log, {
        code: "permission-denied",
        category: "credentials",
        slot,
        reason: "slot-not-declared",
      });
    }
    try {
      return await store.get(pluginId, slot);
    } catch (err) {
      wrapInternal(pluginId, method, log, err);
    }
  });

  connection.onRequest<{ slot: string; value: string }, null>(
    "host.credentials.set",
    async (params) => {
      const slot = params?.slot;
      const value = params?.value;
      const method = "host.credentials.set";
      if (typeof slot !== "string" || slot.length === 0 || typeof value !== "string") {
        throw new ResponseError(PERMISSION_DENIED_CODE, `Missing slot or value parameter`, {
          code: "invalid-params",
          category: "credentials",
        });
      }
      const declared = findSlot(manifest, slot);
      if (!declared) {
        denyPermission(pluginId, method, log, {
          code: "permission-denied",
          category: "credentials",
          slot,
          reason: "slot-not-declared",
        });
      }
      if (declared.scope !== "read-write") {
        denyPermission(pluginId, method, log, {
          code: "permission-denied",
          category: "credentials",
          slot,
          reason: "scope-read-only",
        });
      }
      try {
        await store.set(pluginId, slot, value);
        return null;
      } catch (err) {
        wrapInternal(pluginId, method, log, err);
      }
    },
  );

  connection.onRequest<{ slot: string }, null>("host.credentials.delete", async (params) => {
    const slot = params?.slot;
    const method = "host.credentials.delete";
    if (typeof slot !== "string" || slot.length === 0) {
      throw new ResponseError(PERMISSION_DENIED_CODE, `Missing slot parameter`, {
        code: "invalid-params",
        category: "credentials",
      });
    }
    const declared = findSlot(manifest, slot);
    if (!declared) {
      denyPermission(pluginId, method, log, {
        code: "permission-denied",
        category: "credentials",
        slot,
        reason: "slot-not-declared",
      });
    }
    if (declared.scope !== "read-write") {
      denyPermission(pluginId, method, log, {
        code: "permission-denied",
        category: "credentials",
        slot,
        reason: "scope-read-only",
      });
    }
    try {
      await store.deleteSlot(pluginId, slot);
      return null;
    } catch (err) {
      wrapInternal(pluginId, method, log, err);
    }
  });

  connection.onRequest<{ path: string; encoding?: BufferEncoding }, string>(
    "host.fs.readFile",
    async (params) => {
      const method = "host.fs.readFile";
      const resolved = await assertPathAllowed(pluginId, method, params?.path, fsRoots, log);
      try {
        return await fs.readFile(resolved, params?.encoding ?? "utf8");
      } catch (err) {
        wrapInternal(pluginId, method, log, err);
      }
    },
  );

  connection.onRequest<{ path: string; data: string; encoding?: BufferEncoding }, null>(
    "host.fs.writeFile",
    async (params) => {
      const method = "host.fs.writeFile";
      if (typeof params?.data !== "string") {
        throw new ResponseError(PERMISSION_DENIED_CODE, `Missing data parameter`, {
          code: "invalid-params",
          category: "filesystem",
        });
      }
      const resolved = await assertPathAllowed(pluginId, method, params.path, fsRoots, log);
      try {
        await fs.writeFile(resolved, params.data, params.encoding ?? "utf8");
        return null;
      } catch (err) {
        wrapInternal(pluginId, method, log, err);
      }
    },
  );

  connection.onRequest<{ path: string }, string[]>("host.fs.readdir", async (params) => {
    const method = "host.fs.readdir";
    const resolved = await assertPathAllowed(pluginId, method, params?.path, fsRoots, log);
    try {
      return await fs.readdir(resolved);
    } catch (err) {
      wrapInternal(pluginId, method, log, err);
    }
  });

  connection.onRequest<
    { path: string },
    { size: number; isFile: boolean; isDirectory: boolean; mtimeMs: number }
  >("host.fs.stat", async (params) => {
    const method = "host.fs.stat";
    const resolved = await assertPathAllowed(pluginId, method, params?.path, fsRoots, log);
    try {
      const s = await fs.stat(resolved);
      return {
        size: s.size,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        mtimeMs: s.mtimeMs,
      };
    } catch (err) {
      wrapInternal(pluginId, method, log, err);
    }
  });

  connection.onRequest<{ path: string; recursive?: boolean }, null>(
    "host.fs.mkdir",
    async (params) => {
      const method = "host.fs.mkdir";
      const resolved = await assertPathAllowed(pluginId, method, params?.path, fsRoots, log);
      try {
        await fs.mkdir(resolved, { recursive: params?.recursive === true });
        return null;
      } catch (err) {
        wrapInternal(pluginId, method, log, err);
      }
    },
  );

  connection.onRequest<
    { executable: string; args?: string[]; cwd?: string; stdin?: string },
    SpawnExitSummary
  >("host.process.spawn", async (params) => {
    const method = "host.process.spawn";
    const executable = params?.executable;
    assertSpawnAllowed(pluginId, method, executable, allowedExecutables, log);
    const rawArgs = params?.args;
    const args = Array.isArray(rawArgs) ? (rawArgs as string[]) : [];
    // cwd, if supplied, must also be inside the filesystem allowlist.
    const cwd = params?.cwd
      ? await assertPathAllowed(pluginId, method, params.cwd, fsRoots, log)
      : record.pluginDir;
    try {
      return await runSpawn(spawn, executable, args, cwd, params?.stdin);
    } catch (err) {
      wrapInternal(pluginId, method, log, err);
    }
  });

  connection.onRequest<{ url: unknown; init?: unknown }, FetchResult>(
    "host.fetch",
    async (params) => {
      const method = "host.fetch";
      const url = params?.url;
      if (typeof url !== "string" || url.length === 0) {
        throw new ResponseError(INVALID_PARAMS_CODE, "host.fetch requires a string url", {
          code: "invalid-params",
          category: "network",
        });
      }
      const init = normalizeFetchInit(params?.init);
      if (init.error) {
        throw new ResponseError(INVALID_PARAMS_CODE, init.error, {
          code: "invalid-params",
          category: "network",
        });
      }
      const useLaxTls = init.value?.allowSelfSignedTls === true;
      const chosenFetcher = useLaxTls ? getLaxFetcher() : strictFetcher;
      try {
        return await chosenFetcher(url, init.value);
      } catch (err) {
        if (err instanceof PluginPermissionDeniedError) {
          const data: NetworkDeniedData = {
            code: "network-denied",
            category: "network",
            host: err.host,
            url: err.url,
            reason: err.reason,
          };
          log("warn", `${pluginId}.${method} denied: host="${err.host}" reason="${err.reason}"`);
          throw new ResponseError(PERMISSION_DENIED_CODE, err.message, data);
        }
        if (err instanceof PluginUnsupportedResponseError) {
          const data: UnsupportedResponseData = {
            code: "unsupported-response",
            category: "network",
            host: err.host,
            url: err.url,
            contentType: err.contentType,
            reason: err.reason,
          };
          log(
            "warn",
            `${pluginId}.${method} unsupported-response: host="${err.host}" contentType="${err.contentType ?? ""}"`,
          );
          throw new ResponseError(UNSUPPORTED_RESPONSE_CODE, err.message, data);
        }
        wrapInternal(pluginId, method, log, err);
      }
    },
  );

  for (const level of ["info", "warn", "error"] as const) {
    connection.onNotification<unknown>(`host.logger.${level}`, (params) => {
      log(level, formatLoggerPayload(params));
    });
  }
}

function runSpawn(
  spawn: SpawnLike,
  executable: string,
  args: string[],
  cwd: string,
  stdin: string | undefined,
): Promise<SpawnExitSummary> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const safeReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const safeResolve = (value: SpawnExitSummary) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > MAX_SPAWN_OUTPUT_BYTES) {
        truncated = true;
        stdout += chunk.slice(0, Math.max(0, MAX_SPAWN_OUTPUT_BYTES - stdout.length));
        child.kill("SIGKILL");
      } else {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length + chunk.length > MAX_SPAWN_OUTPUT_BYTES) {
        truncated = true;
        stderr += chunk.slice(0, Math.max(0, MAX_SPAWN_OUTPUT_BYTES - stderr.length));
        child.kill("SIGKILL");
      } else {
        stderr += chunk;
      }
    });
    child.on("error", safeReject);
    child.on("close", (code, signal) => {
      safeResolve({
        pid: child.pid ?? null,
        exitCode: code,
        signal,
        stdout,
        stderr,
        truncated,
      });
    });

    if (typeof stdin === "string" && child.stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function normalizeFetchInit(input: unknown): { value: FetchInit | undefined; error?: string } {
  if (input === undefined || input === null) return { value: undefined };
  if (typeof input !== "object") {
    return { value: undefined, error: "host.fetch init must be an object" };
  }
  const raw = input as Record<string, unknown>;
  const init: FetchInit = {};
  if (raw.method !== undefined) {
    if (typeof raw.method !== "string") {
      return { value: undefined, error: "host.fetch init.method must be a string" };
    }
    init.method = raw.method;
  }
  if (raw.headers !== undefined) {
    if (raw.headers === null || typeof raw.headers !== "object" || Array.isArray(raw.headers)) {
      return { value: undefined, error: "host.fetch init.headers must be an object" };
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof v !== "string") {
        return { value: undefined, error: `host.fetch init.headers["${k}"] must be a string` };
      }
      headers[k] = v;
    }
    init.headers = headers;
  }
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string") {
      return {
        value: undefined,
        error: "host.fetch init.body must be a string",
      };
    }
    init.body = raw.body;
  }
  if (raw.allowSelfSignedTls !== undefined) {
    if (typeof raw.allowSelfSignedTls !== "boolean") {
      return {
        value: undefined,
        error: "host.fetch init.allowSelfSignedTls must be a boolean",
      };
    }
    init.allowSelfSignedTls = raw.allowSelfSignedTls;
  }
  return { value: init };
}

function formatLoggerPayload(params: unknown): string {
  if (typeof params === "string") return params;
  if (params && typeof params === "object") {
    const obj = params as { message?: unknown; data?: unknown };
    const message = typeof obj.message === "string" ? obj.message : JSON.stringify(params);
    if (obj.data !== undefined) {
      let serialized: string;
      try {
        serialized = JSON.stringify(obj.data);
      } catch {
        serialized = String(obj.data);
      }
      return `${message} ${serialized}`;
    }
    return message;
  }
  return String(params);
}
