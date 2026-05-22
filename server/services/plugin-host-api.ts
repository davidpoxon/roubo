import { promises as fsPromises, type Stats } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { ResponseError } from "vscode-jsonrpc/node.js";
import type { PluginManifest, PluginRecord } from "@roubo/shared";
import * as credentialStore from "./credential-store.js";
import type { JsonRpcConnection } from "./plugin-rpc.js";
import { assertPathAllowed, resolveAllowedRoots } from "./plugin-fs.js";
import { assertSpawnAllowed, resolveAllowedExecutables } from "./plugin-spawn.js";

// JSON-RPC server-error range; we use a single app-level code and surface the
// specific reason via the structured `data` payload.
const PERMISSION_DENIED_CODE = -32001;
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

interface RegisterOptions {
  store?: CredentialStoreLike;
  fs?: FsLike;
  spawn?: SpawnLike;
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
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "internal-error";
  log("error", `${pluginId}.${methodName} failed: ${code}: ${message}`);
  throw new ResponseError(INTERNAL_ERROR_CODE, message, { code });
}

export function registerHostHandlers(
  connection: JsonRpcConnection,
  record: PluginRecord,
  log: HostLogger,
  options: RegisterOptions = {},
): void {
  const manifest = record.manifest;
  if (!manifest) return;
  const pluginId = record.id;
  const store: CredentialStoreLike = options.store ?? credentialStore;
  const fs: FsLike = options.fs ?? defaultFs;
  const spawn: SpawnLike = options.spawn ?? nodeSpawn;
  const fsRoots = resolveAllowedRoots(record);
  const allowedExecutables = resolveAllowedExecutables(manifest);

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
