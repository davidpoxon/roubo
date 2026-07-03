import type {
  RegisteredProject,
  RouboConfig,
  ConfigValidationResult,
  ProjectSettings,
  PersistedProjectEntry,
} from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_BENCH_SETTINGS } from "@roubo/shared";
import { parseConfig } from "./config-parser.js";
import { validateComponentBindings } from "./component-binding-validator.js";
import { checkPortConflicts, getPortConflicts } from "./port-allocator.js";
import * as state from "./state.js";
import * as pluginManager from "./plugin-manager.js";
import { normalizeAbsolutePath, UnsafePathError } from "../lib/safe-path.js";
import { cutListQueryService } from "./cut-list-query-service.js";

const projects = new Map<string, RegisteredProject>();

type ConfigLoadedListener = (project: RegisteredProject) => void;
const configLoadedListeners: ConfigLoadedListener[] = [];

export function onProjectConfigLoaded(cb: ConfigLoadedListener): void {
  configLoadedListeners.push(cb);
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
 * Plugin-aware second pass over a structurally-valid project config (issue #399,
 * CP-TC-005): validate every component binding against its bound plugin's
 * `configSchema` and, if any binding is invalid, fold the path-keyed
 * `ConfigFieldError`s into the project's config-invalid state so invalid
 * component config surfaces at config-load. A no-op when the project is already
 * invalid (nothing valid to second-guess) or carries no parsed config.
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
  const errors = validateComponentBindings(project.config, pluginManager.getComponentManifests());
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
 * listener binds, so a project whose bound plugin was uninstalled between
 * sessions surfaces its error at boot (issue #399, CP-TC-005).
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
    // revalidateComponentBindings() once plugins are up (issue #399).
    projects.set(entry.id, project);
    emitConfigLoaded(project);
  }
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
  // project to config-invalid (issue #399). The plugin manager is up by the
  // time a project is registered post-boot, so the component manifests are
  // available here (unlike at initialize()).
  applyComponentBindingValidation(project);

  projects.set(id, project);
  state.addProject({ id, repoPath: safeRepoPath, settings: project.settings });

  emitConfigLoaded(project);
  return project;
}

export function unregisterProject(projectId: string, opts: { force?: boolean } = {}) {
  const project = projects.get(projectId);
  if (!project) {
    throw new ProjectRegistryError(`Project '${projectId}' not found`, "NOT_FOUND");
  }

  const benches = state.getPersistedBenches(projectId);
  if (benches.length > 0) {
    if (!opts.force) {
      throw new ProjectRegistryError(
        `Cannot unregister '${projectId}': ${benches.length} active bench(es). Clear them first.`,
        "HAS_BENCHES",
      );
    }
    // Force path: drop bench records from state.json. No filesystem cleanup:
    // worktree dirs may not exist (folder was deleted) and we can't safely act
    // on a missing repo.
    for (const bench of benches) {
      state.removeBench(projectId, bench.id);
    }
  }

  projects.delete(projectId);
  state.removeProject(projectId);
  // FR-004 / NFR-001: drop every persisted disk snapshot for this project once
  // it is unregistered (after the active-bench guard above). A project's
  // subdirectory of the cache must not outlive the project.
  cutListQueryService.evictProject(projectId);
}

export function getProjects(): RegisteredProject[] {
  return Array.from(projects.values());
}

export function getProject(projectId: string): RegisteredProject | undefined {
  return projects.get(projectId);
}

export function reloadConfig(projectId: string): RegisteredProject {
  const project = projects.get(projectId);
  if (!project) {
    throw new ProjectRegistryError(`Project '${projectId}' not found`, "NOT_FOUND");
  }

  const result = parseConfig(project.repoPath);
  if (result.valid && result.config) {
    project.config = result.config;
    project.configValid = true;
    project.configError = undefined;
    project.fieldErrors = undefined;
    // Re-run the component-binding second pass on the freshly parsed config so a
    // now-invalid binding (e.g. a plugin uninstalled since the last load)
    // surfaces on reload (issue #399).
    applyComponentBindingValidation(project);
  } else {
    project.configValid = false;
    project.configError = result.errors?.join("; ");
    project.fieldErrors = result.fieldErrors;
  }

  emitConfigLoaded(project);
  return project;
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
  },
};
