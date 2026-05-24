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
import * as projectRegistry from "./project-registry.js";
import { resolveActivePlugin } from "./active-plugin.js";

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
  legacyRotateChecked: boolean;
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
  const root = userPluginsRoot();
  const resolved = path.resolve(root, pluginId, "logs");
  // Prevent path traversal: a pluginId containing ".." or absolute segments (from a malformed
  // manifest) must not escape the expected root directory.
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
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
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    // Skip the install-staging area used by plugin-installer.
    if (dirent.name === ".staging") continue;
    const pluginDir = path.join(root, dirent.name);
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
  const current = path.join(dir, "current.log");
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
  const previous = path.join(dir, "previous.log");
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

// Tracks every in-flight writeLog promise so `__test.flushLogs()` can await them all and
// guarantee the test's `afterEach` doesn't unset ROUBO_USER_PLUGINS_DIR while a write is still
// in the queue. (Without tracking, the env-var clear could race with logDirFor() and leak into
// the real ~/.roubo dir.)
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
