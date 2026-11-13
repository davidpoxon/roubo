/**
 * The plugin surface of hot reload (HR-FR-006, HR-FR-007, HR-FR-008): one
 * InputWatcher watch of the user plugins root (`~/.roubo/plugins`), whose
 * inputs are its plugin directories.
 *
 * - A new directory is validated and registered. A component or agent plugin
 *   with no ConsentRecord stays inert, also after a relaunch, until consent is
 *   granted: discovery never grants consent. An integration plugin, which is
 *   never consent-gated, starts unless the user disabled it. An invalid
 *   manifest is rejected with its first error and registers nothing.
 * - A changed manifest or entry file of a registered plugin swaps its process,
 *   keeping every bench resource (HR-FR-009).
 * - A removed directory unregisters its plugin, unless a bench uses it: then
 *   the removal is refused and the plugin keeps running (HR-FR-010).
 *
 * Each directory is fingerprinted by its manifest bytes and its declared entry
 * file only, after a completeness gate that waits until a copy into it has
 * stopped, so a slow recursive copy with `node_modules` (which the watch
 * ignores) registers once.
 *
 * The app's own writes of a plugin directory (a marketplace install, update
 * or uninstall) run through `runAppPluginWrite`: the watch holds its runs
 * until the write ends, the write marks the directory applied, and the run the
 * write caused is deduped. One registration, one notice, one applied line.
 */
import fs from "node:fs";
import path from "node:path";
import { isConsentGatedKind, parseManifest, type PluginRecord } from "@roubo/shared";
import * as pluginManager from "./plugin-manager.js";
import { PluginSwapRefusedError } from "./plugin-manager.js";
import { benchList, PluginInUseError } from "./plugin-in-use.js";
import { hasConsent } from "./plugin-consent-state.js";
import { staleBenchIds } from "./plugin-swap-state.js";
import {
  addOwnedWatchRoot,
  hashInputFiles,
  logApply,
  watchInput,
  type HandlerResult,
  type InputChange,
  type InputEventDetail,
  type InputWatch,
} from "./input-watcher.js";
import { broadcastInputChanged } from "./sse.js";

export const PLUGIN_SURFACE = "plugin";
/** The settle window of one plugin directory. */
export const PLUGIN_SETTLE_MS = 500;
/** How long the completeness gate waits between two looks at a directory. */
export const PLUGIN_COMPLETE_POLL_MS = 500;
/** How long the completeness gate waits for a copy to stop before it gives up. */
export const PLUGIN_COMPLETE_TIMEOUT_MS = 120_000;

const MANIFEST_NAMES = ["roubo-plugin.yaml", "roubo-plugin.yml"] as const;
// Directories below a plugin that change while it runs or that a copy fills
// without the watch seeing it: the plugin's own logs and its dependencies.
const LOGS_DIR = "logs";
const NODE_MODULES = "node_modules";

/** What changed in the set of registered plugins. */
export interface PluginSetChange {
  added: string[];
  swapped: string[];
  removed: string[];
}

type PluginSetListener = (change: PluginSetChange) => void;
const pluginSetListeners = new Set<PluginSetListener>();

/**
 * Listen for each change of the registered plugin set that this surface makes.
 * The server re-runs component-binding validation of every project here.
 * Returns a function that stops the listening.
 */
export function onPluginSetChanged(listener: PluginSetListener): () => void {
  pluginSetListeners.add(listener);
  return () => {
    pluginSetListeners.delete(listener);
  };
}

function pluginSetChanged(change: Partial<PluginSetChange>): void {
  const full: PluginSetChange = {
    added: change.added ?? [],
    swapped: change.swapped ?? [],
    removed: change.removed ?? [],
  };
  for (const listener of pluginSetListeners) {
    try {
      listener(full);
    } catch (err) {
      console.warn(`[plugin-dir-watch] plugin set listener failed: ${(err as Error).message}`);
    }
  }
}

// ── Notice copy ──

/** "Plugin database installed." with the consent step when it is still to do. */
export function installedNotice(pluginId: string, consented: boolean): string {
  return consented
    ? `Plugin ${pluginId} installed.`
    : `Plugin ${pluginId} installed. Grant consent in Settings > Plugins to enable it.`;
}

/**
 * The install notice of `record`: the consent step is named only for a
 * component or agent plugin with no ConsentRecord, the kinds that the plugin
 * tile offers consent for. An integration plugin is never consent-gated.
 */
function installedNoticeOf(record: PluginRecord): string {
  const needsConsent = isConsentGatedKind(record.manifest?.kind) && !hasConsent(record.id);
  return installedNotice(record.id, !needsConsent);
}

/** "Plugin database updated to 1.2.0. 1 bench kept its components." */
export function updatedNotice(
  pluginId: string,
  version: string | null,
  benchCount: number,
): string {
  const head = version
    ? `Plugin ${pluginId} updated to ${version}.`
    : `Plugin ${pluginId} updated.`;
  if (benchCount <= 0) return head;
  return benchCount === 1
    ? `${head} 1 bench kept its components.`
    : `${head} ${benchCount} benches kept their components.`;
}

/**
 * The notice of an update whose new process did not start, or did not keep
 * its link to the benches (HR-FR-009): "Plugin database updated, but bench 2
 * lost its link to it. The components still run. Restart bench 2 to
 * reconnect." With no bench, it names the plugin's own restart.
 */
export function staleUpdateNotice(
  pluginId: string,
  version: string | null,
  benchIds: number[],
): string {
  const head = version ? `Plugin ${pluginId} updated to ${version}` : `Plugin ${pluginId} updated`;
  if (benchIds.length === 0) return `${head}, but it did not start cleanly. Restart it to retry.`;
  const benches = benchList(benchIds);
  const lost = benchIds.length === 1 ? "lost its link" : "lost their link";
  return `${head}, but ${benches} ${lost} to it. The components still run. Restart ${benches} to reconnect.`;
}

/**
 * The notice of a swap refused because the plugin keeps its component state
 * in its process: "Plugin my-plugin not updated live. It keeps component
 * state. Stop benches 2 and 5, then update it." With no bench, a relaunch
 * loads the new copy.
 */
export function notUpdatedLiveNotice(pluginId: string, benchIds: number[]): string {
  const head = `Plugin ${pluginId} not updated live. It keeps component state.`;
  if (benchIds.length === 0) return `${head} Relaunch Roubo to update it.`;
  return `${head} Stop ${benchList(benchIds)}, then update it.`;
}

/** Whether a swap of `record` left it errored or stale, so the update did not hold. */
function swapDidNotHold(record: PluginRecord | undefined): boolean {
  return record !== undefined && (record.stale === true || record.status === "errored");
}

export function removedNotice(pluginId: string): string {
  return `Plugin ${pluginId} removed.`;
}

/**
 * The first manifest error as a sentence clause: zod's `kind: Invalid option:
 * expected one of "integration"|"component"|"agent"` reads as `kind must be
 * one of integration, component, agent`. Any other message is kept, less a
 * trailing period.
 */
export function manifestFirstError(message: string): string {
  const option = /^([\w.]+): Invalid option: expected one of (.+)$/.exec(message);
  if (option) {
    const values = option[2]
      .split("|")
      .map((v) => v.trim().replace(/^"|"$/g, ""))
      .join(", ");
    return `${option[1]} must be one of ${values}`;
  }
  return message.replace(/\.$/, "");
}

// ── Fingerprint and completeness gate ──

function manifestFileOf(dir: string): string | null {
  for (const name of MANIFEST_NAMES) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return name;
    } catch {
      // try the next name
    }
  }
  return null;
}

/**
 * The files that fingerprint a plugin directory: its manifest and, when the
 * manifest parses and names a relative entry, that entry file.
 */
export function pluginFingerprintFiles(dir: string): string[] {
  const manifest = manifestFileOf(dir);
  if (manifest === null) return [MANIFEST_NAMES[0]];
  const files = [manifest];
  try {
    const parsed = parseManifest(fs.readFileSync(path.join(dir, manifest), "utf8"), manifest);
    if (parsed.ok) {
      const entry = path.normalize(parsed.manifest.entry);
      if (!path.isAbsolute(entry) && !entry.split(path.sep).includes("..")) files.push(entry);
    }
  } catch {
    // An unreadable manifest is fingerprinted by its name alone.
  }
  return files;
}

/** The fingerprint hash of a plugin directory, as the watch computes it. */
export function pluginDirHash(dir: string): string | null {
  return hashInputFiles(dir, pluginFingerprintFiles(dir));
}

/**
 * One look at everything below `dir` but its logs: how many files, their total
 * size and the newest mtime. A copy in progress changes it from one look to
 * the next. Null when `dir` is gone.
 */
async function treeLook(dir: string): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  let count = 0;
  let bytes = 0;
  let newest = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, abs);
    if (rel.split(path.sep)[0] === LOGS_DIR) continue;
    try {
      const stat = await fs.promises.lstat(abs);
      count += 1;
      bytes += stat.size;
      newest = Math.max(newest, stat.mtimeMs);
    } catch {
      // Removed between the listing and the stat: the tree is still moving,
      // so this look matches no other.
      return `moving:${performance.now()}`;
    }
  }
  return `${count}:${bytes}:${newest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The completeness gate of a plugin directory: it resolves once two looks
 * `pollMs` apart see the same tree, so a copy (`node_modules` included, which
 * the watch does not see) has stopped, and then lists the fingerprint files.
 * False when the copy has not stopped after `timeoutMs`.
 */
export function pluginDirCompleteness(
  pollMs = PLUGIN_COMPLETE_POLL_MS,
  timeoutMs = PLUGIN_COMPLETE_TIMEOUT_MS,
): (dir: string) => Promise<false | readonly string[]> {
  return async (dir) => {
    const end = Date.now() + timeoutMs;
    let previous = await treeLook(dir);
    for (;;) {
      if (previous === null) return pluginFingerprintFiles(dir);
      await sleep(pollMs);
      const next = await treeLook(dir);
      if (next === previous) break;
      if (Date.now() > end) return false;
      previous = next;
    }
    return pluginFingerprintFiles(dir);
  };
}

/**
 * Whether the watch skips `absPath` below the plugins `root`: the install
 * staging area and any other dot entry at the top, any `node_modules`, and
 * each plugin's `logs`.
 */
export function isIgnoredPluginPath(root: string, absPath: string): boolean {
  const rel = path.relative(root, absPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts[0].startsWith(".")) return true;
  if (parts.includes(NODE_MODULES)) return true;
  return parts.length >= 2 && parts[1] === LOGS_DIR;
}

// ── The handler ──

function userRecordOf(dirName: string): PluginRecord | undefined {
  return pluginManager
    .listInstalled()
    .find((r) => r.source === "user" && path.basename(r.pluginDir) === dirName);
}

function result(
  outcome: "applied" | "rejected" | "refused",
  action: "register" | "swap" | "unregister",
  event: InputEventDetail,
): HandlerResult {
  return { outcome, action, event };
}

// The plugin directories, by name, that this watch or an app write through it
// registered and has not yet seen removed. A directory that is in neither this
// set nor the registry held no plugin, so its removal is not one.
const registeredDirs = new Set<string>();

async function handleRemoved(dirName: string): Promise<HandlerResult> {
  const record = userRecordOf(dirName);
  if (!record) {
    // A directory that never held a registered plugin, such as the `logs` a
    // bundled plugin writes under the plugins root or a fresh empty directory,
    // is not a plugin: its removal sends nothing.
    if (!registeredDirs.delete(dirName)) return "ignored";
    return result("applied", "unregister", {
      pluginId: dirName,
      summary: removedNotice(dirName),
    });
  }
  try {
    await pluginManager.unregisterRemoved(record.id);
  } catch (err) {
    if (err instanceof PluginInUseError) {
      return result("refused", "unregister", {
        pluginId: record.id,
        benchIds: err.benchIds,
        summary: err.notice,
        error: { path: dirName, first: err.message },
      });
    }
    throw err;
  }
  registeredDirs.delete(dirName);
  pluginSetChanged({ removed: [record.id] });
  return result("applied", "unregister", {
    pluginId: record.id,
    summary: removedNotice(record.id),
  });
}

function rejectedManifest(
  pluginId: string,
  action: "register" | "swap",
  message: string,
): HandlerResult {
  const first = manifestFirstError(message);
  const lead =
    action === "register"
      ? `Plugin ${pluginId} not registered.`
      : `Plugin ${pluginId} not updated.`;
  return result("rejected", action, {
    pluginId,
    summary: `${lead} ${MANIFEST_NAMES[0]}: ${first}.`,
    error: { path: MANIFEST_NAMES[0], first },
  });
}

async function handlePresent(dir: string, dirName: string): Promise<HandlerResult> {
  let record = userRecordOf(dirName);
  const inspection = await pluginManager.inspectPluginDir(dir);
  const valid = inspection !== null && inspection.error === null && inspection.manifest !== null;

  // A registered plugin that never had a valid manifest has no process to
  // swap: once its directory is fixed it is registered again.
  if (
    record &&
    valid &&
    (!record.manifest || record.status === "invalid" || record.status === "incompatible")
  ) {
    await pluginManager.forgetInvalidEntry(record.id);
    record = userRecordOf(dirName);
  }

  if (!valid) {
    const pluginId = inspection?.id ?? record?.id ?? dirName;
    const message = inspection?.error?.message ?? "no manifest was found";
    return rejectedManifest(pluginId, record?.manifest ? "swap" : "register", message);
  }

  if (record) {
    try {
      await pluginManager.swapProcess(record.id);
    } catch (err) {
      if (err instanceof PluginSwapRefusedError) {
        if (err.reason === "imperative") {
          return result("refused", "swap", {
            pluginId: record.id,
            ...(err.benchIds.length > 0 ? { benchIds: [...err.benchIds] } : {}),
            summary: notUpdatedLiveNotice(record.id, err.benchIds),
            error: { path: MANIFEST_NAMES[0], first: err.detail },
          });
        }
        // A new manifest the swap cannot use (one that names another id) is
        // rejected with the same copy as one that does not parse.
        if (err.reason === "invalid-manifest") {
          return rejectedManifest(record.id, "swap", err.detail);
        }
        return result("refused", "swap", {
          pluginId: record.id,
          summary: `Plugin ${record.id} not updated: ${err.detail}.`,
          error: { path: MANIFEST_NAMES[0], first: err.detail },
        });
      }
      throw err;
    }
    pluginSetChanged({ swapped: [record.id] });
    // A new process that did not start, or exited during the re-bind, does not
    // make the swap throw: it leaves the plugin errored and stale, with the
    // bench resources still running. The swap applied, but the notice says so.
    if (swapDidNotHold(pluginManager.getRecord(record.id))) {
      const benchIds = staleBenchIds(record.id);
      return result("applied", "swap", {
        pluginId: record.id,
        ...(benchIds.length > 0 ? { benchIds } : {}),
        summary: staleUpdateNotice(record.id, null, benchIds),
      });
    }
    return result("applied", "swap", {
      pluginId: record.id,
      summary: `Plugin ${record.id} updated.`,
    });
  }

  const pluginId = inspection.id;
  if (pluginManager.getRecord(pluginId)) {
    return result("rejected", "register", {
      pluginId,
      summary: `Plugin ${pluginId} not registered. Plugin id "${pluginId}" is already registered.`,
      error: { path: MANIFEST_NAMES[0], first: `Plugin id "${pluginId}" is already registered` },
    });
  }
  const registered = await pluginManager.registerInstalled(dir, { inertUntilConsent: true });
  registeredDirs.add(dirName);
  pluginSetChanged({ added: [registered.id] });
  return result("applied", "register", {
    pluginId: registered.id,
    summary: installedNoticeOf(registered),
  });
}

/** The handler of one plugin directory under the plugins root. */
export async function handlePluginDirChange(change: InputChange): Promise<HandlerResult> {
  const dirName = path.basename(change.path);
  let isDir = false;
  try {
    isDir = fs.statSync(change.path).isDirectory();
  } catch {
    // Gone: a removal.
  }
  if (change.hash === null || !isDir) {
    if (!isDir && fs.existsSync(change.path)) {
      return result("rejected", "register", {
        pluginId: dirName,
        summary: `Plugin ${dirName} not registered. ${dirName} is not a directory.`,
        error: { path: dirName, first: "not a directory" },
      });
    }
    return handleRemoved(dirName);
  }
  // A running plugin writes its logs below its directory, so removing the
  // directory can leave, or bring back, one that holds only `logs`: that is
  // still a removal of a registered plugin, and nothing for any other.
  if (holdsOnlyLogs(change.path)) return handleRemoved(dirName);
  return handlePresent(change.path, dirName);
}

/** Whether `dir` holds nothing but a `logs` directory and dot files. */
function holdsOnlyLogs(dir: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.every((name) => name === LOGS_DIR || name.startsWith("."));
}

// ── The app's own writes ──

const appWrites = new Set<Promise<unknown>>();

/** Resolves once no app write of a plugin directory is in flight. */
async function appWritesEnded(): Promise<void> {
  while (appWrites.size > 0) {
    await Promise.allSettled([...appWrites]);
  }
}

/** What an app write applied, for its one applied line and one notice. */
export interface AppPluginWriteOutcome {
  /** The plugin directory the write changed. */
  dir: string;
  action: "register" | "swap" | "unregister";
  pluginId: string;
  summary: string;
  benchIds?: number[];
}

/**
 * The outcome of a marketplace install or update that registered `record`.
 * An update whose new process did not start, or lost its benches, leaves
 * `record` errored or stale: its notice names the benches that lost their
 * link instead of the ones that kept their components. Each caller passes the
 * record that registerInstalled returned, which it copies after the swap and
 * its re-bind, so its `stale` and `status` are the swap's result.
 */
export function appInstallOutcome(
  record: PluginRecord,
  update: boolean,
  benchCount = 0,
): AppPluginWriteOutcome {
  if (update && swapDidNotHold(record)) {
    const benchIds = staleBenchIds(record.id);
    return {
      dir: record.pluginDir,
      action: "swap",
      pluginId: record.id,
      summary: staleUpdateNotice(record.id, record.manifest?.version ?? null, benchIds),
      ...(benchIds.length > 0 ? { benchIds } : {}),
    };
  }
  return update
    ? {
        dir: record.pluginDir,
        action: "swap",
        pluginId: record.id,
        summary: updatedNotice(record.id, record.manifest?.version ?? null, benchCount),
      }
    : {
        dir: record.pluginDir,
        action: "register",
        pluginId: record.id,
        summary: installedNoticeOf(record),
      };
}

let active: { watch: InputWatch; root: string; dropRoot: () => void } | null = null;

function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir));
    } catch {
      return path.resolve(dir);
    }
  }
}

/**
 * Run an app write of a plugin directory, such as a marketplace install, so it
 * converges with the watch (HR-TC-022): the watch holds its runs until the
 * write ends; then, when `outcome` names what the write applied, the directory
 * is marked applied in the watch, one applied line is logged and one notice is
 * sent. The run the write caused is then deduped. A write that throws is
 * reported by its caller as before.
 */
export async function runAppPluginWrite<T>(
  write: () => Promise<T>,
  outcome: (value: T) => AppPluginWriteOutcome | null,
): Promise<T> {
  const start = performance.now();
  const pending = write();
  appWrites.add(pending);
  let value: T;
  try {
    value = await pending;
  } finally {
    appWrites.delete(pending);
  }
  try {
    const applied = outcome(value);
    if (applied) reportAppWrite(applied, start);
  } catch (err) {
    console.warn(`[plugin-dir-watch] app write report failed: ${(err as Error).message}`);
  }
  return value;
}

function reportAppWrite(applied: AppPluginWriteOutcome, start: number): void {
  const dir = realDir(applied.dir);
  const hash = fs.existsSync(dir) ? pluginDirHash(dir) : null;
  active?.watch.markApplied(dir, hash);
  logApply({
    surface: PLUGIN_SURFACE,
    path: dir,
    outcome: "applied",
    hash8: hash === null ? "none" : hash.slice(0, 8),
    durationMs: Math.round(performance.now() - start),
    action: applied.action,
  });
  broadcastInputChanged({
    surface: PLUGIN_SURFACE,
    outcome: "applied",
    pluginId: applied.pluginId,
    ...(applied.benchIds === undefined ? {} : { benchIds: [...applied.benchIds] }),
    summary: applied.summary,
  });
  if (applied.action === "unregister") registeredDirs.delete(path.basename(dir));
  else registeredDirs.add(path.basename(dir));
  if (applied.action === "register") pluginSetChanged({ added: [applied.pluginId] });
  else if (applied.action === "swap") pluginSetChanged({ swapped: [applied.pluginId] });
  else pluginSetChanged({ removed: [applied.pluginId] });
}

export interface PluginDirWatchOptions {
  root?: string;
  settleMs?: number;
  pollMs?: number;
  completeTimeoutMs?: number;
  rearmPollMs?: number;
}

/**
 * Arm the watch of the user plugins root. Resolves once each plugin directory
 * on disk has been fingerprinted, so only a change after it runs the handler.
 * A second call while armed returns the armed watch.
 */
export async function startPluginDirWatch(
  options: PluginDirWatchOptions = {},
): Promise<InputWatch> {
  if (active) return active.watch;
  const root = path.resolve(options.root ?? pluginManager.getUserPluginsRoot());
  const dropRoot = addOwnedWatchRoot(root);
  const realRoot = realDir(root);
  let watch: InputWatch;
  try {
    watch = watchInput(
      root,
      {
        surface: PLUGIN_SURFACE,
        kind: "directory",
        depth: 2,
        settleMs: options.settleMs ?? PLUGIN_SETTLE_MS,
        ignored: (abs) => isIgnoredPluginPath(realRoot, abs) || isIgnoredPluginPath(root, abs),
        settled: pluginDirCompleteness(
          options.pollMs ?? PLUGIN_COMPLETE_POLL_MS,
          options.completeTimeoutMs ?? PLUGIN_COMPLETE_TIMEOUT_MS,
        ),
        hold: appWritesEnded,
        ...(options.rearmPollMs === undefined ? {} : { rearmPollMs: options.rearmPollMs }),
      },
      handlePluginDirChange,
    );
  } catch (err) {
    dropRoot();
    throw err;
  }
  active = { watch, root, dropRoot };
  await watch.ready;
  return watch;
}

/** Dispose the watch of the user plugins root. */
export async function stopPluginDirWatch(): Promise<void> {
  const current = active;
  active = null;
  registeredDirs.clear();
  if (!current) return;
  await current.watch.dispose();
  current.dropRoot();
}
