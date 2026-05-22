import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, statSync, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import treeKill from "tree-kill";
import {
  parseManifest,
  type LogLine,
  type PluginError,
  type PluginManifest,
  type PluginRecord,
  type PluginSource,
  type PluginStatus,
  type RestartEvent,
} from "@roubo/shared";
import { cleanEnv } from "./env.js";
import { CancellationTokenSource, createConnection, type JsonRpcConnection } from "./plugin-rpc.js";
import { registerHostHandlers } from "./plugin-host-api.js";

export const HOST_API_VERSION = "1.0.0";
export const RESTART_BUDGET = 3;
export const RESTART_WINDOW_MS = 5 * 60 * 1000;
export const SHUTDOWN_GRACE_MS = 5000;
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
export const BACKOFF_SCHEDULE_MS = [500, 1000, 2000];

let LOG_ROTATION_BYTES = 5 * 1024 * 1024;

interface PluginEntry {
  record: PluginRecord;
  process: ChildProcess | null;
  connection: JsonRpcConnection | null;
  logStream: WriteStream | null;
  logBytes: number;
  logOpenPromise: Promise<void> | null;
  intentionalStop: boolean;
  restartTimer: NodeJS.Timeout | null;
}

const plugins = new Map<string, PluginEntry>();
let initialized = false;

function bundledPluginsRoot(): string {
  const override = process.env.ROUBO_BUNDLED_PLUGINS_DIR;
  if (override) return override;
  // server/services/plugin-manager.ts → server/services → server → repo root
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "plugins");
}

function userPluginsRoot(): string {
  const override = process.env.ROUBO_USER_PLUGINS_DIR;
  if (override) return override;
  return path.join(homedir(), ".roubo", "plugins");
}

function logDirFor(pluginId: string): string {
  // Logs always live under the user plugins root (typically `~/.roubo/plugins/<id>/logs`),
  // even for bundled plugins. Tests override the root via ROUBO_USER_PLUGINS_DIR.
  return path.join(userPluginsRoot(), pluginId, "logs");
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeRecord(
  id: string,
  manifest: PluginManifest | null,
  manifestPath: string,
  pluginDir: string,
  source: PluginSource,
  status: PluginStatus,
  lastError: PluginError | null,
): PluginRecord {
  return {
    id,
    manifest,
    manifestPath,
    pluginDir,
    source,
    status,
    lastError,
    restartHistory: [],
    pid: null,
  };
}

function isValidEntryPath(entry: string): boolean {
  if (path.isAbsolute(entry)) return false;
  const normalized = path.normalize(entry);
  if (normalized.startsWith("..")) return false;
  if (normalized.split(path.sep).includes("..")) return false;
  return true;
}

async function readManifestFile(dir: string): Promise<{ path: string; text: string } | null> {
  for (const filename of ["roubo-plugin.yaml", "roubo-plugin.yml"]) {
    const candidate = path.join(dir, filename);
    try {
      const text = await readFile(candidate, "utf8");
      return { path: candidate, text };
    } catch {
      // try next
    }
  }
  return null;
}

async function discoverRoot(
  root: string,
  source: PluginSource,
  acc: Map<string, PluginEntry>,
): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const pluginDir = path.join(root, dirent.name);
    const manifestFile = await readManifestFile(pluginDir);
    if (!manifestFile) continue;

    const parsed = parseManifest(manifestFile.text, manifestFile.path);
    if (!parsed.ok) {
      // Use directory name as id when manifest is invalid.
      const id = dirent.name;
      // Bundled wins on duplicate ids: if a bundled entry already claimed
      // this id, mark the user-side one as invalid with a duplicate-id error.
      if (acc.has(id)) {
        if (source === "user") {
          // Add as invalid duplicate (keyed by a synthetic id so the bundled one stays).
          const dupId = `${id}__user_duplicate`;
          acc.set(dupId, {
            record: makeRecord(id, null, manifestFile.path, pluginDir, source, "invalid", {
              code: "duplicate-id",
              message: `Plugin id "${id}" is already provided by a bundled plugin`,
            }),
            process: null,
            connection: null,
            logStream: null,
            logBytes: 0,
            logOpenPromise: null,
            intentionalStop: false,
            restartTimer: null,
          });
        }
        continue;
      }
      acc.set(id, {
        record: makeRecord(id, null, manifestFile.path, pluginDir, source, "invalid", {
          code: "invalid-manifest",
          message: parsed.error.message,
        }),
        process: null,
        connection: null,
        logStream: null,
        logBytes: 0,
        logOpenPromise: null,
        intentionalStop: false,
        restartTimer: null,
      });
      continue;
    }

    const manifest = parsed.manifest;
    if (acc.has(manifest.id)) {
      if (source === "user") {
        acc.set(`${manifest.id}__user_duplicate`, {
          record: makeRecord(
            manifest.id,
            manifest,
            manifestFile.path,
            pluginDir,
            source,
            "invalid",
            {
              code: "duplicate-id",
              message: `Plugin id "${manifest.id}" is already provided by a bundled plugin`,
            },
          ),
          process: null,
          connection: null,
          logStream: null,
          logBytes: 0,
          logOpenPromise: null,
          intentionalStop: false,
          restartTimer: null,
        });
      }
      continue;
    }

    // Compatibility check (semver range).
    const rangeValid = semver.validRange(manifest.roubo);
    if (!rangeValid) {
      acc.set(manifest.id, {
        record: makeRecord(manifest.id, manifest, manifestFile.path, pluginDir, source, "invalid", {
          code: "invalid-roubo-range",
          message: `Manifest "roubo" field is not a valid semver range: ${manifest.roubo}`,
        }),
        process: null,
        connection: null,
        logStream: null,
        logBytes: 0,
        logOpenPromise: null,
        intentionalStop: false,
        restartTimer: null,
      });
      continue;
    }
    if (!semver.satisfies(HOST_API_VERSION, manifest.roubo, { includePrerelease: false })) {
      acc.set(manifest.id, {
        record: makeRecord(
          manifest.id,
          manifest,
          manifestFile.path,
          pluginDir,
          source,
          "incompatible",
          {
            code: "incompatible-host",
            message: `Plugin requires roubo "${manifest.roubo}" but host is ${HOST_API_VERSION}`,
          },
        ),
        process: null,
        connection: null,
        logStream: null,
        logBytes: 0,
        logOpenPromise: null,
        intentionalStop: false,
        restartTimer: null,
      });
      continue;
    }

    if (!isValidEntryPath(manifest.entry)) {
      acc.set(manifest.id, {
        record: makeRecord(manifest.id, manifest, manifestFile.path, pluginDir, source, "invalid", {
          code: "invalid-entry",
          message: `Manifest "entry" must be a relative path within the plugin directory: ${manifest.entry}`,
        }),
        process: null,
        connection: null,
        logStream: null,
        logBytes: 0,
        logOpenPromise: null,
        intentionalStop: false,
        restartTimer: null,
      });
      continue;
    }

    acc.set(manifest.id, {
      record: makeRecord(
        manifest.id,
        manifest,
        manifestFile.path,
        pluginDir,
        source,
        "disabled",
        null,
      ),
      process: null,
      connection: null,
      logStream: null,
      logBytes: 0,
      logOpenPromise: null,
      intentionalStop: false,
      restartTimer: null,
    });
  }
}

async function ensureLogDir(pluginId: string): Promise<string> {
  const dir = logDirFor(pluginId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function openLogStream(entry: PluginEntry): Promise<void> {
  if (entry.logStream) return;
  if (entry.logOpenPromise) return entry.logOpenPromise;
  entry.logOpenPromise = (async () => {
    const dir = await ensureLogDir(entry.record.id);
    const current = path.join(dir, "current.log");
    let bytes = 0;
    if (existsSync(current)) {
      try {
        bytes = statSync(current).size;
      } catch {
        bytes = 0;
      }
    }
    entry.logBytes = bytes;
    entry.logStream = createWriteStream(current, { flags: "a" });
  })();
  try {
    await entry.logOpenPromise;
  } finally {
    entry.logOpenPromise = null;
  }
}

async function rotateLogIfNeeded(entry: PluginEntry, addedBytes: number): Promise<void> {
  entry.logBytes += addedBytes;
  if (entry.logBytes < LOG_ROTATION_BYTES) return;
  const stream = entry.logStream;
  if (!stream) return;
  entry.logStream = null;
  entry.logBytes = 0;
  await new Promise<void>((resolve) => stream.end(resolve));
  const dir = await ensureLogDir(entry.record.id);
  const current = path.join(dir, "current.log");
  const previous = path.join(dir, "previous.log");
  try {
    await rename(current, previous);
  } catch {
    // best-effort
  }
}

function formatLogLine(
  source: "stdout" | "stderr" | "host",
  text: string,
  level?: "info" | "warn" | "error",
): string {
  const ts = nowIso();
  const lvl = level ? ` [${level}]` : "";
  return `${ts} ${source}${lvl} ${text}\n`;
}

async function writeLog(
  entry: PluginEntry,
  source: "stdout" | "stderr" | "host",
  text: string,
  level?: "info" | "warn" | "error",
): Promise<void> {
  if (!entry.logStream) {
    await openLogStream(entry);
  }
  const line = formatLogLine(source, text, level);
  entry.logStream?.write(line);
  await rotateLogIfNeeded(entry, Buffer.byteLength(line, "utf8"));
}

function attachStdioLogging(entry: PluginEntry, proc: ChildProcess): void {
  const handleData = (source: "stdout" | "stderr") => (buf: Buffer) => {
    const lines = buf.toString("utf8").split("\n");
    for (const raw of lines) {
      if (raw.length === 0) continue;
      writeLog(entry, source, raw).catch(() => {});
    }
  };
  proc.stdout?.on("data", handleData("stdout"));
  proc.stderr?.on("data", handleData("stderr"));
}

async function spawnPlugin(entry: PluginEntry): Promise<void> {
  const manifest = entry.record.manifest;
  if (!manifest) return;
  entry.intentionalStop = false;

  const entryPath = path.join(entry.record.pluginDir, manifest.entry);
  // Defensive: confirm resolved path is still inside the plugin dir.
  const resolvedDir = path.resolve(entry.record.pluginDir);
  const resolvedEntry = path.resolve(entryPath);
  if (!resolvedEntry.startsWith(resolvedDir + path.sep) && resolvedEntry !== resolvedDir) {
    entry.record.status = "errored";
    entry.record.lastError = {
      code: "invalid-entry",
      message: `Resolved entry path escapes plugin directory: ${resolvedEntry}`,
    };
    return;
  }

  let proc: ChildProcess;
  try {
    proc = spawn(process.execPath, [entryPath], {
      cwd: entry.record.pluginDir,
      env: {
        ...cleanEnv(),
        ROUBO_PLUGIN_ID: manifest.id,
        ROUBO_HOST_API_VERSION: HOST_API_VERSION,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
  } catch (err) {
    entry.record.status = "errored";
    entry.record.lastError = {
      code: "spawn-failed",
      message: (err as Error).message,
    };
    entry.record.restartHistory.push({
      at: nowIso(),
      reason: "spawn-failed",
      exitCode: null,
    });
    await writeLog(entry, "host", `spawn failed: ${(err as Error).message}`, "error");
    return;
  }

  if (proc.pid === undefined) {
    entry.record.status = "errored";
    entry.record.lastError = {
      code: "spawn-failed",
      message: "Child process did not return a pid",
    };
    return;
  }

  entry.process = proc;
  entry.record.pid = proc.pid;
  entry.record.status = "enabled";
  entry.record.lastError = null;
  attachStdioLogging(entry, proc);

  try {
    entry.connection = createConnection(proc);
    entry.connection.onError((error) => {
      writeLog(entry, "host", `rpc error: ${error.message}`, "warn").catch(() => {});
    });
    entry.connection.onClose(() => {
      // connection closed; the 'exit' handler below drives state transitions
    });
    registerHostHandlers(entry.connection, entry.record, (level, text) => {
      writeLog(entry, "host", text, level).catch(() => {});
    });
  } catch (err) {
    entry.record.status = "errored";
    entry.record.lastError = {
      code: "rpc-init-failed",
      message: (err as Error).message,
    };
    proc.kill("SIGKILL");
    return;
  }

  proc.on("exit", (code) => {
    handleChildExit(entry, code);
  });
  proc.on("error", (err) => {
    writeLog(entry, "host", `process error: ${err.message}`, "error").catch(() => {});
  });
}

function handleChildExit(entry: PluginEntry, exitCode: number | null): void {
  entry.record.pid = null;
  const wasIntentional = entry.intentionalStop;
  entry.intentionalStop = false;
  if (entry.connection) {
    try {
      entry.connection.dispose();
    } catch {
      // ignore
    }
    entry.connection = null;
  }
  entry.process = null;

  if (wasIntentional) {
    if (entry.record.status === "enabled") {
      entry.record.status = "disabled";
    }
    return;
  }

  if (
    entry.record.status === "disabled" ||
    entry.record.status === "incompatible" ||
    entry.record.status === "invalid"
  ) {
    return;
  }

  // Unexpected exit. Record in restart history and decide whether to restart.
  const now = Date.now();
  const event: RestartEvent = {
    at: new Date(now).toISOString(),
    reason: "unexpected-exit",
    exitCode,
  };
  entry.record.restartHistory.push(event);
  // Trim history older than the window for budget purposes.
  const cutoff = now - RESTART_WINDOW_MS;
  const recent = entry.record.restartHistory.filter((e) => Date.parse(e.at) >= cutoff);

  if (recent.length >= RESTART_BUDGET) {
    entry.record.status = "errored";
    entry.record.lastError = {
      code: "restart-budget-exhausted",
      message: `Plugin exited ${recent.length} times within ${RESTART_WINDOW_MS / 1000}s; auto-restart disabled. Click Restart to retry.`,
    };
    writeLog(entry, "host", entry.record.lastError.message, "error").catch(() => {});
    return;
  }

  const attemptIndex = Math.min(recent.length - 1, BACKOFF_SCHEDULE_MS.length - 1);
  const delay = BACKOFF_SCHEDULE_MS[Math.max(0, attemptIndex)];
  writeLog(
    entry,
    "host",
    `plugin exited (code=${exitCode}); restarting in ${delay}ms (attempt ${recent.length}/${RESTART_BUDGET})`,
    "warn",
  ).catch(() => {});
  entry.restartTimer = setTimeout(() => {
    entry.restartTimer = null;
    if (entry.intentionalStop || !initialized) return;
    void spawnPlugin(entry);
  }, delay);
  if (typeof entry.restartTimer.unref === "function") entry.restartTimer.unref();
}

async function stopPluginProcess(entry: PluginEntry): Promise<void> {
  entry.intentionalStop = true;
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
  const proc = entry.process;
  if (!proc || !proc.pid) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const pid = proc.pid;
      if (pid) {
        treeKill(pid, "SIGKILL", () => finish());
      } else {
        finish();
      }
    }, SHUTDOWN_GRACE_MS);
    proc.once("exit", finish);
    const pid = proc.pid;
    if (pid) {
      treeKill(pid, "SIGTERM", (err) => {
        if (err) {
          // best-effort; if SIGTERM failed (process already dead), wait for exit anyway
          // the timer will SIGKILL as fallback
        }
      });
    } else {
      finish();
    }
  });
}

export async function initialize(): Promise<void> {
  if (initialized) {
    throw new Error("plugin-manager already initialized");
  }
  initialized = true;

  const discovered = new Map<string, PluginEntry>();
  try {
    await discoverRoot(bundledPluginsRoot(), "bundled", discovered);
  } catch (err) {
    console.warn("plugin discovery (bundled) failed:", (err as Error).message);
  }
  try {
    await discoverRoot(userPluginsRoot(), "user", discovered);
  } catch (err) {
    console.warn("plugin discovery (user) failed:", (err as Error).message);
  }

  for (const [id, entry] of discovered) {
    plugins.set(id, entry);
  }

  const spawns: Promise<void>[] = [];
  for (const entry of plugins.values()) {
    if (entry.record.status === "disabled" && entry.record.manifest) {
      spawns.push(spawnPlugin(entry));
    }
  }
  await Promise.all(spawns);
}

export async function shutdown(): Promise<void> {
  // Cancel any pending restart timers across all entries first so they don't
  // race the teardown by spawning into a sandbox that's about to be removed.
  for (const entry of plugins.values()) {
    entry.intentionalStop = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
  }
  const live = Array.from(plugins.values()).filter((e) => e.process !== null);
  await Promise.all(live.map(stopPluginProcess));
  for (const entry of plugins.values()) {
    if (entry.logStream) {
      const s = entry.logStream;
      entry.logStream = null;
      await new Promise<void>((resolve) => s.end(resolve));
    }
  }
  plugins.clear();
  initialized = false;
}

export function listInstalled(): PluginRecord[] {
  return Array.from(plugins.values()).map((entry) => ({
    ...entry.record,
    restartHistory: [...entry.record.restartHistory],
  }));
}

export async function enable(pluginId: string): Promise<void> {
  const entry = plugins.get(pluginId);
  if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
  if (!entry.record.manifest) {
    throw new Error(`Plugin "${pluginId}" has no valid manifest`);
  }
  if (entry.record.status === "incompatible") {
    throw new Error(`Plugin "${pluginId}" is incompatible with this host`);
  }
  if (entry.process) return; // already running
  entry.record.status = "disabled";
  entry.record.lastError = null;
  await spawnPlugin(entry);
}

export async function disable(pluginId: string): Promise<void> {
  const entry = plugins.get(pluginId);
  if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
  if (!entry.process) {
    entry.record.status = "disabled";
    return;
  }
  await stopPluginProcess(entry);
  entry.record.status = "disabled";
}

export async function restart(pluginId: string): Promise<void> {
  const entry = plugins.get(pluginId);
  if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
  if (!entry.record.manifest) {
    throw new Error(`Plugin "${pluginId}" has no valid manifest`);
  }
  if (entry.process) {
    await stopPluginProcess(entry);
  }
  // Clear the restart window per architecture decision #7.
  entry.record.restartHistory = [];
  entry.record.lastError = null;
  await spawnPlugin(entry);
}

export async function invoke<T = unknown>(
  pluginId: string,
  method: string,
  params: unknown,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const entry = plugins.get(pluginId);
  if (!entry) {
    throw makeRpcError("unknown-plugin", `Unknown plugin: ${pluginId}`, method);
  }
  if (!entry.connection || !entry.process) {
    throw makeRpcError(
      "plugin-not-enabled",
      `Plugin "${pluginId}" is not running (status=${entry.record.status})`,
      method,
    );
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const tokenSource = new CancellationTokenSource();
  let timer: NodeJS.Timeout | null = null;
  const connection = entry.connection;
  try {
    const result = await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        timer = null;
        tokenSource.cancel();
        reject(makeRpcError("timeout", `Call to ${method} timed out after ${timeoutMs}ms`, method));
      }, timeoutMs);
      connection
        .sendRequest<T>(method, params, tokenSource.token)
        .then((value) => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          resolve(value);
        })
        .catch((err: Error) => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          // If the cause is cancellation due to our own timeout we already rejected.
          if (tokenSource.token.isCancellationRequested) return;
          reject(makeRpcError("rpc-error", err.message ?? String(err), method));
        });
    });
    return result;
  } finally {
    tokenSource.dispose();
  }
}

// Plugin IDs are validated by the manifest schema, but readLogs may be reached from HTTP
// routes that take the id from a URL parameter. Re-check structurally so path traversal is
// impossible regardless of caller assumptions, and so CodeQL can see the sanitization.
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const LOG_FILE_NAMES = new Set(["current", "previous"]);

export async function readLogs(
  pluginId: string,
  file: "current" | "previous" = "current",
  lines = 500,
): Promise<LogLine[]> {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`Invalid plugin id: ${pluginId}`);
  }
  if (!LOG_FILE_NAMES.has(file)) {
    throw new Error(`Invalid log file: ${file}`);
  }
  const entry = plugins.get(pluginId);
  if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
  // Confine the resolved log path to the plugin's log directory. Even though pluginId is
  // regex-validated above, this containment check gives CodeQL a sanitizer it recognizes
  // for the js/path-injection rule.
  const root = path.resolve(userPluginsRoot());
  const filePath = path.resolve(root, pluginId, "logs", `${file}.log`);
  const rel = path.relative(root, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Invalid log path for plugin: ${pluginId}`);
  }
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const allLines = text.split("\n").filter((l) => l.length > 0);
  const tail = allLines.slice(-lines);
  return tail.map(parseLogLine);
}

function parseLogLine(raw: string): LogLine {
  // Format: <ISO ts> <source>[ [level]] <text>
  const match = raw.match(/^(\S+) (stdout|stderr|host)(?: \[(info|warn|error)\])? (.*)$/);
  if (!match) {
    return { ts: nowIso(), source: "host", text: raw };
  }
  const [, ts, source, level, text] = match;
  return {
    ts,
    source: source as LogLine["source"],
    level: (level as LogLine["level"]) ?? undefined,
    text,
  };
}

function makeRpcError(code: string, message: string, methodName?: string): Error & PluginError {
  const err = new Error(message) as Error & PluginError;
  err.code = code;
  err.message = message;
  if (methodName) err.methodName = methodName;
  return err;
}

// Test-only helpers — exported so tests can reset state and tune internals.
export const __test = {
  reset(): void {
    plugins.clear();
    initialized = false;
    LOG_ROTATION_BYTES = 5 * 1024 * 1024;
  },
  setLogRotationBytes(bytes: number): void {
    LOG_ROTATION_BYTES = bytes;
  },
  getEntry(pluginId: string): PluginEntry | undefined {
    return plugins.get(pluginId);
  },
  async appendLog(
    pluginId: string,
    source: "stdout" | "stderr" | "host",
    text: string,
  ): Promise<void> {
    const entry = plugins.get(pluginId);
    if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
    await writeLog(entry, source, text);
  },
  bundledRoot: bundledPluginsRoot,
  userRoot: userPluginsRoot,
};
