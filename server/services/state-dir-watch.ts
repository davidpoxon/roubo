/**
 * The state-file surfaces of hot reload (HR-FR-012, HR-FR-013): one
 * InputWatcher watch of the Roubo state dir at depth 0, whose inputs are the
 * state files the app reads while it runs. A change made outside the app is
 * applied live; the app's own writes go through `atomicWrite`, so the watch
 * takes each of them as a self-write and runs no handler (HR-NFR-002). The
 * app writes these files read-modify-write, so the watch tracks their content:
 * an app write that lands on a hand edit the watch has not run for yet keeps
 * the edit out of what the app records as known, and the watch still runs its
 * handler for the edit.
 *
 * - projects.json: the settings of each registered project.
 * - state.json: the hand-editable fields of each bench that is not live. An
 *   edit of a live bench is refused with a notice that names it, and the bench
 *   keeps what it has. A refused edit, an edit of a field that is not
 *   hand-editable, a record added for no bench and a removed record are undone
 *   in the file by writing it back from memory, a self-write, so the next
 *   launch does not load them. The notice
 *   names each bench whose edit was not applied: a live one, one whose edited
 *   field is not hand-editable, a record of no bench and a removed record. An
 *   edit that changes no bench sends no notice.
 * - auth.json: a GitHub token put there is copied into the github-com
 *   plugin's github-token credential slot, and auth.json is left in place.
 * - plugins-consent.json: each consented plugin that is not running and that
 *   the user has not disabled starts, as a grant of consent in the app starts
 *   it, and the notice names the plugins that started.
 * - plugins-state.json: the enable-state cache is read again; a plugin the
 *   edit disables stops, and one it enables starts.
 * - settings.json: read again, and the notice names each setting the edit
 *   changed. A settings.json that does not parse, or whose top level is not an
 *   object, keeps the last good settings served (HR-TC-034).
 * - .env: loaded again into process.env, so each key the edit adds, changes or
 *   removes reaches every process the app starts from then on, and the notice
 *   counts the keys that changed (HR-FR-011).
 *
 * The state dir is watched as one directory with a basename allowlist rather
 * than file by file, since a single-file watch loses saves that replace the
 * file. The allowlist also drops the `.tmp` sibling that `atomicWrite` renames
 * from. A file that does not parse is rejected with its parse error, and
 * nothing of it is applied. The next save of that file that parses, a hand
 * edit or an app write that leaves it valid, sends an applied event for the
 * target of each such rejected notice of the file, so the notice clears once
 * the file is fixed. A notice about a bench record the edit could not apply
 * is not cleared that way: the app's write-back that undoes the record is not
 * a fix of it.
 */
import fs from "node:fs";
import path from "node:path";
import {
  PluginConsentStateSchema,
  PluginEnableStateSchema,
  type InputSurface,
  type PersistedProjects,
  type PersistedState,
} from "@roubo/shared";
import * as benchManager from "./bench-manager.js";
import type { BenchStateEditRef } from "./bench-manager.js";
import * as credentialStore from "./credential-store.js";
import { loadEnvFile, loadEnvFileReport } from "./env.js";
import { loadConsentState } from "./plugin-consent-state.js";
import * as pluginManager from "./plugin-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as state from "./state.js";
import { broadcastInputChanged } from "./sse.js";
import { changedSettingNames, settingsAppliedNotice } from "./settings-changes.js";
import { forgetInputContent, noteInputContent } from "./self-write-tokens.js";
import {
  watchInput,
  type HandlerResult,
  type InputChange,
  type InputEventDetail,
  type InputWatch,
} from "./input-watcher.js";

/** The settle window of one state file. */
export const STATE_DIR_SETTLE_MS = 150;

/** The surface named on a watch line that is about no one state file. */
export const STATE_DIR_SURFACE = "state";

/** The state files the watch applies, by basename, with the surface each one feeds. */
export const STATE_FILE_SURFACES = {
  "projects.json": "project-config",
  "state.json": "bench",
  "auth.json": "github",
  "plugins-consent.json": "plugin",
  "plugins-state.json": "plugin",
  "settings.json": "settings",
  ".env": "environment",
} as const satisfies Record<string, InputSurface>;

export type StateFile = keyof typeof STATE_FILE_SURFACES;

export const STATE_FILES = Object.keys(STATE_FILE_SURFACES) as StateFile[];

const MISSING = "the file is missing";
const NOT_AN_OBJECT = "the top level must be an object";

// The plugin and the credential slot the boot migration moves an auth.json
// token into.
const GITHUB_PLUGIN_ID = "github-com";
const GITHUB_TOKEN_SLOT = "github-token";

// ── Reading a state file ──

/**
 * The parse error of `raw` as a sentence clause, or null when it parses. Only
 * the place of the error is kept: a JSON.parse message can quote the input,
 * and a notice never carries file content.
 */
export function jsonParseError(raw: string): string | null {
  try {
    JSON.parse(raw);
    return null;
  } catch (err) {
    const message = (err as Error).message;
    const at = /line (\d+) column (\d+)/.exec(message);
    if (at) return `invalid JSON at line ${at[1]} column ${at[2]}`;
    if (/unexpected end/i.test(message)) return "invalid JSON: unexpected end of input";
    const position = /position (\d+)/.exec(message);
    if (position) return `invalid JSON at position ${position[1]}`;
    return "invalid JSON";
  }
}

type ReadResult =
  | { kind: "missing" }
  | { kind: "invalid"; first: string }
  | { kind: "ok"; value: Record<string, unknown> };

function readStateFile(absPath: string): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", first: "the file could not be read" };
  }
  const parseError = jsonParseError(raw);
  if (parseError !== null) return { kind: "invalid", first: parseError };
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", first: NOT_AN_OBJECT };
  }
  return { kind: "ok", value: value as Record<string, unknown> };
}

/** The first schema issue as a clause: its path and its message. */
function firstIssue(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const issue = issues[0];
  if (!issue) return "the file does not match its schema";
  const where = issue.path.map(String).join(".");
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}

// ── Notice copy ──

/**
 * The rejections of a file as a whole: one that is missing, does not parse, or
 * fails its shape or schema. Only these stay open until a later save clears
 * them. A rejected bench record is not one: its handler has already undone it
 * in the file, by a write-back that is a self-write.
 */
const fileRejections = new WeakSet<object>();

/** "Bench state not applied. state.json: invalid JSON at line 1 column 2." */
function rejected(file: StateFile, lead: string, first: string, tail = ""): HandlerResult {
  const summary = `${lead} not applied. ${file}: ${first}.${tail === "" ? "" : ` ${tail}`}`;
  const result: HandlerResult = {
    outcome: "rejected",
    event: { summary, error: { path: file, first } },
  };
  fileRejections.add(result);
  return result;
}

function applied(event: InputEventDetail): HandlerResult {
  return { outcome: "applied", event };
}

/** "bench 3 on lantern", "benches 3, 4 on lantern", across projects joined by "and". */
export function benchPhrase(refs: readonly BenchStateEditRef[]): string {
  const byProject = new Map<string, number[]>();
  for (const ref of refs) {
    const ids = byProject.get(ref.projectId) ?? [];
    ids.push(ref.benchId);
    byProject.set(ref.projectId, ids);
  }
  return [...byProject]
    .map(([projectId, ids]) => {
      const sorted = [...ids].sort((a, b) => a - b);
      const noun = sorted.length === 1 ? "bench" : "benches";
      return `${noun} ${sorted.join(", ")} on ${projectId}`;
    })
    .join(" and ");
}

/** "Bench state applied: bench 3 on lantern." */
export function benchAppliedNotice(refs: readonly BenchStateEditRef[]): string {
  return refs.length === 0 ? "Bench state applied." : `Bench state applied: ${benchPhrase(refs)}.`;
}

/** "Bench state not applied: bench 2 on lantern is active. Stop it first." */
export function benchRefusedNotice(refs: readonly (BenchStateEditRef & { status: string })[]): {
  summary: string;
  first: string;
} {
  const statuses = new Set(refs.map((r) => r.status));
  const status = statuses.size === 1 ? [...statuses][0] : "live";
  const one = refs.length === 1;
  const first = `${benchPhrase(refs)} ${one ? "is" : "are"} ${status}`;
  return {
    summary: `Bench state not applied: ${first}. Stop ${one ? "it" : "them"} first.`,
    first,
  };
}

/** A clause and its sentence for one kind of bench record the edit could not apply. */
interface NotAppliedNotice {
  summary: string;
  first: string;
}

/**
 * A rejected bench record's sentence. It names the file and the clause as the
 * event's error does, `state.json: <first>`, so a client shows the sentence as
 * the whole notice and adds neither the clause again nor a last-good line.
 */
function notApplied(first: string): NotAppliedNotice {
  return { summary: `Bench state not applied. state.json: ${first}.`, first };
}

/** "Bench state not applied. state.json: workspacePath of bench 3 on lantern is not hand-editable." */
export function benchRevertedNotice(
  refs: readonly (BenchStateEditRef & { fields: readonly string[] })[],
): NotAppliedNotice {
  return notApplied(
    refs
      .map(
        (ref) =>
          `${ref.fields.join(", ")} of ${benchPhrase([ref])} ` +
          `${ref.fields.length === 1 ? "is" : "are"} not hand-editable`,
      )
      .join("; "),
  );
}

/** "Bench state not applied. state.json: bench 5 on lantern does not exist." */
export function benchUnmatchedNotice(refs: readonly BenchStateEditRef[]): NotAppliedNotice {
  return notApplied(`${benchPhrase(refs)} ${refs.length === 1 ? "does" : "do"} not exist`);
}

/** "Bench state not applied. state.json: bench 4 on lantern cannot be removed by hand." */
export function benchRemovedNotice(refs: readonly BenchStateEditRef[]): NotAppliedNotice {
  return notApplied(`${benchPhrase(refs)} cannot be removed by hand`);
}

/** "Plugin consent applied: database." */
export function consentAppliedNotice(pluginIds: readonly string[]): string {
  return pluginIds.length === 0
    ? "Plugin consent applied."
    : `Plugin consent applied: ${pluginIds.join(", ")}.`;
}

/** "Plugin database disabled." for each plugin the edit turned off, then each it turned on. */
export function enableStateNotice(reload: pluginManager.EnableStateReload): string {
  const lines = [
    ...reload.disabled.map((id) => `Plugin ${id} disabled.`),
    ...reload.enabled.map((id) => `Plugin ${id} enabled.`),
  ];
  return lines.length === 0 ? "Plugin state applied." : lines.join(" ");
}

/** The single target of a list, for the event's target id. */
function only<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

// ── The handlers ──

/** Whether `value` has what matches a bench record to its bench: a project id and a number. */
function isBenchRecord(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as { projectId?: unknown; id?: unknown };
  return typeof record.projectId === "string" && typeof record.id === "number";
}

/** Whether `value` names its project: a project record has a string id. */
function isProjectRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

async function handleProjects(absPath: string): Promise<HandlerResult> {
  const read = readStateFile(absPath);
  if (read.kind === "missing") return rejected("projects.json", "Project state", MISSING);
  if (read.kind === "invalid") return rejected("projects.json", "Project state", read.first);
  const entries = read.value.projects;
  if (!Array.isArray(entries) || !entries.every(isProjectRecord)) {
    return rejected("projects.json", "Project state", "projects must be a list of project records");
  }
  const changed = projectRegistry.applyProjectsFileEdit(read.value as unknown as PersistedProjects);
  const projectId = only(changed);
  return applied({
    ...(projectId === undefined ? {} : { projectId }),
    summary:
      changed.length === 0
        ? "Project state applied."
        : `Project settings applied: ${changed.join(", ")}.`,
  });
}

async function handleBenchState(absPath: string): Promise<HandlerResult> {
  const read = readStateFile(absPath);
  if (read.kind === "missing") return rejected("state.json", "Bench state", MISSING);
  if (read.kind === "invalid") return rejected("state.json", "Bench state", read.first);
  const benches = read.value.benches;
  if (!Array.isArray(benches) || !benches.every(isBenchRecord)) {
    return rejected("state.json", "Bench state", "benches must be a list of bench records");
  }
  // A legacy record is migrated as every read of the file migrates it.
  const persisted = state.migratePersistedState(read.value as unknown as PersistedState);
  const edit = benchManager.applyStateFileEdit(persisted);
  const touched = [
    ...edit.refused,
    ...edit.reverted,
    ...edit.unmatched,
    ...edit.removed,
    ...edit.applied,
  ];
  // An edit that changed nothing of any bench, such as a save of the same
  // records reformatted, is no change to report: it sends no notice, and the
  // watch logs no line for it.
  if (touched.length === 0) return "ignored";
  const projects = new Set(touched.map((r) => r.projectId));
  const benchIds = [...new Set(touched.map((r) => r.benchId))].sort((a, b) => a - b);
  const target = projects.size === 1 ? { projectId: [...projects][0], benchIds } : {};
  // Each record the edit could not apply is named: a live bench is refused,
  // and a change to a field that is not hand-editable, a record of no bench
  // and a removed record are rejected. The benches it did apply follow.
  const notApplied: NotAppliedNotice[] = [];
  if (edit.refused.length > 0) notApplied.push(benchRefusedNotice(edit.refused));
  if (edit.reverted.length > 0) notApplied.push(benchRevertedNotice(edit.reverted));
  if (edit.unmatched.length > 0) notApplied.push(benchUnmatchedNotice(edit.unmatched));
  if (edit.removed.length > 0) notApplied.push(benchRemovedNotice(edit.removed));
  const first = notApplied[0];
  if (first === undefined) return applied({ ...target, summary: benchAppliedNotice(edit.applied) });
  const sentences = notApplied.map((n) => n.summary);
  if (edit.applied.length > 0) sentences.push(benchAppliedNotice(edit.applied));
  return {
    outcome: edit.refused.length > 0 ? "refused" : "rejected",
    event: {
      ...target,
      summary: sentences.join(" "),
      error: { path: "state.json", first: first.first },
    },
  };
}

async function handleAuth(absPath: string): Promise<HandlerResult> {
  const read = readStateFile(absPath);
  // auth.json is a legacy file: the boot migration moves its token out and
  // removes it, so its absence is the normal state. A token put there by hand
  // is copied into the credential slot, and the file is left in place.
  if (read.kind === "missing") return "ignored";
  if (read.kind === "invalid") return rejected("auth.json", "GitHub token", read.first);
  const token = read.value.githubToken;
  if (typeof token !== "string" || token.length === 0) {
    return rejected("auth.json", "GitHub token", "githubToken must be a non-empty string");
  }
  await credentialStore.set(GITHUB_PLUGIN_ID, GITHUB_TOKEN_SLOT, token);
  return applied({ summary: "GitHub token applied from auth.json." });
}

async function handleConsent(absPath: string): Promise<HandlerResult> {
  const read = readStateFile(absPath);
  if (read.kind === "missing") return applied({ summary: consentAppliedNotice([]) });
  if (read.kind === "invalid") {
    return rejected("plugins-consent.json", "Plugin consent", read.first);
  }
  const parsed = PluginConsentStateSchema.safeParse(read.value);
  if (!parsed.success) {
    return rejected("plugins-consent.json", "Plugin consent", firstIssue(parsed.error.issues));
  }
  // Refresh the module's last known consent from the file the edit left.
  loadConsentState();
  // Every consented plugin is offered a start, not only the ones the edit
  // adds: the app's own consent writes are self-writes that run no handler, so
  // no snapshot kept here could tell which records this edit added.
  // startAfterConsent leaves a running or held plugin as it is, and only the
  // plugins it started are named.
  const started: string[] = [];
  for (const pluginId of Object.keys(parsed.data.plugins)) {
    try {
      if (await pluginManager.startAfterConsent(pluginId)) started.push(pluginId);
    } catch (err) {
      console.warn(
        `[state-dir-watch] plugin ${pluginId} did not start after consent: ${(err as Error).message}`,
      );
    }
  }
  const pluginId = only(started);
  return applied({
    ...(pluginId === undefined ? {} : { pluginId }),
    summary: consentAppliedNotice(started),
  });
}

async function handleEnableState(absPath: string): Promise<HandlerResult> {
  const read = readStateFile(absPath);
  // A missing file reads as a legacy install, where every plugin is enabled:
  // removing it by hand is not taken as a request to start them all.
  if (read.kind === "missing") return rejected("plugins-state.json", "Plugin state", MISSING);
  if (read.kind === "invalid") return rejected("plugins-state.json", "Plugin state", read.first);
  const parsed = PluginEnableStateSchema.safeParse(read.value);
  if (!parsed.success) {
    return rejected("plugins-state.json", "Plugin state", firstIssue(parsed.error.issues));
  }
  const reload = await pluginManager.reloadEnableState();
  const pluginId = only([...reload.disabled, ...reload.enabled]);
  return applied({
    ...(pluginId === undefined ? {} : { pluginId }),
    summary: enableStateNotice(reload),
  });
}

async function handleSettings(absPath: string): Promise<HandlerResult> {
  const read = readStateFile(absPath);
  if (read.kind === "invalid") {
    return rejected("settings.json", "Settings", read.first, "Last good settings still in effect.");
  }
  // Read again, so the last good settings are the ones the edit left. A
  // missing file reads as the built-in defaults. The notice names each setting
  // the edit changed from the settings last announced or written (HR-FR-011),
  // not from the last good ones: a missing file does not move those, and any
  // read of the file since the edit has moved them already.
  const before = state.lastAnnouncedSettings();
  const after = read.kind === "missing" ? state.builtInSettings() : state.loadSettings();
  state.noteAnnouncedSettings(after);
  return applied({ summary: settingsAppliedNotice(changedSettingNames(before, after)) });
}

/** "Environment file applied: 1 key changed." */
export function envFileAppliedNotice(changed: number): string {
  return `Environment file applied: ${changed} ${changed === 1 ? "key" : "keys"} changed.`;
}

/** "A", "A and B", "A, B and C". */
function listKeys(keys: string[]): string {
  if (keys.length <= 1) return keys.join("");
  return `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`;
}

/**
 * The notice of one save of .env: "Environment file applied: 1 key changed."
 * when only keys that apply at once changed, "Environment file:
 * ROUBO_APP_LOG_DIR needs a relaunch to apply." when only boot-only keys did,
 * and both sentences, the count first, when a save changed both kinds.
 */
export function envFileNotice(changed: number, needsRelaunch: string[]): string {
  if (needsRelaunch.length === 0) return envFileAppliedNotice(changed);
  const relaunch = `${listKeys(needsRelaunch)} ${needsRelaunch.length === 1 ? "needs" : "need"} a relaunch to apply.`;
  if (changed === 0) return `Environment file: ${relaunch}`;
  return `${envFileAppliedNotice(changed)} ${relaunch}`;
}

async function handleEnvFile(): Promise<HandlerResult> {
  // Load .env again (HR-FR-011): each key it adds, changes or removes reaches
  // process.env, and so every component, terminal and plugin process started
  // from now on. Explicit env still wins, and the boot-only keys stay as boot
  // set them: a save that changes one is named in the notice, which says a
  // relaunch is needed to apply it. An edit that changes no key, such as a
  // comment, sends no notice.
  const { changed, needsRelaunch } = loadEnvFileReport();
  if (changed.length === 0 && needsRelaunch.length === 0) return "ignored";
  return applied({ summary: envFileNotice(changed.length, needsRelaunch) });
}

/** The handler of one state file of the state dir. */
export async function handleStateFileChange(change: InputChange): Promise<HandlerResult> {
  const file = path.basename(change.path) as StateFile;
  switch (file) {
    case "projects.json":
      return handleProjects(change.path);
    case "state.json":
      return handleBenchState(change.path);
    case "auth.json":
      return handleAuth(change.path);
    case "plugins-consent.json":
      return handleConsent(change.path);
    case "plugins-state.json":
      return handleEnableState(change.path);
    case "settings.json":
      return handleSettings(change.path);
    case ".env":
      return handleEnvFile();
    default:
      return "ignored";
  }
}

/** The word each notice about one state file starts with. */
const FILE_LEADS: Record<StateFile, string> = {
  "projects.json": "Project state",
  "state.json": "Bench state",
  "auth.json": "GitHub token",
  "plugins-consent.json": "Plugin consent",
  "plugins-state.json": "Plugin state",
  "settings.json": "Settings",
  ".env": "Environment file",
};

/** The target ids of one event, the ones a client matches notices by. */
interface NoticeTarget {
  projectId?: string;
  pluginId?: string;
}

function targetOf(detail: InputEventDetail | undefined): NoticeTarget {
  return {
    ...(detail?.projectId === undefined ? {} : { projectId: detail.projectId }),
    ...(detail?.pluginId === undefined ? {} : { pluginId: detail.pluginId }),
  };
}

function targetKey(target: NoticeTarget): string {
  return `${target.projectId ?? ""}\u0000${target.pluginId ?? ""}`;
}

/**
 * Wrap the state-file handler so a rejected notice is cleared once its file is
 * fixed. A client clears a rejected notice only on an applied event of the
 * same surface and target, but a file-level rejection (invalid JSON, a schema
 * failure) has no target, the applied event of a fixed file can name one, and
 * a fix that puts back what the app already holds changes nothing, so its
 * handler sends no event. So each file keeps the targets of its open
 * file-level rejected notices. A rejected or refused bench record is never
 * kept: its handler wrote the file back, and that write-back is a self-write
 * that would otherwise clear the notice it just sent. Such a run clears the
 * open targets of the file, since the file parsed. On the next run that is not
 * rejected or refused, an applied event
 * is sent for each open target that the run's own event does not match: a
 * run that changes nothing is reported applied for the first of them, and the
 * rest are sent here. An app write that leaves the file valid runs no handler,
 * since the watch takes it as a self-write, so `onSelfWrite` sends an applied
 * event for every open target of the file then.
 */
function clearingRejections(handler: (change: InputChange) => Promise<HandlerResult>): {
  handler: (change: InputChange) => Promise<HandlerResult>;
  onSelfWrite: (change: InputChange) => void;
} {
  const open = new Map<StateFile, Map<string, NoticeTarget>>();
  const clearOpen = (file: StateFile, surface: InputSurface, ownKey?: string): NoticeTarget[] => {
    const targets = open.get(file);
    if (targets === undefined) return [];
    open.delete(file);
    const pending = [...targets.values()];
    const summary = `${FILE_LEADS[file]} applied.`;
    for (const target of pending) {
      if (targetKey(target) === ownKey) continue;
      broadcastInputChanged({ surface, outcome: "applied", ...target, summary });
    }
    return pending;
  };
  return {
    handler: async (change) => {
      const file = path.basename(change.path) as StateFile;
      const surface = stateFileSurface(change.path);
      if (surface === undefined) return handler(change);
      let result: HandlerResult;
      try {
        result = await handler(change);
      } catch (err) {
        // The watcher reports a throw as a rejection with no target.
        const targets = open.get(file) ?? new Map<string, NoticeTarget>();
        targets.set(targetKey({}), {});
        open.set(file, targets);
        throw err;
      }
      const outcome = typeof result === "string" ? result : result.outcome;
      const detail = typeof result === "object" ? result.event : undefined;
      if (outcome === "rejected" && typeof result === "object" && fileRejections.has(result)) {
        const targets = open.get(file) ?? new Map<string, NoticeTarget>();
        const target = targetOf(detail);
        targets.set(targetKey(target), target);
        open.set(file, targets);
        return result;
      }
      if (outcome === "rejected" || outcome === "refused") {
        // A bench record refused or rejected: the file parsed, so each open
        // file-level rejection is cleared now, before this run's own notice is
        // sent. This one is not kept open: the handler has undone it in the
        // file, and the self-write of that undo must not clear its notice.
        clearOpen(file, surface);
        return result;
      }
      const targets = open.get(file);
      if (targets === undefined) return result;
      let own: NoticeTarget;
      if (result === "ignored") {
        // The run changes nothing, so it is reported applied for the first
        // open target, and the rest are sent by clearOpen.
        own = [...targets.values()][0];
        result = { outcome: "applied", event: { ...own, summary: `${FILE_LEADS[file]} applied.` } };
      } else {
        own = targetOf(detail);
      }
      clearOpen(file, surface, targetKey(own));
      return result;
    },
    onSelfWrite: (change) => {
      const surface = stateFileSurface(change.path);
      if (surface === undefined) return;
      clearOpen(path.basename(change.path) as StateFile, surface);
    },
  };
}

/** The surface of one state file, or undefined for a path that is not one. */
export function stateFileSurface(absPath: string): InputSurface | undefined {
  const name = path.basename(absPath);
  return Object.hasOwn(STATE_FILE_SURFACES, name)
    ? STATE_FILE_SURFACES[name as StateFile]
    : undefined;
}

let active: InputWatch | null = null;
let activeDir: string | null = null;

export interface StateDirWatchOptions {
  /** The state dir. Defaults to the Roubo state dir. */
  dir?: string;
  settleMs?: number;
  rearmPollMs?: number;
}

/**
 * Arm the watch of the state dir. Resolves once each state file on disk has
 * been hashed, so only a change after it runs a handler. A second call while
 * armed returns the armed watch.
 */
export async function startStateDirWatch(options: StateDirWatchOptions = {}): Promise<InputWatch> {
  if (active) return active;
  // Read settings.json once, so a hand edit that breaks it later still has
  // last good settings to serve, and a hand edit that parses is named from
  // what the file held when the watch armed.
  try {
    state.noteAnnouncedSettings(state.loadSettings());
  } catch {
    // A settings file that cannot be read has no last good value to keep.
  }
  const dir = options.dir ?? state.getRouboDir();
  const clearing = clearingRejections(handleStateFileChange);
  const watch = watchInput(
    dir,
    {
      surface: STATE_DIR_SURFACE,
      surfaceOf: stateFileSurface,
      kind: "directory",
      depth: 0,
      allow: STATE_FILES,
      settleMs: options.settleMs ?? STATE_DIR_SETTLE_MS,
      // The app writes these files read-modify-write, so an app write inside
      // the settle window of a hand edit must not take the edit in as its own.
      trackHandEdits: true,
      onSelfWrite: clearing.onSelfWrite,
      ...(options.rearmPollMs === undefined ? {} : { rearmPollMs: options.rearmPollMs }),
    },
    clearing.handler,
  );
  active = watch;
  activeDir = dir;
  await watch.ready;
  // Load .env once more, so an edit saved between the boot load and the arm
  // is not missed; the watch runs for each save from here on.
  try {
    loadEnvFile();
  } catch (err) {
    console.warn(`[state-dir-watch] .env could not be loaded: ${(err as Error).message}`);
  }
  // A state file that is absent is known absent, so a file created by hand
  // and written by the app inside the settle window is told apart too.
  for (const file of STATE_FILES) {
    const abs = path.join(dir, file);
    if (!fs.existsSync(abs)) noteInputContent(abs, null);
  }
  return watch;
}

/** Dispose the watch of the state dir. */
export async function stopStateDirWatch(): Promise<void> {
  const current = active;
  const dir = activeDir;
  active = null;
  activeDir = null;
  if (current) await current.dispose();
  if (dir !== null) for (const file of STATE_FILES) forgetInputContent(path.join(dir, file));
}
