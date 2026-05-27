import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, statSync, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import treeKill from "tree-kill";
import {
  parseManifest,
  type ConnectionState,
  type LogLine,
  type PluginError,
  type PluginManifest,
  type PluginRecord,
  type PluginSource,
  type PluginStatus,
  type RestartEvent,
} from "@roubo/shared";
import type { ConnectionStatus, ValidateConfigResult } from "@roubo/plugin-sdk";
import { cleanEnv } from "./env.js";
import { CancellationTokenSource, createConnection, type JsonRpcConnection } from "./plugin-rpc.js";
import { registerHostHandlers } from "./plugin-host-api.js";
import * as projectRegistry from "./project-registry.js";
import { resolveActivePlugin } from "./active-plugin.js";
import * as pluginEnableState from "./plugin-enable-state.js";
import * as issueSnapshotCache from "./issue-snapshot-cache.js";
import type { PluginEnableState } from "@roubo/shared";
import { PLUGIN_ID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";

export const HOST_API_VERSION = "1.1.0";
export const RESTART_BUDGET = 3;
export const RESTART_WINDOW_MS = 5 * 60 * 1000;
export const SHUTDOWN_GRACE_MS = 5000;
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
export const BACKOFF_SCHEDULE_MS = [500, 1000, 2000];

// WU-044: getConnectionStatus is polled by the UI; cache per plugin for 30s
// and de-dup concurrent in-flight calls so UI fan-out doesn't thunder against
// the plugin process. RPC timeout is tighter than DEFAULT_RPC_TIMEOUT_MS so a
// hung plugin can't stall the status indicator for half a minute.
export const CONNECTION_STATUS_TTL_MS = 30_000;
export const CONNECTION_STATUS_RPC_TIMEOUT_MS = 5_000;

let LOG_ROTATION_BYTES = 5 * 1024 * 1024;

interface PluginEntry {
  record: PluginRecord;
  process: ChildProcess | null;
  connection: JsonRpcConnection | null;
  logStream: WriteStream | null;
  logBytes: number;
  logOpenPromise: Promise<void> | null;
  legacyRotateChecked: boolean;
  intentionalStop: boolean;
  restartTimer: NodeJS.Timeout | null;
}

const plugins = new Map<string, PluginEntry>();
let initialized = false;

interface CachedConnectionStatus {
  value: ConnectionStatus;
  expiresAt: number;
}
const connectionStatusCache = new Map<string, CachedConnectionStatus>();
const inFlightConnectionStatusRequests = new Map<string, Promise<ConnectionStatus>>();
// ESM bindings prevent vitest from spying on `invoke` from this module's own
// test file. Funnel the connection-status RPC calls through a swappable
// reference so tests can inject a mock via `__test.setConnectionStatusInvoker`.
type ConnectionStatusInvoker = <T>(
  pluginId: string,
  method: string,
  params: unknown,
  opts?: { timeoutMs?: number },
) => Promise<T>;
let connectionStatusInvoker: ConnectionStatusInvoker = (pluginId, method, params, opts) =>
  invoke(pluginId, method, params, opts);
// WU-046: enable-state snapshot loaded once at initialize() and kept in sync
// via setPluginEnabled/removePlugin write-throughs. `null` means the file
// did not exist on boot (legacy install), in which case every discovered
// plugin is treated as implicitly "enabled" per architecture.md:1097.
let enableStateCache: PluginEnableState | null = null;

// WU-063: when ROUBO_E2E=1, Playwright specs can pin the stubbed plugin to a
// specific scenario pack and frozen-now ISO. POST /test/__reset writes these
// via __test.setE2EConfig; spawnPlugin appends them to argv. Outside the e2e
// harness they are always null and the spawn argv is unchanged.
let e2eScenario: string | null = null;
let e2eNow: string | null = null;

// TC-153 / NFR-023: every plugin connection-status transition is written to
// the host's existing log destination (process stdout via console.info) as a
// single JSON line tagged with `event: "plugin.connection-state.changed"`. No
// new logging infrastructure is introduced; sister host-side log calls live
// at `plugin-discovery (bundled)` / `(user)` warnings below.
//
// A second, ROUBO_E2E=1-only buffer mirrors emissions so the Playwright
// harness (TC-169) can poll a deterministic surface instead of scraping the
// running server's stdout. The buffer is empty in production builds because
// nothing writes to it when ROUBO_E2E is unset.
export const CONNECTION_STATE_CHANGED_EVENT = "plugin.connection-state.changed";
export interface ConnectionStateLogEntry {
  event: typeof CONNECTION_STATE_CHANGED_EVENT;
  pluginId: string;
  previousState: ConnectionState | null;
  newState: ConnectionState;
  trigger: string;
  at: string;
}
const E2E_CONNECTION_STATE_LOG_TAP_MAX = 200;
const e2eConnectionStateLogTap: ConnectionStateLogEntry[] = [];

function isPluginEnabled(pluginId: string): boolean {
  if (!enableStateCache) return true; // legacy install: preserve existing behaviour
  const value = enableStateCache.plugins[pluginId];
  // Missing entries also default to "enabled" so a plugin that appears after
  // the seed (e.g. user-installed via the install pipeline before its first
  // toggle) is not silently held back.
  return value !== "disabled";
}

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

/**
 * Path to the user plugins root (`~/.roubo/plugins/` by default). Exposed so
 * the install pipeline can place its staging directory under the same root,
 * which makes the final `rename(staging, target)` an atomic same-filesystem
 * move.
 */
export function getUserPluginsRoot(): string {
  return userPluginsRoot();
}

function logDirFor(pluginId: string): string {
  // Logs always live under the user plugins root (typically `~/.roubo/plugins/<id>/logs`),
  // even for bundled plugins. Tests override the root via ROUBO_USER_PLUGINS_DIR.
  //
  // Defence in depth: under vitest, refuse to fall back to the real ~/.roubo directory when
  // ROUBO_USER_PLUGINS_DIR isn't set. A previous race (env var cleared before in-flight writes
  // resolved) leaked test errors into the user's production log file. Throwing here turns that
  // class of bug into a loud test failure instead of silent pollution.
  if (process.env.NODE_ENV === "test" && !process.env.ROUBO_USER_PLUGINS_DIR) {
    throw new Error(
      "plugin-manager: refusing to write logs to the real user plugins dir under NODE_ENV=test " +
        "(set ROUBO_USER_PLUGINS_DIR to an isolated tmp dir from your test setup)",
    );
  }
  // Regex-validate pluginId so CodeQL recognises a sanitizer on the tainted segment
  // before it flows into path.resolve / path.relative below.
  assertSafeIdentifier(pluginId, PLUGIN_ID_RE, "pluginId");
  const root = path.resolve(userPluginsRoot());
  const resolved = path.resolve(root, pluginId, "logs");
  // Containment check uses path.relative + startsWith("..") because that is the shape
  // CodeQL's default js/path-injection suite recognises as a sanitizer (mirrors
  // `readLogs` below).
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `plugin-manager: plugin id "${pluginId}" resolves outside the plugins root; rejecting`,
    );
  }
  return resolved;
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
    const candidate = resolveWithin(dir, filename);
    try {
      const text = await readFile(candidate, "utf8");
      return { path: candidate, text };
    } catch {
      // try next
    }
  }
  return null;
}

function makeEmptyEntry(record: PluginRecord): PluginEntry {
  return {
    record,
    process: null,
    connection: null,
    logStream: null,
    logBytes: 0,
    logOpenPromise: null,
    legacyRotateChecked: false,
    intentionalStop: false,
    restartTimer: null,
  };
}

interface BuiltEntry {
  /** The map key under which this entry should be stored (manifest.id when valid, dir name otherwise). */
  idForMap: string;
  manifest: PluginManifest | null;
  entry: PluginEntry;
}

/**
 * Builds a single plugin entry from a directory by reading + validating its
 * manifest. Returns null when the directory contains no manifest file at all
 * (caller skips it). Duplicate-id handling is the caller's responsibility.
 */
async function buildEntryFromDir(
  pluginDir: string,
  source: PluginSource,
  fallbackId: string,
): Promise<BuiltEntry | null> {
  const manifestFile = await readManifestFile(pluginDir);
  if (!manifestFile) return null;

  const parsed = parseManifest(manifestFile.text, manifestFile.path);
  if (!parsed.ok) {
    const record = makeRecord(fallbackId, null, manifestFile.path, pluginDir, source, "invalid", {
      code: "invalid-manifest",
      message: parsed.error.message,
    });
    return { idForMap: fallbackId, manifest: null, entry: makeEmptyEntry(record) };
  }

  const manifest = parsed.manifest;

  if (!semver.validRange(manifest.roubo)) {
    const record = makeRecord(
      manifest.id,
      manifest,
      manifestFile.path,
      pluginDir,
      source,
      "invalid",
      {
        code: "invalid-roubo-range",
        message: `Manifest "roubo" field is not a valid semver range: ${manifest.roubo}`,
      },
    );
    return { idForMap: manifest.id, manifest, entry: makeEmptyEntry(record) };
  }

  if (!semver.satisfies(HOST_API_VERSION, manifest.roubo, { includePrerelease: false })) {
    const record = makeRecord(
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
    );
    return { idForMap: manifest.id, manifest, entry: makeEmptyEntry(record) };
  }

  if (!isValidEntryPath(manifest.entry)) {
    const record = makeRecord(
      manifest.id,
      manifest,
      manifestFile.path,
      pluginDir,
      source,
      "invalid",
      {
        code: "invalid-entry",
        message: `Manifest "entry" must be a relative path within the plugin directory: ${manifest.entry}`,
      },
    );
    return { idForMap: manifest.id, manifest, entry: makeEmptyEntry(record) };
  }

  const record = makeRecord(
    manifest.id,
    manifest,
    manifestFile.path,
    pluginDir,
    source,
    "disabled",
    null,
  );
  return { idForMap: manifest.id, manifest, entry: makeEmptyEntry(record) };
}

async function discoverRoot(
  root: string,
  source: PluginSource,
  acc: Map<string, PluginEntry>,
): Promise<void> {
  // `root` is supplied by trusted callers (bundledPluginsRoot / userPluginsRoot, both env-overridable
  // but server-controlled). Resolve once so subsequent containment checks have a stable base.
  const resolvedRoot = path.resolve(root);
  let dirents;
  try {
    dirents = await readdir(resolvedRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    // Skip the install-staging area used by plugin-installer.
    if (dirent.name === ".staging") continue;
    let pluginDir: string;
    try {
      pluginDir = resolveWithin(resolvedRoot, dirent.name);
    } catch {
      // dirent.name was a traversal payload (only possible via a hostile filesystem); skip it.
      continue;
    }
    const built = await buildEntryFromDir(pluginDir, source, dirent.name);
    if (!built) continue;

    if (acc.has(built.idForMap)) {
      // Bundled wins on duplicate ids: if a bundled entry already claimed
      // this id, mark the user-side one as invalid with a duplicate-id error.
      if (source === "user") {
        const manifestPath = built.entry.record.manifestPath;
        const dupRecord = makeRecord(
          built.idForMap,
          built.manifest,
          manifestPath,
          pluginDir,
          source,
          "invalid",
          {
            code: "duplicate-id",
            message: `Plugin id "${built.idForMap}" is already provided by a bundled plugin`,
          },
        );
        acc.set(`${built.idForMap}__user_duplicate`, makeEmptyEntry(dupRecord));
      }
      continue;
    }

    acc.set(built.idForMap, built.entry);
  }
}

async function ensureLogDir(pluginId: string): Promise<string> {
  const dir = logDirFor(pluginId);
  await mkdir(dir, { recursive: true });
  return dir;
}

// Matches the on-disk format produced by formatLogLine: `<ISO ts> <source>[ [level]] <text>`.
// Exported via __test for unit-test parity.
const LOG_RECORD_RE = /^(\S+) (stdout|stderr|host)(?: \[(info|warn|error)\])? (.*)$/;

// One-time legacy migration: pre-fix log files stored embedded newlines verbatim, so a single
// record spanned multiple physical lines. Reading them back fragmented the record and the
// fallback timestamp made continuation lines look like they were written "now". Detect any line
// that doesn't match the strict format and rotate the whole file aside so the user starts clean.
async function rotateLegacyLogIfNeeded(pluginId: string): Promise<void> {
  // Derive the log directory from pluginId via logDirFor, which validates that the resolved path
  // stays within userPluginsRoot(). Constructing the path here (rather than accepting a pre-built
  // dir string) keeps the sanitisation visible to CodeQL's interprocedural taint analysis.
  const dir = logDirFor(pluginId);
  const current = resolveWithin(dir, "current.log");
  let text: string;
  try {
    text = await readFile(current, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    return;
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return;
  const hasLegacy = lines.some((l) => !LOG_RECORD_RE.test(l));
  if (!hasLegacy) return;
  const previous = resolveWithin(dir, "previous.log");
  try {
    await unlink(previous);
  } catch {
    // best-effort; rename will overwrite on POSIX
  }
  try {
    await rename(current, previous);
  } catch {
    // best-effort
  }
}

async function openLogStream(entry: PluginEntry): Promise<void> {
  if (entry.logStream) return;
  if (entry.logOpenPromise) return entry.logOpenPromise;
  entry.logOpenPromise = (async () => {
    const dir = await ensureLogDir(entry.record.id);
    if (!entry.legacyRotateChecked) {
      entry.legacyRotateChecked = true;
      await rotateLegacyLogIfNeeded(entry.record.id);
    }
    const current = resolveWithin(dir, "current.log");
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
  const current = resolveWithin(dir, "current.log");
  const previous = resolveWithin(dir, "previous.log");
  try {
    await rename(current, previous);
  } catch {
    // best-effort
  }
}

// Escape backslashes and newlines so a single log record always occupies one physical line.
// Reversed by unescapeLogText in parseLogLine; order matters (backslash first on the way in,
// backslash last on the way out) so encoded sequences don't get double-decoded.
function escapeLogText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function unescapeLogText(text: string): string {
  return text.replace(/\\([\\nr])/g, (_, ch) => (ch === "n" ? "\n" : ch === "r" ? "\r" : "\\"));
}

function formatLogLine(
  source: "stdout" | "stderr" | "host",
  text: string,
  level?: "info" | "warn" | "error",
): string {
  const ts = nowIso();
  const lvl = level ? ` [${level}]` : "";
  return `${ts} ${source}${lvl} ${escapeLogText(text)}\n`;
}

// Tracks every in-flight writeLog promise. Two consumers drain this:
//   1. `readLogs()` snapshots and awaits it before reading the file so callers observe
//      writes enqueued just before this tick (denial logs from plugin-host-api.ts,
//      host-logger notifications, stdout/stderr fan-out). Without this, the file-read
//      can beat the write-callback under CI load.
//   2. `__test.flushLogs()` drains it in afterEach before clearing ROUBO_USER_PLUGINS_DIR,
//      so a still-pending write can't race the env-var clear and leak into ~/.roubo.
const pendingWrites = new Set<Promise<void>>();

async function writeLog(
  entry: PluginEntry,
  source: "stdout" | "stderr" | "host",
  text: string,
  level?: "info" | "warn" | "error",
): Promise<void> {
  const work = (async () => {
    if (!entry.logStream) {
      await openLogStream(entry);
    }
    const line = formatLogLine(source, text, level);
    const stream = entry.logStream;
    if (stream) {
      // Await the write callback so subsequent readFile()s observe the new bytes. Without this
      // the call returns immediately while the kernel buffer is still draining, and tests (or
      // a polling readLogs) can miss the entry that was just written.
      await new Promise<void>((resolve, reject) => {
        stream.write(line, (err) => (err ? reject(err) : resolve()));
      });
    }
    await rotateLogIfNeeded(entry, Buffer.byteLength(line, "utf8"));
  })();
  pendingWrites.add(work);
  try {
    await work;
  } finally {
    pendingWrites.delete(work);
  }
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

  const resolvedDir = path.resolve(entry.record.pluginDir);
  const entryPath = path.join(resolvedDir, manifest.entry);
  // Defensive: confirm resolved path is still inside the plugin dir.
  const resolvedEntry = path.resolve(entryPath);
  const entryRel = path.relative(resolvedDir, resolvedEntry);
  if (entryRel.startsWith("..") || path.isAbsolute(entryRel)) {
    entry.record.status = "errored";
    entry.record.lastError = {
      code: "invalid-entry",
      message: `Resolved entry path escapes plugin directory: ${resolvedEntry}`,
    };
    return;
  }

  const spawnArgs: string[] = [entryPath];
  if (process.env.ROUBO_E2E === "1") {
    if (e2eScenario !== null) spawnArgs.push(`--scenario=${e2eScenario}`);
    if (e2eNow !== null) spawnArgs.push(`--now=${e2eNow}`);
  }

  let proc: ChildProcess;
  try {
    proc = spawn(process.execPath, spawnArgs, {
      cwd: entry.record.pluginDir,
      env: {
        ...cleanEnv(),
        // Under Electron, process.execPath is the Electron binary. Without this flag it would
        // launch as a new GUI app and exit code 0 within seconds. With the flag, Electron runs
        // the entry as Node. Plain Node ignores the variable, so this is safe in dev too.
        ELECTRON_RUN_AS_NODE: "1",
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
    await registerHostHandlers(entry.connection, entry.record, (level, text) => {
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

  // WU-046: load the persisted enable-state once at boot. The migrate.run()
  // pass that ran moments earlier seeds this file; a missing file means
  // legacy install (pre-WU-046), and isPluginEnabled() preserves the prior
  // behaviour by defaulting everything to enabled.
  enableStateCache = pluginEnableState.loadEnableState();

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
    if (entry.record.status !== "disabled" || !entry.record.manifest) continue;
    if (!isPluginEnabled(entry.record.id)) continue;
    spawns.push(spawnPlugin(entry));
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
  enableStateCache = null;
  // FR-014: snapshots are in-process and tied to the running plugin set; drop
  // them on shutdown so a subsequent initialize() starts from a clean cache.
  issueSnapshotCache.clearAll();
  initialized = false;
}

export function listInstalled(): PluginRecord[] {
  return Array.from(plugins.values()).map((entry) => ({
    ...entry.record,
    restartHistory: [...entry.record.restartHistory],
  }));
}

/**
 * Fetch a single installed plugin's record, or `undefined` if unknown. Returns
 * a defensive copy so callers can't mutate the live entry. Useful for routes
 * that need to branch on `status` without walking `listInstalled()`.
 */
export function getRecord(pluginId: string): PluginRecord | undefined {
  const entry = plugins.get(pluginId);
  if (!entry) return undefined;
  return {
    ...entry.record,
    restartHistory: [...entry.record.restartHistory],
  };
}

// TC-154 (NFR-024): how long enable() waits after spawnPlugin returns before
// declaring the child "alive enough." Short enough that the happy-path UI
// click stays snappy, long enough to catch entry scripts that crash on
// first-line (Node's spawn() resolves before the child has had a chance to
// exit; without this window the route would 204 then the plugin would
// asynchronously flip to "errored" via the restart-budget path).
const ENABLE_SPAWN_SETTLE_MS = 250;

export async function enable(pluginId: string): Promise<void> {
  const entry = plugins.get(pluginId);
  if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
  if (!entry.record.manifest) {
    throw new Error(`Plugin "${pluginId}" has no valid manifest`);
  }
  if (entry.record.status === "incompatible") {
    throw new Error(`Plugin "${pluginId}" is incompatible with this host`);
  }
  if (entry.process) {
    // Already running. Record the user's intent and return; the on-disk file
    // converges with the runtime here even if it had drifted (e.g. a prior
    // crashed write).
    enableStateCache = pluginEnableState.setPluginEnabled(pluginId, true);
    return;
  }
  entry.record.status = "disabled" as PluginStatus;
  entry.record.lastError = null as PluginError | null;
  await spawnPlugin(entry);

  // Synchronous spawn failures (path traversal, spawn throw, missing pid,
  // RPC init failure) leave the record in status="errored". Surface them
  // before touching plugins-state.json. The `as` casts above widen the
  // literals so TS retains the full union after the mutation that
  // spawnPlugin performs across the await boundary.
  if (entry.record.status === "errored") {
    const err = entry.record.lastError;
    throw new Error(err ? err.message : `Plugin "${pluginId}" failed to start`);
  }

  // Async crash window: the child may exit just after spawn() resolves but
  // before we'd write-through. Wait briefly for an exit event so we don't
  // persist enabled state for a process that's about to die. The restart
  // logic in handleChildExit also fires for this exit and would eventually
  // mark the record as "errored" via restart-budget, but the UI needs the
  // failure surfaced now.
  const proc = entry.process as ChildProcess | null;
  if (proc) {
    const exitedEarly = await new Promise<boolean>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve(true);
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        proc.off("exit", onExit);
      };
      const onExit = () => {
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, ENABLE_SPAWN_SETTLE_MS);
      if (typeof timer.unref === "function") timer.unref();
      proc.once("exit", onExit);
    });
    if (exitedEarly) {
      // Roll the runtime back so plugins-state.json (still "disabled") and
      // the in-memory record agree. Cancel any pending restart timer that
      // handleChildExit may have scheduled and clear the restart history so
      // a later manual retry starts from a clean budget.
      if (entry.restartTimer) {
        clearTimeout(entry.restartTimer);
        entry.restartTimer = null;
      }
      const lastExit = entry.record.restartHistory.at(-1);
      entry.record.restartHistory = [];
      entry.record.status = "disabled";
      entry.record.lastError = null;
      const detail =
        lastExit && lastExit.exitCode !== null
          ? `exited with code ${lastExit.exitCode}`
          : "process exited before host could connect";
      throw new Error(`Plugin "${pluginId}" failed to start: ${detail}`);
    }
  }

  try {
    enableStateCache = pluginEnableState.setPluginEnabled(pluginId, true);
  } catch (err) {
    // Disk-write failed after a successful spawn. Roll back the spawn so
    // disk ("disabled") and runtime ("disabled") stay consistent. Preserves
    // WU-046's original concern about FS-write failures.
    await stopPluginProcess(entry);
    entry.record.status = "disabled";
    throw err;
  }
}

export async function disable(pluginId: string): Promise<void> {
  const entry = plugins.get(pluginId);
  if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
  enableStateCache = pluginEnableState.setPluginEnabled(pluginId, false);
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

/**
 * Uninstall a third-party plugin: stop its host process, remove its directory
 * from disk, and drop it from the in-memory registry so it no longer appears
 * in `listInstalled()`.
 *
 * Throws when:
 *  - the plugin is unknown,
 *  - the plugin is bundled (FR-016: bundled plugins are not uninstallable),
 *  - any project's effective integration config still references the plugin.
 *    The user must clear or reassign each project's integration plugin
 *    before retrying, mirroring the jig-delete-when-referenced rule.
 */
export async function uninstall(pluginId: string): Promise<void> {
  const entry = plugins.get(pluginId);
  if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
  if (entry.record.source === "bundled") {
    throw new Error(`Bundled plugins cannot be uninstalled: ${pluginId}`);
  }

  const referencingProjects: string[] = [];
  for (const project of projectRegistry.getProjects()) {
    const active = resolveActivePlugin(project.id);
    if (active?.pluginId === pluginId) referencingProjects.push(project.id);
  }
  if (referencingProjects.length > 0) {
    throw new Error(
      `Plugin "${pluginId}" is the active integration for project(s): ${referencingProjects.join(", ")}. Clear or reassign each project's integration plugin first.`,
    );
  }

  await stopPluginProcess(entry);

  if (entry.logStream) {
    const stream = entry.logStream;
    entry.logStream = null;
    await new Promise<void>((resolve) => stream.end(resolve));
  }

  await rm(entry.record.pluginDir, { recursive: true, force: true });
  plugins.delete(pluginId);
  // WU-046: keep plugins-state.json in sync so a re-installed plugin id
  // doesn't carry the prior install's enable bit by accident.
  pluginEnableState.removePlugin(pluginId);
  // FR-014: a re-installed plugin id is a different deployment; previously
  // cached issues should not bleed across the uninstall boundary. Note that
  // we deliberately do *not* clear the snapshot on disable() — FR-014 calls
  // for serving the last-good snapshot while a plugin is `disabled`.
  issueSnapshotCache.clearSnapshot(pluginId);
}

/**
 * Add a freshly-installed plugin directory to the in-memory state and start
 * it. Called by the plugin-installer after it has moved a validated staging
 * directory into `~/.roubo/plugins/<id>/`. The caller is responsible for
 * having ruled out duplicate ids before invoking this — we throw if the id
 * is already known.
 */
export async function registerInstalled(pluginDir: string): Promise<PluginRecord> {
  const fallbackId = path.basename(pluginDir);
  const built = await buildEntryFromDir(pluginDir, "user", fallbackId);
  if (!built) {
    throw new Error(`No roubo-plugin manifest found in ${pluginDir}`);
  }
  if (plugins.has(built.idForMap)) {
    throw new Error(`Plugin "${built.idForMap}" is already registered`);
  }
  plugins.set(built.idForMap, built.entry);

  if (built.entry.record.status === "disabled" && built.entry.record.manifest) {
    await spawnPlugin(built.entry);
  }

  return {
    ...built.entry.record,
    restartHistory: [...built.entry.record.restartHistory],
  };
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
        .catch((err: Error & { code?: unknown }) => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          // If the cause is cancellation due to our own timeout we already rejected.
          if (tokenSource.token.isCancellationRequested) return;
          // vscode-jsonrpc surfaces JSON-RPC error -32601 as a numeric `code` on
          // a ResponseError. Translate it to the string "MethodNotFound" so
          // callers (e.g. plugin-activation's setActiveConfig guard) can detect
          // plugins that don't implement an optional method.
          const code =
            typeof err.code === "number" && err.code === -32601 ? "MethodNotFound" : "rpc-error";
          reject(makeRpcError(code, err.message ?? String(err), method));
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
const LOG_FILE_NAMES = new Set(["current", "previous"]);

export async function readLogs(
  pluginId: string,
  file: "current" | "previous" = "current",
  lines = 500,
): Promise<LogLine[]> {
  assertSafeIdentifier(pluginId, PLUGIN_ID_RE, "pluginId");
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
  // Host loggers (denial paths in plugin-host-api.ts, stdout/stderr from
  // attachStdioLogging, RPC error handlers) add their writeLog promise to
  // `pendingWrites` synchronously but settle asynchronously. Snapshot the
  // set once and await it so this read observes every write that was
  // enqueued before readLogs was called. Snapshot once, not a while-loop:
  // under a chatty live plugin a `while (pendingWrites.size > 0)` would
  // livelock as new stdout lines kept arriving.
  if (pendingWrites.size > 0) {
    await Promise.allSettled(Array.from(pendingWrites));
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
  // Lines that don't match are pre-fix legacy data (or a continuation line from an entry whose
  // text contained an unescaped newline). Return ts: "" so the UI doesn't synthesise a misleading
  // "now" timestamp at read time.
  const match = raw.match(/^(\S+) (stdout|stderr|host)(?: \[(info|warn|error)\])? (.*)$/);
  if (!match) {
    return { ts: "", source: "host", text: raw };
  }
  const [, ts, source, level, text] = match;
  return {
    ts,
    source: source as LogLine["source"],
    level: (level as LogLine["level"]) ?? undefined,
    text: unescapeLogText(text),
  };
}

/**
 * WU-044: cached, de-duped wrapper around the plugin's `getConnectionStatus`
 * RPC (host-API 1.1.0+, FR-054/FR-055). Plugins built against 1.0.0 don't
 * implement `getConnectionStatus`; the host catches the `MethodNotFound` and
 * falls back to invoking `validateConfig`, inferring `connected` vs
 * `auth-problem` from the result (TC-113).
 *
 * Results are cached for 30 seconds per `pluginId`; concurrent calls within
 * the in-flight window share a single RPC invocation. Callers resolve the
 * plugin-wide config (same shape as `setActiveConfig`) and pass it in, which
 * keeps this layer free of the project-registry / overrides plumbing.
 */
export async function getConnectionStatus(
  pluginId: string,
  config: Record<string, unknown>,
  options: { force?: boolean; trigger?: string } = {},
): Promise<ConnectionStatus> {
  if (!options.force) {
    const cached = connectionStatusCache.get(pluginId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }

  // Always consult the in-flight map, even when `force` is set: this is what
  // gives the WU-050 opportunistic re-check its per-plugin dedup. Two
  // concurrent forced calls share one RPC; a forced call piggy-backs on an
  // in-flight non-forced call (and vice versa).
  const inFlight = inFlightConnectionStatusRequests.get(pluginId);
  if (inFlight) return inFlight;

  // Snapshot the previously-cached state (if any) before issuing the RPC so
  // the state-transition journal can compare against it once the new value
  // arrives. `null` means we have never observed a value for this plugin.
  const previousState: ConnectionState | null =
    connectionStatusCache.get(pluginId)?.value.state ?? null;
  const trigger = options.trigger ?? "opportunistic-recheck";

  const promise = fetchConnectionStatus(pluginId, config)
    .then((value) => {
      connectionStatusCache.set(pluginId, {
        value,
        expiresAt: Date.now() + CONNECTION_STATUS_TTL_MS,
      });
      if (previousState !== value.state) {
        recordConnectionStateTransition(pluginId, previousState, value.state, trigger);
      }
      return value;
    })
    .finally(() => {
      inFlightConnectionStatusRequests.delete(pluginId);
    });

  inFlightConnectionStatusRequests.set(pluginId, promise);
  return promise;
}

function recordConnectionStateTransition(
  pluginId: string,
  previousState: ConnectionState | null,
  newState: ConnectionState,
  trigger: string,
): void {
  const entry: ConnectionStateLogEntry = {
    event: CONNECTION_STATE_CHANGED_EVENT,
    pluginId,
    previousState,
    newState,
    trigger,
    at: nowIso(),
  };
  // NFR-023: durable host-side structured log. Single JSON line on stdout via
  // the existing log destination. The payload intentionally carries only
  // pluginId + states + trigger + ISO timestamp; no detail / credentials / PII.
  console.info(JSON.stringify(entry));
  if (process.env.ROUBO_E2E === "1") {
    e2eConnectionStateLogTap.push(entry);
    if (e2eConnectionStateLogTap.length > E2E_CONNECTION_STATE_LOG_TAP_MAX) {
      e2eConnectionStateLogTap.splice(
        0,
        e2eConnectionStateLogTap.length - E2E_CONNECTION_STATE_LOG_TAP_MAX,
      );
    }
  }
}

/**
 * Drop the cached `getConnectionStatus` value for a single plugin. Call this
 * the moment the host changes credentials for a plugin (e.g. after the
 * github-com OAuth exchange writes a new token to the keyring) so the next
 * UI poll skips the 30-second cache and re-probes under the new credential.
 */
export function invalidateConnectionStatus(pluginId: string): void {
  connectionStatusCache.delete(pluginId);
  inFlightConnectionStatusRequests.delete(pluginId);
}

async function fetchConnectionStatus(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<ConnectionStatus> {
  try {
    return await connectionStatusInvoker<ConnectionStatus>(
      pluginId,
      "getConnectionStatus",
      undefined,
      { timeoutMs: CONNECTION_STATUS_RPC_TIMEOUT_MS },
    );
  } catch (err) {
    if (!isMethodNotFound(err)) {
      return {
        state: "errored",
        detail: errorMessage(err),
        checkedAt: nowIso(),
      };
    }
    return await connectionStatusViaValidateConfig(pluginId, config);
  }
}

async function connectionStatusViaValidateConfig(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<ConnectionStatus> {
  let result: ValidateConfigResult;
  try {
    result = await connectionStatusInvoker<ValidateConfigResult>(
      pluginId,
      "validateConfig",
      { config },
      { timeoutMs: CONNECTION_STATUS_RPC_TIMEOUT_MS },
    );
  } catch (err) {
    if (isMethodNotFound(err)) {
      // No plugin-wide config to validate (e.g. github.com with a fixed
      // API host). The spec treats this as healthy in the fallback path.
      return { state: "connected", checkedAt: nowIso() };
    }
    return {
      state: "errored",
      detail: errorMessage(err),
      checkedAt: nowIso(),
    };
  }

  if (result.ok) {
    return { state: "connected", checkedAt: nowIso() };
  }
  return {
    state: "auth-problem",
    detail: result.errors?.[0]?.message,
    checkedAt: nowIso(),
  };
}

function isMethodNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code === "MethodNotFound";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
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
    enableStateCache = null;
    connectionStatusCache.clear();
    inFlightConnectionStatusRequests.clear();
    connectionStatusInvoker = (pluginId, method, params, opts) =>
      invoke(pluginId, method, params, opts);
    LOG_ROTATION_BYTES = 5 * 1024 * 1024;
    e2eScenario = null;
    e2eNow = null;
    e2eConnectionStateLogTap.length = 0;
  },
  setE2EConfig(config: { scenario: string | null; now: string | null }): void {
    e2eScenario = config.scenario;
    e2eNow = config.now;
  },
  getE2EConfig(): { scenario: string | null; now: string | null } {
    return { scenario: e2eScenario, now: e2eNow };
  },
  resetConnectionStatusCache(): void {
    connectionStatusCache.clear();
    inFlightConnectionStatusRequests.clear();
  },
  // TC-153 e2e tap accessors. The tap is only populated when ROUBO_E2E=1
  // (see `recordConnectionStateTransition`); in production both helpers return
  // an empty buffer. These exist so the Playwright harness can poll a
  // deterministic surface without scraping the running server's stdout.
  resetE2EConnectionStateLogTap(): void {
    e2eConnectionStateLogTap.length = 0;
  },
  getE2EConnectionStateLogTap(): ConnectionStateLogEntry[] {
    return e2eConnectionStateLogTap.slice();
  },
  setConnectionStatusInvoker(fn: ConnectionStatusInvoker | null): void {
    connectionStatusInvoker =
      fn ?? ((pluginId, method, params, opts) => invoke(pluginId, method, params, opts));
  },
  setEnableStateCache(state: PluginEnableState | null): void {
    enableStateCache = state;
  },
  getEnableStateCache(): PluginEnableState | null {
    return enableStateCache;
  },
  setLogRotationBytes(bytes: number): void {
    LOG_ROTATION_BYTES = bytes;
  },
  getEntry(pluginId: string): PluginEntry | undefined {
    return plugins.get(pluginId);
  },
  // TC-163 (#240): SIGKILL the live child of `pluginId` so the supervisor sees
  // a genuine `unexpected-exit` and runs the full restart-budget path in
  // `handleChildExit`. Gated by ROUBO_E2E so production builds can't trigger
  // it. We intentionally do not flip `intentionalStop` — the goal is to
  // exercise the real auto-restart loop, not the clean-shutdown path.
  crashRunningPlugin(pluginId: string): { pid: number } {
    if (process.env.ROUBO_E2E !== "1") {
      throw new Error("crashRunningPlugin requires ROUBO_E2E=1");
    }
    const entry = plugins.get(pluginId);
    if (!entry) throw new Error(`Unknown plugin: ${pluginId}`);
    const pid = entry.process?.pid;
    if (!pid) {
      throw new Error(`Plugin "${pluginId}" is not running (status=${entry.record.status})`);
    }
    process.kill(pid, "SIGKILL");
    return { pid };
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
  // Resolves after every currently-pending writeLog has settled. Tests call this in afterEach
  // before clearing ROUBO_USER_PLUGINS_DIR to keep async writes from racing the cleanup.
  async flushLogs(): Promise<void> {
    while (pendingWrites.size > 0) {
      await Promise.allSettled(Array.from(pendingWrites));
    }
  },
  logRecordRegex: LOG_RECORD_RE,
  escapeLogText,
  unescapeLogText,
  bundledRoot: bundledPluginsRoot,
  userRoot: userPluginsRoot,
};
