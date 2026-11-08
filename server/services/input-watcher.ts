/**
 * InputWatcher: the one server module that owns the cross-cutting hot-reload
 * rules (HR-NFR-001, HR-NFR-002, HR-NFR-003, HR-NFR-006).
 *
 * A surface arms a watch with one `watchInput` call and gets, for free:
 *
 * - the allowlist: only a path inside the Roubo state dir or a registered
 *   project root can be watched, symlinks resolved, else `WatchRootError`;
 * - a trailing settle window for each input (`settleMs`);
 * - an optional completeness gate (`settled`) before a directory is hashed;
 * - hash dedupe against the last applied content;
 * - self-write suppression through the tokens that `atomicWrite` leaves;
 * - one `[input-watcher] ...` key=value log line for every outcome, which never
 *   carries file content;
 * - re-arming when the watched directory disappears and returns.
 *
 * A file is watched through its parent directory at depth 0 with a basename
 * allowlist, because a single-file watch loses saves that replace the file.
 * `awaitWriteFinish` is not used: the settle window does that job without the
 * extra two seconds it adds.
 *
 * The handler receives `{ path, hash }` only. It reads its input itself and
 * resolves to `'applied' | 'rejected' | 'refused'` (or `{ outcome, action }`
 * on a surface that reports an action). A thrown error counts as `rejected`.
 */
import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { getRouboDir, loadProjects } from "./state.js";
import { consumeSelfWrite, hashContent } from "./self-write-tokens.js";

export type ApplyOutcome = "applied" | "rejected" | "deduped" | "self-write" | "refused";

export type HandlerOutcome = "applied" | "rejected" | "refused";

/** One structured log line for one handler outcome. Never carries file content. */
export interface ApplyLogLine {
  surface: string;
  path: string;
  outcome: ApplyOutcome;
  /** The first eight hex characters of the content hash, or `none` when absent. */
  hash8: string;
  durationMs: number;
  /** The plugin surface's action, such as `register` or `unregister`. */
  action?: string;
}

/** What a handler is told about a change: the input path and its content hash. */
export interface InputChange {
  path: string;
  /** The sha256 hex digest of the input, or null when the input is absent. */
  hash: string | null;
}

export type HandlerResult = HandlerOutcome | { outcome: HandlerOutcome; action?: string };

export type InputHandler = (change: InputChange) => Promise<HandlerResult>;

export interface WatchInputOptions {
  /** The surface name written on every log line, such as `settings`. */
  surface: string;
  /** The trailing settle window for each input, in milliseconds. */
  settleMs: number;
  /** How deep below the watched directory to watch. Ignored for a file watch. */
  depth?: number;
  /** A predicate on an absolute path; true drops the path. */
  ignored?: (absPath: string) => boolean;
  /** Basenames of the entries to watch directly below the directory. */
  allow?: readonly string[];
  /**
   * The completeness gate of a directory input, run after the settle window and
   * before the hash. `false` means the input is not complete, and the run ends
   * `rejected`. `true` hashes every file below the directory. A list of paths,
   * absolute or relative to the input, hashes those files only.
   */
  settled?: (absPath: string) => Promise<boolean | readonly string[]>;
  /**
   * The hash of each input as the surface loaded it. After `ready`, each input
   * is hashed once and compared with it, and a difference runs the handler.
   * Without it, the hash after `ready` is taken as the loaded value.
   */
  loadedHash?: (absPath: string) => string | null | undefined;
  /** How often to check that the watched directory still exists and is still watched. Default 1000 ms. */
  rearmPollMs?: number;
}

export interface Disposable {
  /** Resolves once the watch is armed and each input has been hashed once. */
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

/** Thrown by `watchInput` for a path outside every allowed root. */
export class WatchRootError extends Error {
  constructor(target: string) {
    super(`watchInput: ${target} is outside the Roubo state dir and every registered project root`);
    this.name = "WatchRootError";
  }
}

const LOG_PREFIX = "[input-watcher]";
const DEFAULT_REARM_POLL_MS = 1_000;

/** Serialise one ApplyLogLine as key=value pairs on one line. Not JSON. */
export function formatApplyLogLine(line: ApplyLogLine): string {
  const base =
    `${LOG_PREFIX} surface=${line.surface} path=${line.path} outcome=${line.outcome} ` +
    `hash8=${line.hash8} durationMs=${line.durationMs}`;
  return line.action === undefined ? base : `${base} action=${line.action}`;
}

/** Write one ApplyLogLine. */
export function logApply(line: ApplyLogLine): void {
  console.info(formatApplyLogLine(line));
}

function hash8Of(hash: string | null): string {
  return hash === null ? "none" : hash.slice(0, 8);
}

function isWithin(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The real path of `p`: its deepest existing ancestor resolved through every
 * symlink, with the missing segments appended.
 */
function realpathLoose(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The roots a watch may live under: the Roubo state dir and each registered
 * project root. They come from the state-dir resolver, so a dev run and a
 * packaged run differ only by directory.
 */
export function getWatchRoots(): string[] {
  const roots = [getRouboDir()];
  try {
    for (const project of loadProjects().projects) {
      if (project.repoPath) roots.push(project.repoPath);
    }
  } catch {
    // An unreadable projects file leaves only the state dir allowed.
  }
  return roots.map(realpathLoose);
}

/** Resolve `target` through symlinks and check it against the allowed roots. */
export function resolveAllowedPath(target: string): string {
  const resolved = realpathLoose(target);
  if (!getWatchRoots().some((root) => isWithin(resolved, root))) {
    throw new WatchRootError(target);
  }
  return resolved;
}

function walkFiles(dir: string, prefix = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function hashUnit(unit: string, files: readonly string[] | null): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(unit);
  } catch {
    return null;
  }
  try {
    if (!stat.isDirectory()) return hashContent(fs.readFileSync(unit));
  } catch {
    return null;
  }
  const rels = (files ?? walkFiles(unit))
    .map((f) => path.relative(unit, path.resolve(unit, f)))
    .filter((rel) => isWithin(path.join(unit, rel), unit));
  const lines = rels.map((rel) => {
    let digest = "missing";
    try {
      digest = hashContent(fs.readFileSync(path.join(unit, rel)));
    } catch {
      // A missing listed file still changes the hash.
    }
    return `${rel}\0${digest}\n`;
  });
  return hashContent(lines.join(""));
}

type RunMode = "event" | "quiet" | "seed";

/**
 * Watch one input. `target` is an existing file, or a directory whose entries
 * (filtered by `allow` and `ignored`) are the inputs. Throws `WatchRootError`
 * before any watcher is created when the target is outside every allowed root.
 */
export function watchInput(
  target: string,
  options: WatchInputOptions,
  handler: InputHandler,
): Disposable {
  const resolved = resolveAllowedPath(target);

  let dir = resolved;
  let allow = options.allow ? new Set(options.allow) : null;
  let depth = options.depth;
  try {
    if (fs.statSync(resolved).isFile()) {
      dir = path.dirname(resolved);
      allow = new Set([path.basename(resolved)]);
    }
  } catch {
    // A missing target is watched as a directory, armed when it appears.
  }
  if (allow) depth = 0;

  const { surface, settleMs } = options;
  const lastApplied = new Map<string, string | null>();
  const timers = new Map<string, NodeJS.Timeout>();
  const chains = new Map<string, Promise<void>>();
  let watcher: FSWatcher | null = null;
  let armedIno: number | null = null;
  let watchLost = false;
  let watcherReady = false;
  let everArmed = false;
  let disposed = false;
  let checking = false;
  let poll: NodeJS.Timeout | null = null;

  function unitOf(absPath: string): string | null {
    const rel = path.relative(dir, absPath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return null;
    }
    const first = rel.split(path.sep)[0];
    if (allow && !allow.has(first)) return null;
    const unit = path.join(dir, first);
    if (options.ignored?.(unit)) return null;
    return unit;
  }

  function isIgnored(p: string): boolean {
    const abs = path.resolve(p);
    if (abs === dir || !isWithin(abs, dir)) return false;
    if (unitOf(abs) === null) return true;
    return options.ignored?.(abs) ?? false;
  }

  function listUnits(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.map((name) => unitOf(path.join(dir, name))).filter((u): u is string => u !== null);
  }

  function enqueue(unit: string, mode: RunMode): Promise<void> {
    const next = (chains.get(unit) ?? Promise.resolve())
      .then(() => run(unit, mode))
      .catch(() => {
        // run() handles its own failures; a chain never rejects.
      });
    chains.set(unit, next);
    return next;
  }

  function schedule(unit: string): void {
    if (disposed) return;
    const pending = timers.get(unit);
    if (pending) clearTimeout(pending);
    timers.set(
      unit,
      setTimeout(() => {
        timers.delete(unit);
        void enqueue(unit, "event");
      }, settleMs),
    );
  }

  async function run(unit: string, mode: RunMode): Promise<void> {
    if (disposed) return;
    // The watched directory itself is gone: the lifecycle check re-arms it and
    // rescans, so a run now would only churn the surface.
    if (!fs.existsSync(dir)) return;
    const start = performance.now();
    const emit = (outcome: ApplyOutcome, hash: string | null, action?: string) => {
      logApply({
        surface,
        path: unit,
        outcome,
        hash8: hash8Of(hash),
        durationMs: Math.round(performance.now() - start),
        ...(action === undefined ? {} : { action }),
      });
    };

    let files: readonly string[] | null = null;
    let isDir = false;
    try {
      isDir = fs.statSync(unit).isDirectory();
    } catch {
      // Absent: hashed as null below.
    }
    if (isDir && options.settled) {
      let complete: boolean | readonly string[];
      try {
        complete = await options.settled(unit);
      } catch {
        complete = false;
      }
      if (disposed) return;
      if (complete === false) {
        if (mode !== "seed") emit("rejected", null);
        return;
      }
      if (Array.isArray(complete)) files = complete;
    }

    const hash = hashUnit(unit, files);
    if (mode === "seed") {
      lastApplied.set(unit, hash);
      return;
    }
    if (hash !== null && consumeSelfWrite(unit, hash)) {
      lastApplied.set(unit, hash);
      emit("self-write", hash);
      return;
    }
    const unchanged = lastApplied.has(unit) ? lastApplied.get(unit) === hash : hash === null;
    if (unchanged) {
      if (mode === "event") emit("deduped", hash);
      return;
    }

    let outcome: HandlerOutcome = "rejected";
    let action: string | undefined;
    try {
      const result = await handler({ path: unit, hash });
      const value = typeof result === "string" ? result : result?.outcome;
      if (value === "applied" || value === "rejected" || value === "refused") outcome = value;
      if (typeof result === "object" && result !== null) action = result.action;
    } catch {
      // The error message can quote the input, so it is not logged.
      outcome = "rejected";
    }
    if (disposed) return;
    if (outcome === "applied") lastApplied.set(unit, hash);
    emit(outcome, hash, action);
  }

  async function scan(initial: boolean): Promise<void> {
    const targets = new Set(listUnits());
    if (!initial) for (const known of lastApplied.keys()) targets.add(known);
    const runs: Promise<void>[] = [];
    for (const unit of targets) {
      if (initial && options.loadedHash) {
        const loaded = options.loadedHash(unit);
        if (loaded !== undefined) lastApplied.set(unit, loaded);
        runs.push(enqueue(unit, "quiet"));
      } else {
        runs.push(enqueue(unit, initial ? "seed" : "quiet"));
      }
    }
    await Promise.all(runs);
  }

  function arm(): Promise<void> | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return null;
    armedIno = stat.ino;
    const w = watch(dir, {
      ignoreInitial: true,
      persistent: true,
      ignored: isIgnored,
      ...(depth === undefined ? {} : { depth }),
    });
    watchLost = false;
    watcherReady = false;
    const ready = new Promise<void>((resolve) => {
      w.once("ready", () => {
        if (watcher === w) watcherReady = true;
        resolve();
      });
    });
    w.on("all", (event, p) => {
      const abs = path.resolve(p);
      // A rename of the watched directory makes chokidar drop its own watch of
      // it with an unlinkDir for the root, even when the directory is back
      // (same inode) before the next lifecycle poll.
      if (event === "unlinkDir" && abs === dir && watcher === w) watchLost = true;
      const unit = unitOf(abs);
      if (unit) schedule(unit);
    });
    w.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      console.warn(`${LOG_PREFIX} watch error surface=${surface} path=${dir} code=${code}`);
    });
    watcher = w;
    return ready;
  }

  async function disarm(): Promise<void> {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const w = watcher;
    watcher = null;
    armedIno = null;
    watchLost = false;
    watcherReady = false;
    if (w) await w.close();
  }

  /**
   * Whether chokidar has dropped its watch of the directory: it said so with an
   * unlinkDir for the root, or, once ready, its watched list no longer holds
   * the root. Only a fresh watcher clears this, so one disappearance re-arms
   * once.
   */
  function isWatchLost(w: FSWatcher): boolean {
    if (watchLost) return true;
    return watcherReady && !Object.hasOwn(w.getWatched(), dir);
  }

  async function check(): Promise<void> {
    if (disposed || checking) return;
    checking = true;
    try {
      let present: fs.Stats | null = null;
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory()) present = stat;
      } catch {
        // Gone.
      }
      if (watcher && (!present || present.ino !== armedIno || isWatchLost(watcher))) {
        await disarm();
      }
      if (!watcher && present && !disposed) {
        const ready = arm();
        if (!ready) return;
        await ready;
        if (disposed) return;
        // A lifecycle line, not an ApplyLogLine: it carries no outcome.
        if (everArmed) console.info(`${LOG_PREFIX} re-armed path=${dir}`);
        everArmed = true;
        await scan(false);
      }
    } finally {
      checking = false;
    }
  }

  const ready = (async () => {
    const armed = arm();
    if (armed) {
      await armed;
      everArmed = true;
      await scan(true);
    }
    if (!disposed) {
      poll = setInterval(() => void check(), options.rearmPollMs ?? DEFAULT_REARM_POLL_MS);
      poll.unref();
    }
  })();

  return {
    ready,
    async dispose() {
      disposed = true;
      if (poll) clearInterval(poll);
      await disarm();
    },
  };
}
