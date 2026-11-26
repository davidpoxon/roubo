import type {
  RegisteredProject,
  RouboConfig,
  ConfigValidationResult,
  ProjectSettings,
  PersistedProjectEntry,
  PersistedProjects,
} from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_BENCH_SETTINGS } from "@roubo/shared";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseConfig } from "./config-parser.js";
import { validateComponentBindings } from "./component-binding-validator.js";
import { checkPortConflicts, getPortConflicts } from "./port-allocator.js";
import * as state from "./state.js";
import * as pluginManager from "./plugin-manager.js";
import { normalizeAbsolutePath, UnsafePathError } from "../lib/safe-path.js";
import { cutListQueryService } from "./cut-list-query-service.js";
import { logApply, watchInput, type HandlerResult, type InputWatch } from "./input-watcher.js";
import { hashContent } from "./self-write-tokens.js";
import { broadcastInputChanged } from "./sse.js";
import { clearProjectRepathed, markBenchesRepathed } from "./project-repath-state.js";

const projects = new Map<string, RegisteredProject>();

/**
 * The hash of the roubo.yaml content each project record was parsed from, or
 * null when the file was missing. The watch arms later than the parse (at boot
 * after the plugin manager is up), so it starts from this hash rather than
 * from what is on disk at arm time: a save made in between still runs a
 * re-parse instead of being taken as already loaded.
 */
const loadedConfigHashes = new Map<string, string | null>();

/**
 * The outcome of the last roubo.yaml apply of each project. An app write that
 * applies after a rejection uses it to send the applied event that clears the
 * open error notice (HR-TC-005).
 */
const lastConfigOutcomes = new Map<string, "applied" | "rejected">();

/**
 * The hash of a project's roubo.yaml as it is on disk now, or null when it
 * cannot be read. Read before the parse, so a write that lands between the two
 * leaves a hash older than the parsed content, and the watch re-parses again
 * rather than missing the write.
 */
function readConfigHash(repoPath: string): string | null {
  try {
    return hashContent(fs.readFileSync(path.join(repoPath, ".roubo", "roubo.yaml")));
  } catch {
    return null;
  }
}

type ConfigLoadedListener = (project: RegisteredProject) => void;
const configLoadedListeners: ConfigLoadedListener[] = [];

export function onProjectConfigLoaded(cb: ConfigLoadedListener): void {
  configLoadedListeners.push(cb);
}

/** A roubo.yaml change that was not applied: the path and its first error. */
export interface ProjectConfigRejection {
  projectId: string;
  error: { path: string; first: string };
}

type ConfigRejectedListener = (rejection: ProjectConfigRejection) => void;
const configRejectedListeners: ConfigRejectedListener[] = [];

/**
 * Subscribe to roubo.yaml re-parses that were not applied (HR-FR-002). The
 * last good config of the project stays live; the listener gets the config
 * path relative to the project root and the first validation error.
 */
export function onProjectConfigRejected(cb: ConfigRejectedListener): void {
  configRejectedListeners.push(cb);
}

function emitConfigRejected(rejection: ProjectConfigRejection): void {
  for (const cb of configRejectedListeners) {
    try {
      cb(rejection);
    } catch (err) {
      console.warn("[project-registry] config-rejected listener threw: %s", (err as Error).message);
    }
  }
}

/**
 * A change to the set of registered projects (HR-FR-014): a project was
 * registered, now lives at another path, or was unregistered. Each one comes
 * from the app's own register and unregister calls or from a hand edit of
 * projects.json. A module that keeps a resource per project, such as a watch
 * of the project's folder, subscribes to keep it on the project's current
 * path.
 */
export type ProjectLifecycleEvent =
  | { kind: "registered"; project: RegisteredProject }
  | { kind: "repathed"; project: RegisteredProject; previousRepoPath: string }
  | { kind: "unregistered"; projectId: string; repoPath: string };

type ProjectLifecycleListener = (event: ProjectLifecycleEvent) => void;
const lifecycleListeners = new Set<ProjectLifecycleListener>();

/** Subscribe to project register, re-path and unregister. Returns the unsubscribe. */
export function onProjectLifecycle(cb: ProjectLifecycleListener): () => void {
  lifecycleListeners.add(cb);
  return () => {
    lifecycleListeners.delete(cb);
  };
}

function emitLifecycle(event: ProjectLifecycleEvent): void {
  for (const cb of lifecycleListeners) {
    try {
      cb(event);
    } catch (err) {
      console.warn("[project-registry] lifecycle listener threw: %s", (err as Error).message);
    }
  }
}

/** The project config file, relative to the project root, as a notice names it. */
export const PROJECT_CONFIG_PATH = ".roubo/roubo.yaml";

/** The surface name of the roubo.yaml watch on every log line and event. */
const PROJECT_CONFIG_SURFACE = "project-config";

/** The settle window of the roubo.yaml watch, in milliseconds. */
const PROJECT_CONFIG_SETTLE_MS = 150;

/**
 * The in-memory bench map, seen from the registry. `bench-manager` already imports
 * `project-registry`, so the registry cannot import it back; this seam inverts the
 * dependency instead. `server/index.ts` (the composition root) registers the real
 * implementation right after `initialize()`, well before the HTTP listener binds,
 * so no unregister request can arrive unwired. With nothing registered the registry
 * behaves exactly as it did before (persisted records only), which is what keeps the
 * many partial `vi.mock("./project-registry.js")` suites working. See #1204.
 */
export interface LiveBenchSource {
  listBenchIds(projectId: string): number[];
  dropBenches(projectId: string): number;
  /**
   * On the force path, stops what runs in each bench (#1441), then removes each
   * bench's workspace and git admin dir (#1435), or logs what stays when
   * `repoPath` is missing. Returns the paths still on disk.
   */
  removeWorkspaces(
    projectId: string,
    repoPath: string,
    persisted: { id: number; workspacePath: string }[],
  ): Promise<{ leftovers: string[] }>;
  /**
   * The ids of the project's benches whose component snapshot no longer
   * matches the live config, read after a roubo.yaml apply so its notice can
   * name how many benches are stale (HR-FR-004). Without it no bench counts.
   */
  listStaleBenchIds?(projectId: string): number[];
}

let liveBenchSource: LiveBenchSource | null = null;

export function registerLiveBenchSource(source: LiveBenchSource | null): void {
  liveBenchSource = source;
}

function emitConfigLoaded(project: RegisteredProject): void {
  if (!project.configValid) return;
  for (const cb of configLoadedListeners) {
    try {
      cb(project);
    } catch (err) {
      console.warn("[project-registry] config-loaded listener threw: %s", (err as Error).message);
    }
  }
}

/**
 * Plugin-aware second pass over a structurally-valid project config (#884,
 * CP-TC-005): validate every component binding whose plugin is loaded against
 * that plugin's `configSchema` and, if any config block is invalid, fold the
 * path-keyed `ConfigFieldError`s into the project's config-invalid state so
 * invalid component config surfaces at config-load. A no-op when the project is
 * already invalid (nothing valid to second-guess) or carries no parsed config.
 *
 * Config-load is deliberately lenient about a binding to a plugin that is not
 * currently loaded (`ignoreUnknownPlugins`): a roubo.yaml may legitimately name
 * a component plugin that is disabled, pending install, or absent from this
 * environment, and that must not brick the whole project (block GET /config,
 * bench creation, etc.). The "plugin must be present" enforcement belongs at
 * bench-start, where the component actually has to run (#663). Only a genuine
 * `configSchema` violation on a LOADED plugin invalidates the config here.
 *
 * This needs the plugin manager initialized to see the installed component
 * manifests. At boot the registry loads before the plugin manager
 * (server/index.ts), so `initialize()` deliberately skips this pass and
 * `revalidateComponentBindings()` re-runs it for every project once the
 * component manifests are available, before the HTTP listener binds. The
 * post-boot config-load paths (`registerProject`, `reloadConfig`) call it inline
 * because the plugin manager is up by then.
 */
function applyComponentBindingValidation(project: RegisteredProject): void {
  if (!project.configValid || !project.config) return;
  const errors = validateComponentBindings(project.config, pluginManager.getComponentManifests(), {
    ignoreUnknownPlugins: true,
  });
  if (errors.length === 0) return;
  project.configValid = false;
  project.fieldErrors = errors;
  project.configError = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
}

/**
 * Re-run the component-binding second pass against every registered project.
 * Called once from server/index.ts after the plugin manager finishes
 * initializing: the registry's own `initialize()` runs before plugins are
 * loaded, so component bindings cannot be validated there. This closes that gap
 * by validating them once the component manifests exist, before the HTTP
 * listener binds, so a project that binds a loaded component plugin with an
 * invalid config block surfaces that error at boot (#884, CP-TC-005). A
 * binding to a not-loaded plugin is left valid here (see
 * applyComponentBindingValidation): its presence is enforced at bench-start.
 */
export function revalidateComponentBindings(): void {
  for (const project of projects.values()) {
    applyComponentBindingValidation(project);
  }
}

/**
 * Resolve `ProjectSettings` for a project loaded from `~/.roubo/projects.json`.
 *
 * NOTE: this inverts the usual "missing field = false" convention. A project
 * record written before per-project settings existed has no `settings` key,
 * and we interpret that as BOTH worktree-source toggles ON. Rationale (PRD
 * R4, `specs/prd-worktree-source-settings.md`): Roubo's single user today
 * wants the new behaviour everywhere with no migration banner. If you are
 * adding another per-project setting in the future, pick the default here
 * very deliberately: you are choosing what every pre-existing project gets.
 */
function resolveSettings(entry: PersistedProjectEntry): ProjectSettings {
  return (
    entry.settings ?? {
      ...DEFAULT_PROJECT_SETTINGS,
      worktreeSource: { ...DEFAULT_PROJECT_SETTINGS.worktreeSource },
    }
  );
}

export function initialize() {
  const persisted = state.loadProjects();
  for (const entry of persisted.projects) {
    const settings = resolveSettings(entry);
    const loadedHash = readConfigHash(entry.repoPath);
    const result = parseConfig(entry.repoPath);
    let project: RegisteredProject;
    if (result.valid && result.config) {
      project = {
        id: entry.id,
        repoPath: entry.repoPath,
        config: result.config,
        configValid: true,
        settings,
      };
    } else {
      project = {
        id: entry.id,
        repoPath: entry.repoPath,
        config: undefined,
        configValid: false,
        configError: result.errors?.join("; "),
        fieldErrors: result.fieldErrors,
        settings,
      };
    }
    // NOTE: the component-binding second pass is deliberately NOT run here. At
    // boot the registry loads before the plugin manager, so no component
    // manifests are available yet; server/index.ts calls
    // revalidateComponentBindings() once plugins are up (#884).
    projects.set(entry.id, project);
    loadedConfigHashes.set(entry.id, loadedHash);
    emitConfigLoaded(project);
  }
}

/** A project of a projects.json hand edit, named by its id and its path. */
export interface ProjectPathRef {
  projectId: string;
  repoPath: string;
}

/** What one hand edit of projects.json did (HR-FR-012, HR-FR-014). */
export type ProjectsFileEdit =
  | {
      outcome: "rejected";
      /** The first invalid entry, as a clause, such as "project lantern has no repoPath". */
      first: string;
    }
  | {
      outcome: "applied";
      /** The projects the edit added, each registered with its roubo.yaml watch armed. */
      registered: ProjectPathRef[];
      /** The projects whose path the edit changed, with the benches that left stale. */
      repathed: (ProjectPathRef & { staleBenchIds: number[] })[];
      /** The projects the edit removed and that are now unregistered. */
      unregistered: string[];
      /**
       * The projects the edit removed that are still registered, since each has
       * active benches. The file is written back with them, so it holds what
       * the registry does.
       */
      refused: { projectId: string; benchIds: number[] }[];
      /** The registered projects whose settings the edit changed. */
      settingsChanged: string[];
    };

/**
 * A record for a project read from projects.json at `repoPath`, as boot reads
 * it: a roubo.yaml that is missing or invalid gives a config-invalid record,
 * and the component-binding second pass runs when `validateBindings` is set.
 */
function loadProjectRecord(
  id: string,
  repoPath: string,
  settings: ProjectSettings,
  validateBindings: boolean,
): { project: RegisteredProject; loadedHash: string | null } {
  const loadedHash = readConfigHash(repoPath);
  const result = parseConfig(repoPath);
  const project: RegisteredProject =
    result.valid && result.config
      ? { id, repoPath, config: result.config, configValid: true, settings }
      : {
          id,
          repoPath,
          config: undefined,
          configValid: false,
          configError: result.errors?.join("; "),
          fieldErrors: result.fieldErrors,
          settings,
        };
  if (validateBindings) applyComponentBindingValidation(project);
  return { project, loadedHash };
}

/** The persisted record of a registered project. */
function toPersistedEntry(project: RegisteredProject): PersistedProjectEntry {
  return { id: project.id, repoPath: project.repoPath, settings: project.settings };
}

/**
 * Every bench of a project, live or only persisted, by id. A bench that is
 * provisioning shows in memory before it is persisted, and one whose
 * provisioning failed is never persisted, so neither list alone is complete
 * (#1204).
 */
function projectBenchIds(projectId: string): number[] {
  const persisted = state.getPersistedBenches(projectId).map((b) => b.id);
  const live = liveBenchSource?.listBenchIds(projectId) ?? [];
  return Array.from(new Set([...persisted, ...live])).sort((a, b) => a - b);
}

/**
 * The first reason a projects.json hand edit cannot be applied, or null when
 * every entry is valid (HR-FR-014). An entry is invalid when it has no
 * repoPath, when its repoPath is not an absolute path, or when its id is
 * listed twice. A project the edit adds or moves is also invalid when its
 * ports overlap those of another project that the edit leaves registered.
 * `loaded` holds the record of each project the edit adds or moves.
 */
function projectsFileError(
  entries: readonly PersistedProjectEntry[],
  loaded: ReadonlyMap<string, RegisteredProject>,
): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = entry as { id: unknown; repoPath?: unknown };
    if (typeof raw.id !== "string" || raw.id.length === 0) return "a project has no id";
    if (seen.has(entry.id)) return `project ${entry.id} is listed twice`;
    seen.add(entry.id);
    if (typeof raw.repoPath !== "string" || raw.repoPath.length === 0) {
      return `project ${entry.id} has no repoPath`;
    }
    if (!path.isAbsolute(raw.repoPath) || raw.repoPath.includes("\0")) {
      return `repoPath of project ${entry.id} is not an absolute path`;
    }
  }
  // The projects that stay registered after the edit: each one listed, at its
  // new record when the edit adds or moves it, and each one removed whose
  // removal is refused for its active benches, since it stays too.
  const after: RegisteredProject[] = [];
  for (const entry of entries) {
    const project = loaded.get(entry.id) ?? projects.get(entry.id);
    if (project) after.push(project);
  }
  for (const project of projects.values()) {
    if (!seen.has(project.id) && projectBenchIds(project.id).length > 0) after.push(project);
  }
  for (const project of loaded.values()) {
    if (!project.config) continue;
    const others = after.filter((p) => p.id !== project.id && p.config !== undefined);
    const conflicts = checkPortConflicts({ id: project.id, config: project.config }, others);
    if (conflicts.length > 0) return conflicts[0];
  }
  return null;
}

/**
 * Apply a projects.json edited outside the app (HR-FR-012, HR-FR-014), as a
 * relaunch would load it. Nothing of an edit with an invalid entry is applied:
 * the registry keeps what it has, and the reason is returned. Otherwise:
 *
 * - a record with an id that is not registered registers that project, with
 *   its roubo.yaml watch armed. A missing or invalid roubo.yaml registers it
 *   config-invalid, as boot does, so the watch applies the fix when it lands.
 * - a record of a registered project with another path re-paths it: its
 *   roubo.yaml is read at the new path, its watch moves there, and each of its
 *   benches is marked stale, since it was set up from the old path.
 * - a registered project with no record is unregistered, unless it has an
 *   active bench: then it stays, and the file is written back from the
 *   registry, a self-write, so the next launch loads it too.
 * - a registered project whose record carries other settings takes them.
 */
export async function applyProjectsFileEdit(
  persisted: PersistedProjects,
): Promise<ProjectsFileEdit> {
  const entries = persisted.projects;
  const loaded = new Map<string, RegisteredProject>();
  const loadedHashes = new Map<string, string | null>();
  const shapeError = projectsFileError(entries, loaded);
  if (shapeError !== null) return { outcome: "rejected", first: shapeError };
  for (const entry of entries) {
    const current = projects.get(entry.id);
    const repoPath = path.resolve(entry.repoPath);
    if (current && current.repoPath === repoPath) continue;
    const record = loadProjectRecord(entry.id, repoPath, resolveSettings(entry), true);
    loaded.set(entry.id, record.project);
    loadedHashes.set(entry.id, record.loadedHash);
  }
  const conflict = projectsFileError(entries, loaded);
  if (conflict !== null) return { outcome: "rejected", first: conflict };

  const listed = new Set(entries.map((e) => e.id));
  const unregistered: string[] = [];
  const refused: { projectId: string; benchIds: number[] }[] = [];
  for (const project of [...projects.values()]) {
    if (listed.has(project.id)) continue;
    const benchIds = projectBenchIds(project.id);
    if (benchIds.length > 0) {
      refused.push({ projectId: project.id, benchIds });
      continue;
    }
    await dropProject(project.id);
    unregistered.push(project.id);
  }

  const registered: ProjectPathRef[] = [];
  const repathed: (ProjectPathRef & { staleBenchIds: number[] })[] = [];
  const settingsChanged: string[] = [];
  for (const entry of entries) {
    const next = loaded.get(entry.id);
    const current = projects.get(entry.id);
    if (next === undefined) {
      if (!current) continue;
      const settings = resolveSettings(entry);
      if (isDeepStrictEqual(settings, current.settings)) continue;
      current.settings = settings;
      settingsChanged.push(entry.id);
      continue;
    }
    if (current) {
      await disposeConfigWatch(entry.id);
      lastConfigOutcomes.delete(entry.id);
    }
    projects.set(entry.id, next);
    loadedConfigHashes.set(entry.id, loadedHashes.get(entry.id) ?? null);
    armConfigWatch(next);
    emitConfigLoaded(next);
    if (current) {
      const staleBenchIds = projectBenchIds(entry.id);
      markBenchesRepathed(entry.id, staleBenchIds);
      repathed.push({ projectId: entry.id, repoPath: next.repoPath, staleBenchIds });
      emitLifecycle({ kind: "repathed", project: next, previousRepoPath: current.repoPath });
    } else {
      registered.push({ projectId: entry.id, repoPath: next.repoPath });
      emitLifecycle({ kind: "registered", project: next });
    }
  }

  // A refused removal is undone in the file, so the file holds what the
  // registry does and the next launch does not drop a project with benches.
  if (refused.length > 0) {
    state.saveProjects({ projects: Array.from(projects.values()).map(toPersistedEntry) });
  }
  return { outcome: "applied", registered, repathed, unregistered, refused, settingsChanged };
}

export function registerProject(repoPath: string): RegisteredProject {
  // repoPath is a user-supplied local directory (project-registration UI). It
  // can legitimately point anywhere on disk, so we cannot contain it under a
  // root; instead normalise it through the safe-path barrier before it is
  // stored and later flows into git/worktree cwd at the spawn sink
  // (CodeQL #92, js/path-injection).
  let safeRepoPath: string;
  try {
    safeRepoPath = normalizeAbsolutePath(repoPath, "repoPath");
  } catch (err) {
    if (err instanceof UnsafePathError) {
      throw new ProjectRegistryError(err.message, "INVALID_PATH");
    }
    throw err;
  }

  const loadedHash = readConfigHash(safeRepoPath);
  const result = parseConfig(safeRepoPath);
  if (!result.valid || !result.config) {
    const isNotFound = result.errors?.some((e) => e.includes("not found"));
    throw new ProjectRegistryError(
      `Invalid roubo.yaml: ${result.errors?.join("; ")}`,
      isNotFound ? "NO_CONFIG" : "INVALID_CONFIG",
    );
  }

  const config = result.config;
  const id = config.project.name;

  if (projects.has(id)) {
    throw new ProjectRegistryError(`Project '${id}' is already registered`, "DUPLICATE");
  }

  const conflicts = checkPortConflicts({ id, config }, Array.from(projects.values()));
  if (conflicts.length > 0) {
    throw new ProjectRegistryError(
      `Port conflicts detected: ${conflicts.join("; ")}`,
      "PORT_CONFLICT",
    );
  }

  const project: RegisteredProject = {
    id,
    repoPath: safeRepoPath,
    config,
    configValid: true,
    settings: {
      ...DEFAULT_PROJECT_SETTINGS,
      worktreeSource: { ...DEFAULT_PROJECT_SETTINGS.worktreeSource },
    },
  };

  // Plugin-aware second pass: an invalid component binding downgrades the
  // project to config-invalid (#884). The plugin manager is up by the
  // time a project is registered post-boot, so the component manifests are
  // available here (unlike at initialize()).
  applyComponentBindingValidation(project);

  projects.set(id, project);
  loadedConfigHashes.set(id, loadedHash);
  state.addProject({ id, repoPath: safeRepoPath, settings: project.settings });
  // Armed after the project is persisted, so its root is an allowed watch root.
  armConfigWatch(project);

  emitConfigLoaded(project);
  emitLifecycle({ kind: "registered", project });
  return project;
}

// An unregister that is still removing workspaces, by project id (#1435). A
// second unregister of the same project shares it instead of removing the same
// worktrees again in parallel.
const pendingUnregisters = new Map<string, Promise<void>>();

export function unregisterProject(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const pending = pendingUnregisters.get(projectId);
  if (pending) return pending;
  const run = unregisterProjectNow(projectId, opts);
  pendingUnregisters.set(projectId, run);
  const settle = () => {
    if (pendingUnregisters.get(projectId) === run) pendingUnregisters.delete(projectId);
  };
  void run.then(settle, settle);
  return run;
}

async function unregisterProjectNow(projectId: string, opts: { force?: boolean }): Promise<void> {
  const project = projects.get(projectId);
  if (!project) {
    throw new ProjectRegistryError(`Project '${projectId}' not found`, "NOT_FOUND");
  }

  // Count the union of both bench representations, deduped by id, so the guard can
  // never report fewer benches than the Benches view renders (#1204). Persisted
  // records lag the in-memory map during the reservation window and never appear at
  // all for a bench whose provisioning failed, so persisted state alone under-counts.
  const benches = state.getPersistedBenches(projectId);
  const liveIds = liveBenchSource?.listBenchIds(projectId) ?? [];
  const activeIds = Array.from(new Set([...benches.map((b) => b.id), ...liveIds])).sort(
    (a, b) => a - b,
  );
  if (activeIds.length > 0) {
    if (!opts.force) {
      throw new ProjectRegistryError(
        `Cannot unregister '${projectId}': ${activeIds.length} active bench(es). Clear them first.`,
        "HAS_BENCHES",
        { benchCount: activeIds.length, benchIds: activeIds },
      );
    }
    // Force path. Stop each bench's terminals, component processes and compose
    // projects (#1441) and remove its workspace and git admin dir (#1435) first,
    // while the records still say where they are: once they are dropped, Roubo no
    // longer knows the project and nothing stops or removes them. When the repo
    // is missing nothing can be removed through git, so the paths are logged and
    // stay on disk. Then drop the bench records from state.json.
    await liveBenchSource?.removeWorkspaces(projectId, project.repoPath, benches);
    for (const bench of benches) {
      state.removeBench(projectId, bench.id);
    }
    // Drop the matching in-memory entries too, otherwise they keep counting toward
    // the global bench cap (`benches.size`) until the app restarts (#1204).
    liveBenchSource?.dropBenches(projectId);
  }

  state.removeProject(projectId);
  await dropProject(projectId);
}

/**
 * Drop a project the registry no longer lists: its record, its roubo.yaml
 * watch, its cut-list cache and its re-path marks, and tell each lifecycle
 * listener, so a later save under the project's path runs nothing (HR-TC-033).
 * The caller has removed or found it removed from projects.json.
 */
async function dropProject(projectId: string): Promise<void> {
  const project = projects.get(projectId);
  if (!project) return;
  projects.delete(projectId);
  loadedConfigHashes.delete(projectId);
  lastConfigOutcomes.delete(projectId);
  await disposeConfigWatch(projectId);
  // FR-004 / NFR-001: drop every persisted disk snapshot for this project once
  // it is unregistered (after the active-bench guard). A project's
  // subdirectory of the cache must not outlive the project.
  cutListQueryService.evictProject(projectId);
  clearProjectRepathed(projectId);
  emitLifecycle({ kind: "unregistered", projectId, repoPath: project.repoPath });
}

export function getProjects(): RegisteredProject[] {
  return Array.from(projects.values());
}

export function getProject(projectId: string): RegisteredProject | undefined {
  return projects.get(projectId);
}

/** What one re-parse of a project's roubo.yaml did. */
export interface ConfigApplyResult {
  outcome: "applied" | "rejected";
  /** The live project record after the apply: the new one, or the one kept. */
  project: RegisteredProject;
  /** The project's benches that the applied config left stale, sorted. */
  staleBenchIds: number[];
  /** On a rejection, the config path and the first validation error. */
  error?: { path: string; first: string };
  /** One line for the notice of this outcome. */
  summary: string;
}

/**
 * The first line of an error message, with no trailing period, so it fits in
 * one sentence of a notice. A YAML parse error quotes the input below its
 * first line, and a notice never carries file content.
 */
function firstErrorLine(message: string): string {
  const line = message.split("\n")[0].trim();
  return line.endsWith(".") ? line.slice(0, -1) : line;
}

/** The notice line of an applied roubo.yaml (HR-US-001, HR-US-002). */
export function appliedConfigSummary(projectId: string, staleCount: number): string {
  const base = `Project ${projectId}: roubo.yaml applied.`;
  if (staleCount === 0) return base;
  const benches = staleCount === 1 ? "bench is" : "benches are";
  return `${base} ${staleCount} ${benches} stale.`;
}

/**
 * The notice line of a rejected roubo.yaml (HR-US-008). It says the last good
 * config is still live only when the project has one.
 */
export function rejectedConfigSummary(
  projectId: string,
  error: { path: string; first: string },
  lastGoodLive: boolean,
): string {
  const base = `Project ${projectId}: roubo.yaml not applied. ${error.path}: ${error.first}.`;
  return lastGoodLive ? `${base} Last good config is still live.` : base;
}

/**
 * Re-parse a project's roubo.yaml through the same validation as registration:
 * the schema parse, the port-conflict check against every other project, and
 * the component-binding second pass (HR-FR-001, HR-FR-002).
 *
 * On success the new project record is built in full and replaces the map
 * entry in one assignment, so a bench set up meanwhile reads either the old
 * record or the new one, never a mix (HR-NFR-004). On a rejection a project
 * with a valid config keeps that record live untouched; a project with no
 * valid config takes the new errors. Either way the rejected listeners hear
 * the config path and the first error. Never throws for an invalid file.
 */
export function applyConfig(projectId: string): ConfigApplyResult {
  const current = projects.get(projectId);
  if (!current) {
    throw new ProjectRegistryError(`Project '${projectId}' not found`, "NOT_FOUND");
  }
  const base = { id: current.id, repoPath: current.repoPath, settings: current.settings };

  let rejected: { first: string; record: RegisteredProject };
  const loadedHash = readConfigHash(current.repoPath);
  const result = parseConfig(current.repoPath);
  if (!result.valid || !result.config) {
    const errors = result.errors ?? [];
    rejected = {
      first: firstErrorLine(errors[0] ?? "the config could not be parsed"),
      record: {
        ...base,
        config: undefined,
        configValid: false,
        configError: errors.join("; "),
        fieldErrors: result.fieldErrors,
      },
    };
  } else {
    const others = Array.from(projects.values()).filter((p) => p.id !== projectId);
    const conflicts = checkPortConflicts({ id: projectId, config: result.config }, others);
    if (conflicts.length > 0) {
      rejected = {
        first: firstErrorLine(`Port conflicts detected: ${conflicts[0]}`),
        record: {
          ...base,
          config: undefined,
          configValid: false,
          configError: `Port conflicts detected: ${conflicts.join("; ")}`,
        },
      };
    } else {
      const next: RegisteredProject = { ...base, config: result.config, configValid: true };
      // The component-binding second pass runs on the new record before it is
      // live, so a now-invalid binding (e.g. a plugin whose configSchema
      // tightened) is a rejection rather than a half-applied config (#884).
      applyComponentBindingValidation(next);
      if (next.configValid) {
        projects.set(projectId, next);
        loadedConfigHashes.set(projectId, loadedHash);
        lastConfigOutcomes.set(projectId, "applied");
        emitConfigLoaded(next);
        const staleBenchIds = liveBenchSource?.listStaleBenchIds?.(projectId) ?? [];
        return {
          outcome: "applied",
          project: next,
          staleBenchIds,
          summary: appliedConfigSummary(projectId, staleBenchIds.length),
        };
      }
      const firstField = next.fieldErrors?.[0];
      rejected = {
        first: firstErrorLine(
          firstField ? `${firstField.path}: ${firstField.message}` : (next.configError ?? ""),
        ),
        record: next,
      };
    }
  }

  const lastGoodLive = current.configValid && current.config !== undefined;
  if (!lastGoodLive) {
    projects.set(projectId, rejected.record);
    loadedConfigHashes.set(projectId, loadedHash);
  }
  lastConfigOutcomes.set(projectId, "rejected");
  const error = { path: PROJECT_CONFIG_PATH, first: rejected.first };
  emitConfigRejected({ projectId, error });
  return {
    outcome: "rejected",
    project: projects.get(projectId) ?? rejected.record,
    staleBenchIds: [],
    error,
    summary: rejectedConfigSummary(projectId, error, lastGoodLive),
  };
}

/**
 * Re-parse a project's roubo.yaml and return the live record. A caller that
 * has just written the file itself goes through here: its write is a
 * self-write, so the watch sends no event for an applied write (HR-NFR-002).
 * A rejected write is reported as the manual reload reports it, with one log
 * line and one rejected input-changed event, since the watch takes the write
 * as the app's own and would otherwise tell no one; the watch also records
 * the content as rejected, so a later save of it runs the re-parse again.
 * An applied write that follows a rejected apply of the project is reported
 * too, once, so its applied event clears the open error notice (HR-TC-005).
 */
export function reloadConfig(projectId: string): RegisteredProject {
  const start = performance.now();
  const lastRejected = lastConfigOutcomes.get(projectId) === "rejected";
  const apply = applyConfig(projectId);
  if (apply.outcome === "rejected" || lastRejected) reportConfigApply(projectId, apply, start);
  else markConfigAppliedInWatch(projectId, apply);
  return apply.project;
}

/**
 * Tell the project's watch that an apply outside the watch made the content
 * it parsed the applied content, so a rejected record of that content in the
 * watch is dropped and the next unchanged save is deduped (HR-TC-041).
 */
function markConfigAppliedInWatch(projectId: string, apply: ConfigApplyResult): void {
  if (apply.outcome !== "applied") return;
  const configPath = path.join(apply.project.repoPath, ".roubo", "roubo.yaml");
  configWatches.get(projectId)?.markApplied(configPath, loadedConfigHashes.get(projectId) ?? null);
}

function configWatchEvent(projectId: string, apply: ConfigApplyResult) {
  return {
    projectId,
    ...(apply.staleBenchIds.length > 0 ? { benchIds: apply.staleBenchIds } : {}),
    summary: apply.summary,
    ...(apply.error ? { error: apply.error } : {}),
  };
}

/**
 * Log and notify one apply that ran outside the watch, as a watched save is
 * logged and notified. A rejection also marks the content as rejected in the
 * project's watch, so the watch neither dedupes a save of that content nor
 * takes the app's own write of it as applied. An applied outcome marks the
 * content as applied there, so a save of it that the watch last saw rejected
 * is deduped rather than applied and notified again.
 */
function reportConfigApply(projectId: string, apply: ConfigApplyResult, start: number): void {
  const configPath = path.join(apply.project.repoPath, ".roubo", "roubo.yaml");
  let hash: string | null = null;
  try {
    hash = hashContent(fs.readFileSync(configPath));
  } catch {
    // A missing file logs no hash.
  }
  if (apply.outcome === "rejected") configWatches.get(projectId)?.markRejected(configPath, hash);
  else markConfigAppliedInWatch(projectId, apply);
  logApply({
    surface: PROJECT_CONFIG_SURFACE,
    path: configPath,
    outcome: apply.outcome,
    hash8: hash === null ? "none" : hash.slice(0, 8),
    durationMs: Math.round(performance.now() - start),
  });
  broadcastInputChanged({
    surface: PROJECT_CONFIG_SURFACE,
    outcome: apply.outcome,
    ...configWatchEvent(projectId, apply),
  });
}

/**
 * The manual reload (POST /api/projects/:projectId/reload-config). It applies
 * whatever is on disk with no hash dedupe, and writes the same log line and
 * sends the same input-changed event as a watched save (HR-FR-017).
 */
export function reloadConfigManually(projectId: string): RegisteredProject {
  const start = performance.now();
  const apply = applyConfig(projectId);
  reportConfigApply(projectId, apply, start);
  return apply.project;
}

// The roubo.yaml watch of each registered project, by project id.
const configWatches = new Map<string, InputWatch>();
// Off until the composition root turns it on at boot, so a registry under test
// arms no file watch.
let configWatchesEnabled = false;

/**
 * Watch the roubo.yaml of one project through its `.roubo` directory, since a
 * single-file watch loses saves that replace the file (HR-FR-001). A save runs
 * applyConfig; the watcher dedupes unchanged content and the app's own writes.
 */
function armConfigWatch(project: RegisteredProject): void {
  if (!configWatchesEnabled || configWatches.has(project.id)) return;
  const projectId = project.id;
  try {
    const watch = watchInput(
      path.join(project.repoPath, ".roubo"),
      {
        surface: PROJECT_CONFIG_SURFACE,
        settleMs: PROJECT_CONFIG_SETTLE_MS,
        depth: 0,
        allow: ["roubo.yaml"],
        target: { projectId },
        // The watch starts from the content the record was parsed from, so a
        // save made between that parse and this arm runs the re-parse.
        loadedHash: () => loadedConfigHashes.get(projectId),
      },
      async (): Promise<HandlerResult> => {
        const apply = applyConfig(projectId);
        return { outcome: apply.outcome, event: configWatchEvent(projectId, apply) };
      },
    );
    configWatches.set(projectId, watch);
  } catch (err) {
    console.warn(
      "[project-registry] roubo.yaml watch not armed for %s: %s",
      projectId,
      (err as Error).message,
    );
  }
}

async function disposeConfigWatch(projectId: string): Promise<void> {
  const watch = configWatches.get(projectId);
  if (!watch) return;
  configWatches.delete(projectId);
  await watch.dispose();
}

/**
 * Arm the roubo.yaml watch of every loaded project, and of each project
 * registered from now on. Called once at boot by the composition root.
 */
export function watchProjectConfigs(): void {
  configWatchesEnabled = true;
  for (const project of projects.values()) armConfigWatch(project);
}

/** Dispose every roubo.yaml watch, at shutdown. */
export async function unwatchProjectConfigs(): Promise<void> {
  configWatchesEnabled = false;
  await Promise.all([...configWatches.keys()].map((id) => disposeConfigWatch(id)));
}

export function updateProjectSettings(
  projectId: string,
  settings: ProjectSettings,
): RegisteredProject {
  const project = projects.get(projectId);
  if (!project) {
    throw new ProjectRegistryError(`Project '${projectId}' not found`, "NOT_FOUND");
  }

  project.settings = settings;
  // `state.addProject` is an upsert (filters by id then pushes), so passing
  // the full entry here rewrites the persisted row with the new settings.
  state.addProject({
    id: project.id,
    repoPath: project.repoPath,
    settings,
  });

  return project;
}

export function checkPortConflictsForConfig(
  config: RouboConfig,
  excludeProjectId?: string,
): ConfigValidationResult["portConflicts"] {
  const existingProjects = Array.from(projects.values()).filter(
    (p) => p.id !== excludeProjectId && p.configValid,
  );
  const newProject = { id: config.project.name, config };
  const conflicts = getPortConflicts(newProject, existingProjects);

  return conflicts.map(({ newRange, existingRange }) => {
    const existingProject = existingProjects.find((p) => p.id === existingRange.projectId);
    return {
      port: newRange.name,
      base: config.ports[newRange.name]?.base ?? 0,
      conflictsWith: {
        projectId: existingRange.projectId,
        projectName: existingProject?.config?.project?.displayName ?? existingRange.projectId,
        port: existingRange.name,
        range: [existingRange.low, existingRange.high] as [number, number],
      },
    };
  });
}

export function resolveEnforceIssueDependencies(
  projectId: string,
  settings = state.loadSettings(),
): boolean {
  const project = getProject(projectId);
  const override = project?.config?.benches?.enforceIssueDependencies;
  if (typeof override === "boolean") return override;
  return (
    settings.benches?.enforceIssueDependencies ?? DEFAULT_BENCH_SETTINGS.enforceIssueDependencies
  );
}

export class ProjectRegistryError extends Error {
  constructor(
    message: string,
    public code: string,
    /**
     * Code-specific context the route merges into the error body. `HAS_BENCHES`
     * carries `{ benchCount, benchIds }` so the client can name exactly what a
     * forced unregister would drop, including persisted records the Benches view
     * never rendered (#1191). Absent for every other code.
     */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}

// Test-only reset so the e2e /test/__reset handler can clear the projects Map
// between Playwright specs. Production code paths should call initialize() at
// boot; this exists only for the env-gated reset route.
export const __test = {
  reset(): void {
    projects.clear();
    loadedConfigHashes.clear();
    lastConfigOutcomes.clear();
    for (const watch of configWatches.values()) void watch.dispose();
    configWatches.clear();
  },
  /** The roubo.yaml watch of a project, so a test can await its `ready`. */
  configWatch(projectId: string): InputWatch | undefined {
    return configWatches.get(projectId);
  },
};
