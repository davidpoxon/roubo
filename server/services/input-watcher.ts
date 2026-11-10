/**
 * InputWatcher: the one server module that owns the cross-cutting hot-reload
 * rules (HR-NFR-001, HR-NFR-002, HR-NFR-003, HR-NFR-006).
 *
 * A surface arms a watch with one `watchInput` call and gets, for free:
 *
 * - the allowlist: only a path inside the Roubo state dir, a directory Roubo
 *   owns (`addOwnedWatchRoot`, such as the user plugins root) or a registered
 *   project root can be watched, symlinks resolved, else `WatchRootError`; the
 *   directory is checked again before every arm, symlinked entries are not
 *   followed, and an input that resolves out of every root is refused unread;
 * - a trailing settle window for each input (`settleMs`);
 * - an optional completeness gate (`settled`) before a directory is hashed;
 * - an optional hold (`hold`) that lets the surface's own write of an input end
 *   first, so the run that write causes is deduped;
 * - hash dedupe against the last applied content;
 * - self-write suppression through the tokens that `atomicWrite` leaves;
 * - one `[input-watcher] ...` key=value log line for every outcome, which never
 *   carries file content;
 * - one `input-changed` event on the notification stream for every applied,
 *   rejected or refused outcome of a known surface (HR-FR-015); deduped and
 *   self-write outcomes are logged only;
 * - re-arming when the watched directory disappears and returns.
 *
 * A file is watched through its parent directory at depth 0 with a basename
 * allowlist, because a single-file watch loses saves that replace the file.
 * `awaitWriteFinish` is not used: the settle window does that job without the
 * extra two seconds it adds.
 *
 * The handler receives `{ path, hash }` only. It reads its input itself and
 * resolves to `'applied' | 'rejected' | 'refused'` (or `{ outcome, action, event }`
 * on a surface that reports an action or the target ids, summary and first
 * error of its event). A thrown error counts as `rejected`. The watch's
 * `target` ids go on every event, and a rejected or refused event with no
 * error of the handler's gets the input path and a generic first error.
 */
import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { getRouboDir, loadProjects } from "./state.js";
import {
  consumeSelfWrites,
  forgetInputContent,
  hashContent,
  noteInputContent,
} from "./self-write-tokens.js";
import { broadcastInputChanged } from "./sse.js";
import { INPUT_SURFACES, type InputSurface } from "@roubo/shared";

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

/**
 * What a handler adds to the `input-changed` event of its outcome: the target
 * ids, a one-line summary and, on a rejection, the input path with the first
 * validation error. Never file content.
 */
export interface InputEventDetail {
  projectId?: string;
  pluginId?: string;
  benchIds?: number[];
  /** One line that starts with the surface's thing. A default is written when absent. */
  summary?: string;
  error?: { path: string; first: string };
}

/**
 * What a handler returns. `"ignored"` says the input is not one the surface
 * acts on, such as a directory under the plugins root that holds no plugin:
 * its hash is recorded so the same content does not run the handler again,
 * and nothing is logged or sent.
 */
export type HandlerResult =
  | HandlerOutcome
  | "ignored"
  | { outcome: HandlerOutcome; action?: string; event?: InputEventDetail };

export type InputHandler = (change: InputChange) => Promise<HandlerResult>;

export interface WatchInputOptions {
  /** The surface name written on every log line, such as `settings`. */
  surface: string;
  /**
   * The surface of one input, for a watch whose inputs feed different
   * surfaces, such as the state dir. Its log lines and events carry it. Falls
   * back to `surface` when absent or when it gives nothing.
   */
  surfaceOf?: (absPath: string) => string | undefined;
  /** The trailing settle window for each input, in milliseconds. */
  settleMs: number;
  /**
   * Whether the target is one file or a directory of inputs. Without it, an
   * existing target is taken as what it is, and a missing one as a directory.
   * Pass `file` to watch a file that may not exist yet: it is watched through
   * its parent directory and handled when it appears.
   */
  kind?: "file" | "directory";
  /** How deep below the watched directory to watch. Forced to 0 for a file watch. */
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
  /**
   * The target ids of every `input-changed` event of this watch. A handler's
   * own `projectId` or `pluginId` wins over them, but an outcome the watcher
   * reaches itself (a refusal, an incomplete directory, a thrown handler)
   * still names its target, so a later applied event of the same target can
   * clear its notice.
   */
  target?: { projectId?: string; pluginId?: string };
  /**
   * Awaited at the start of each run, before the input is read. A surface that
   * also writes its inputs itself, such as the plugin installer, holds the run
   * here until its own write has ended and been marked applied, so the run sees
   * the finished input and is deduped rather than applied a second time.
   */
  hold?: (absPath: string) => Promise<void>;
  /**
   * Track the content of each input, so an app write that lands on a hand edit
   * the watch has not run for yet is told apart from a plain self-write: the
   * handler still runs for the change (see `noteInputContent` in
   * self-write-tokens.ts). For inputs that are single files the app writes
   * read-modify-write, such as the state files.
   */
  trackHandEdits?: boolean;
  /**
   * Called after a run that takes the change as the app's own write and runs no
   * handler, when the watch records the input as applied (an app write the
   * surface rejected stays rejected and does not call it). A surface that keeps
   * open notices, such as the state dir's rejected files, clears them here: a
   * valid app write fixes the file as a hand edit would.
   */
  onSelfWrite?: (change: InputChange) => void;
}

export interface Disposable {
  /** Resolves once the watch is armed and each input has been hashed once. */
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

/** The handle of one `watchInput` watch. */
export interface InputWatch extends Disposable {
  /**
   * Record that the surface rejected the content `hash` of the input at
   * `absPath` outside a watched run, such as an app write it could not apply.
   * The watch then treats that content as rejected rather than applied: the
   * matching self-write keeps it so, and the next save of the input runs the
   * handler even when it holds the same content. A path that is not an input
   * of this watch is ignored.
   */
  markRejected(absPath: string, hash: string | null): void;
  /**
   * Record that the surface applied the content `hash` of the input at
   * `absPath` outside a watched run, such as a manual reload or an app write
   * it applied. Any rejected record of the input is dropped, so the next save
   * of the same content is deduped and the matching self-write leaves it
   * applied. A path that is not an input of this watch is ignored.
   */
  markApplied(absPath: string, hash: string | null): void;
}

/**
 * What the watch remembers of an input whose last handler run did not apply:
 * the hash of that content. As an object it never equals a hash or null, so
 * the next save runs the handler whatever it holds, a delete included, while
 * a rescan can still tell that the content is the one already rejected.
 */
interface RejectedContent {
  readonly rejected: string | null;
}

/** Thrown by `watchInput` for a path outside every allowed root. */
export class WatchRootError extends Error {
  constructor(target: string) {
    super(
      `watchInput: ${target} is outside the Roubo state dir, every directory Roubo owns and every registered project root`,
    );
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

// The ROUBO_E2E=1-only mirror of every apply line. A Playwright spec cannot read
// the server's stdout, so GET /test/__input-watcher-log serves this buffer and
// /test/__reset empties it. Bounded so a long e2e run cannot grow it without end.
const E2E_APPLY_LOG_TAP_MAX = 500;
const e2eApplyLogTap: string[] = [];

/** Write one ApplyLogLine. */
export function logApply(line: ApplyLogLine): void {
  const text = formatApplyLogLine(line);
  console.info(text);
  if (process.env.ROUBO_E2E === "1") {
    e2eApplyLogTap.push(text);
    if (e2eApplyLogTap.length > E2E_APPLY_LOG_TAP_MAX) {
      e2eApplyLogTap.splice(0, e2eApplyLogTap.length - E2E_APPLY_LOG_TAP_MAX);
    }
  }
}

const SURFACE_THINGS: Record<InputSurface, string> = {
  "project-config": "Project",
  plugin: "Plugin",
  settings: "Settings",
  bench: "Bench",
  github: "GitHub",
  environment: "Environment",
};

export function isInputSurface(surface: string): surface is InputSurface {
  return (INPUT_SURFACES as readonly string[]).includes(surface);
}

/** The word a notice about `surface` starts with; an unknown surface is its own id. */
export function surfaceThing(surface: string): string {
  return isInputSurface(surface) ? SURFACE_THINGS[surface] : surface;
}

/** The one-line summary of an outcome whose handler gave none. */
export function defaultInputSummary(surface: string, outcome: HandlerOutcome): string {
  return `${surfaceThing(surface)} change ${outcome}`;
}

/** The first error of a rejected or refused outcome whose handler gave none. */
export const DEFAULT_OUTCOME_REASONS = {
  /** The handler threw. Its message can quote the input, so it is not sent. */
  threw: "the change could not be read or validated",
  /** The completeness gate said the directory input is not complete. */
  incomplete: "the input is not complete",
  /** The input resolves out of every allowed root, so it was not read. */
  outside: "the input resolves outside every allowed root",
  /** The handler said rejected with no error of its own. */
  rejected: "the change was rejected",
  /** The handler said refused with no error of its own. */
  refused: "the change was refused",
} as const;

/**
 * Send the `input-changed` event of one handler outcome (HR-FR-015). Only the
 * six known surfaces are sent, since a client maps nothing else; deduped and
 * self-write outcomes never reach here. The handler's detail wins over the
 * watch's static target ids, and a rejected or refused outcome with no error
 * gets `fallbackError`, so its notice always names a path and a first error.
 */
function sendInputChanged(
  surface: string,
  outcome: HandlerOutcome,
  detail: InputEventDetail | undefined,
  target: WatchInputOptions["target"],
  fallbackError: { path: string; first: string },
): void {
  if (!isInputSurface(surface)) return;
  const projectId = detail?.projectId ?? target?.projectId;
  const pluginId = detail?.pluginId ?? target?.pluginId;
  const error = detail?.error ?? (outcome === "applied" ? undefined : fallbackError);
  broadcastInputChanged({
    surface,
    outcome,
    ...(projectId === undefined ? {} : { projectId }),
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(detail?.benchIds === undefined ? {} : { benchIds: [...detail.benchIds] }),
    summary: detail?.summary ?? defaultInputSummary(surface, outcome),
    ...(error === undefined ? {} : { error: { path: error.path, first: error.first } }),
  });
}

/**
 * The path of `unit` relative to the deepest allowed root that holds it, so an
 * event names `roubo.yaml` rather than an absolute path. A unit under no root
 * is named by its basename.
 */
function pathFromWatchRoot(unit: string, roots: readonly string[]): string {
  let best: string | null = null;
  for (const root of roots) {
    if (isWithin(unit, root) && (best === null || root.length > best.length)) best = root;
  }
  const rel = best === null ? "" : path.relative(best, unit);
  return rel === "" ? path.basename(unit) : rel;
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

// Directories that Roubo owns outside its state dir, such as the user plugins
// root, which stays ~/.roubo/plugins under a dev run whose state dir is not
// ~/.roubo. Only server code adds one; no input of a watch can.
const ownedRoots = new Set<string>();

/**
 * Allow watches under `dir`, a directory that Roubo itself owns outside the
 * state dir. Returns a function that takes the allowance back.
 */
export function addOwnedWatchRoot(dir: string): () => void {
  const abs = path.resolve(dir);
  ownedRoots.add(abs);
  return () => {
    ownedRoots.delete(abs);
  };
}

/**
 * The roots a watch may live under: the Roubo state dir, each directory added
 * through `addOwnedWatchRoot`, and each registered project root. They come
 * from the state-dir resolver, so a dev run and a packaged run differ only by
 * directory.
 */
export function getWatchRoots(): string[] {
  const roots = [getRouboDir(), ...ownedRoots];
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

/**
 * Whether the real path of an existing `p` is inside an allowed root. A missing
 * path counts as inside: it holds nothing to read.
 */
function realpathAllowed(p: string, roots: readonly string[]): boolean {
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    return true;
  }
  return roots.some((root) => isWithin(real, root));
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

function hashUnit(
  unit: string,
  files: readonly string[] | null,
  roots: readonly string[],
): string | null {
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
    const abs = path.join(unit, rel);
    // A listed entry that is a symlink out of every root is never read.
    if (!realpathAllowed(abs, roots)) return `${rel}\0outside\n`;
    try {
      digest = hashContent(fs.readFileSync(abs));
    } catch {
      // A missing listed file still changes the hash.
    }
    return `${rel}\0${digest}\n`;
  });
  return hashContent(lines.join(""));
}

/**
 * The hash a watch gives the directory input `unit` when its completeness gate
 * lists `files` (paths relative to the input, or absolute), or every file below
 * it when `files` is null. Null when the input is absent. A surface that writes
 * an input itself passes it to `markApplied`, so the watch dedupes that write.
 */
export function hashInputFiles(unit: string, files: readonly string[] | null): string | null {
  return hashUnit(unit, files, getWatchRoots());
}

type RunMode = "event" | "quiet" | "seed";

/**
 * Watch one input. `target` is a file, or a directory whose entries (filtered
 * by `allow` and `ignored`) are the inputs; `options.kind` says which when the
 * target does not exist yet. Throws `WatchRootError` before any watcher is
 * created when the target is outside every allowed root.
 */
export function watchInput(
  target: string,
  options: WatchInputOptions,
  handler: InputHandler,
): InputWatch {
  const resolved = resolveAllowedPath(target);

  let isFile = options.kind === "file";
  if (options.kind === undefined) {
    try {
      isFile = fs.statSync(resolved).isFile();
    } catch {
      // A missing target without a kind is a directory, armed when it appears.
    }
  }
  let dir = resolved;
  let allow = options.allow ? new Set(options.allow) : null;
  let depth = options.depth;
  if (isFile) {
    // A file, present or not, is watched through its parent directory, so a
    // missing file is handled when it appears.
    dir = path.dirname(resolved);
    allow = new Set([path.basename(resolved)]);
    depth = 0;
  }

  const { settleMs } = options;
  // The hash of each input's last applied content, or what was rejected when
  // its last handler run did not apply.
  const lastApplied = new Map<string, string | null | RejectedContent>();
  const timers = new Map<string, NodeJS.Timeout>();
  const chains = new Map<string, Promise<void>>();
  let watcher: FSWatcher | null = null;
  let armedIno: number | null = null;
  let watchLost = false;
  let watcherReady = false;
  let everArmed = false;
  let disposed = false;
  let checking = false;
  let armRefused = false;
  let poll: NodeJS.Timeout | null = null;
  // Settles the ready promise of the current arm. Closing a watcher before
  // chokidar emits `ready` means `ready` never comes, so disarm settles it.
  let settleArm: (() => void) | null = null;

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
    const surface = options.surfaceOf?.(unit) ?? options.surface;
    if (options.hold) {
      try {
        await options.hold(unit);
      } catch {
        // A failed hold only ends the wait; the run reads the input as it is.
      }
      if (disposed) return;
    }
    // The watched directory itself is gone: the lifecycle check re-arms it and
    // rescans, so a run now would only churn the surface.
    if (!fs.existsSync(dir)) return;
    const start = performance.now();
    const roots = getWatchRoots();
    const emit = (
      outcome: ApplyOutcome,
      hash: string | null,
      action?: string,
      detail?: InputEventDetail,
      reason?: string,
    ) => {
      logApply({
        surface,
        path: unit,
        outcome,
        hash8: hash8Of(hash),
        durationMs: Math.round(performance.now() - start),
        ...(action === undefined ? {} : { action }),
      });
      // Deduped and self-write outcomes are logged only, never sent.
      if (outcome === "applied" || outcome === "rejected" || outcome === "refused") {
        sendInputChanged(surface, outcome, detail, options.target, {
          path: pathFromWatchRoot(unit, roots),
          first: reason ?? DEFAULT_OUTCOME_REASONS[outcome === "refused" ? "refused" : "rejected"],
        });
      }
    };

    // The input can have become a symlink out of every root since the watch
    // was armed: it is refused unread, and the handler does not run.
    if (!realpathAllowed(unit, roots)) {
      if (mode !== "seed") {
        emit("refused", null, undefined, undefined, DEFAULT_OUTCOME_REASONS.outside);
      }
      return;
    }

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
        if (mode !== "seed") {
          emit("rejected", null, undefined, undefined, DEFAULT_OUTCOME_REASONS.incomplete);
        }
        return;
      }
      if (Array.isArray(complete)) files = complete;
    }

    const hash = hashUnit(unit, files, roots);
    // The content this run reads is taken in now, before the handler runs, so
    // an app write the handler makes, such as a write-back, is not taken for
    // one that lands on a hand edit.
    if (options.trackHandEdits) noteInputContent(unit, hash);
    if (mode === "seed") {
      lastApplied.set(unit, hash);
      return;
    }
    const last = lastApplied.get(unit);
    const lastRejected = typeof last === "object" && last !== null ? last : null;
    // An absent input matches no token, and still clears the hand edits the
    // live tokens carry, since the handler runs for what the input now holds.
    const selfWrites = consumeSelfWrites(unit, hash);
    // One line for each app write the merged change accounts for.
    for (const written of selfWrites.hashes) emit("self-write", written);
    if (selfWrites.hashes.length > 0 && !selfWrites.carriesHandEdit) {
      // An app write the surface rejected stays rejected (see markRejected).
      // One it applied was recorded through markApplied, which dropped any
      // earlier rejected record of the same content, so it stays applied.
      if (lastRejected?.rejected !== hash) {
        lastApplied.set(unit, hash);
        options.onSelfWrite?.({ path: unit, hash });
      }
      return;
    }
    // An app write that landed on a hand edit the watch had not run for: the
    // file holds that edit, so the handler runs for it as for any hand edit.
    // A rescan finds the content that was last rejected unchanged: the handler
    // already said no to it, so it does not run again for it.
    if (mode === "quiet" && lastRejected !== null && lastRejected.rejected === hash) return;
    const unchanged = lastApplied.has(unit) ? last === hash : hash === null;
    if (unchanged) {
      if (mode === "event") emit("deduped", hash);
      return;
    }

    let outcome: HandlerOutcome = "rejected";
    let action: string | undefined;
    let detail: InputEventDetail | undefined;
    let reason: string | undefined;
    try {
      const result = await handler({ path: unit, hash });
      if (result === "ignored") {
        lastApplied.set(unit, hash);
        return;
      }
      const value = typeof result === "string" ? result : result?.outcome;
      if (value === "applied" || value === "rejected" || value === "refused") outcome = value;
      if (typeof result === "object" && result !== null) {
        action = result.action;
        detail = result.event;
      }
    } catch {
      // The error message can quote the input, so it is neither logged nor
      // sent; the event carries a generic first error instead.
      outcome = "rejected";
      reason = DEFAULT_OUTCOME_REASONS.threw;
    }
    // The handler ran, so its outcome is recorded and logged even when the
    // watch was disposed while it was awaited.
    // After a rejection the applied hash is replaced by a record of the
    // rejected content, which never equals a hash or null: a save that puts
    // the last applied content back, or deletes the input, runs the handler,
    // and its applied event clears the open error notice (HR-TC-005) instead
    // of being deduped.
    if (outcome === "applied") lastApplied.set(unit, hash);
    else lastApplied.set(unit, { rejected: hash });
    emit(outcome, hash, action, detail, reason);
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
    // The directory was checked against the roots when the watch was asked
    // for, but it can since have appeared or been replaced as a symlink out of
    // every root. Re-check it before every arm and refuse to watch it then.
    if (!realpathAllowed(dir, getWatchRoots())) {
      if (!armRefused) {
        // A lifecycle line, not an ApplyLogLine: it carries no outcome.
        console.warn(`${LOG_PREFIX} arm refused path=${dir} reason=outside-roots`);
        armRefused = true;
      }
      return null;
    }
    armRefused = false;
    armedIno = stat.ino;
    const w = watch(dir, {
      ignoreInitial: true,
      persistent: true,
      // An entry that is a symlink is watched as a link, never followed out.
      followSymlinks: false,
      ignored: isIgnored,
      ...(depth === undefined ? {} : { depth }),
    });
    watchLost = false;
    watcherReady = false;
    const ready = new Promise<void>((resolve) => {
      const settle = () => {
        if (settleArm === settle) settleArm = null;
        resolve();
      };
      settleArm = settle;
      w.once("ready", () => {
        if (watcher === w) watcherReady = true;
        settle();
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
      console.warn(`${LOG_PREFIX} watch error surface=${options.surface} path=${dir} code=${code}`);
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
    const settle = settleArm;
    settleArm = null;
    settle?.();
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
        // Gone: a later refusal to arm is logged again.
        armRefused = false;
      }
      if (watcher && (!present || present.ino !== armedIno || isWatchLost(watcher))) {
        await disarm();
      }
      if (!watcher && present && !disposed) {
        const ready = arm();
        if (!ready) return;
        await ready;
        if (disposed || !watcher) return;
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
      if (disposed) return;
      everArmed = true;
      await scan(true);
    }
    if (!disposed) {
      poll = setInterval(() => void check(), options.rearmPollMs ?? DEFAULT_REARM_POLL_MS);
      poll.unref();
    }
  })();

  /** The input unit of a caller's path, or null when it is not one of this watch. */
  function unitOfCallerPath(absPath: string): string | null {
    if (disposed) return null;
    // The watch keys its inputs by the real path of the watched directory,
    // so the caller's path is resolved the same way.
    const abs = path.join(realpathLoose(path.dirname(absPath)), path.basename(absPath));
    return unitOf(abs);
  }

  return {
    ready,
    markRejected(absPath, hash) {
      const unit = unitOfCallerPath(absPath);
      if (unit === null) return;
      lastApplied.set(unit, { rejected: hash });
    },
    markApplied(absPath, hash) {
      const unit = unitOfCallerPath(absPath);
      if (unit === null) return;
      lastApplied.set(unit, hash);
    },
    async dispose() {
      disposed = true;
      if (poll) clearInterval(poll);
      await disarm();
      if (options.trackHandEdits) for (const unit of lastApplied.keys()) forgetInputContent(unit);
    },
  };
}

// Test-only access to the e2e apply-log tap, for the env-gated /test routes.
export const __test = {
  getE2EApplyLogTap(): string[] {
    return e2eApplyLogTap.slice();
  },
  resetE2EApplyLogTap(): void {
    e2eApplyLogTap.length = 0;
  },
};
