import type {
  RegisteredProject,
  RouboConfig,
  ConfigValidationResult,
  ProjectSettings,
  PersistedProjectEntry,
} from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_BENCH_SETTINGS } from "@roubo/shared";
import { parseConfig } from "./config-parser.js";
import { checkPortConflicts } from "./port-allocator.js";
import * as state from "./state.js";

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
 * Resolve `ProjectSettings` for a project loaded from `~/.roubo/projects.json`.
 *
 * NOTE: this inverts the usual "missing field = false" convention. A project
 * record written before per-project settings existed has no `settings` key,
 * and we interpret that as BOTH worktree-source toggles ON. Rationale (PRD
 * R4, `specs/prd-worktree-source-settings.md`): Roubo's single user today
 * wants the new behaviour everywhere with no migration banner. If you are
 * adding another per-project setting in the future, pick the default here
 * very deliberately — you are choosing what every pre-existing project gets.
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
        settings,
      };
    }
    projects.set(entry.id, project);
    emitConfigLoaded(project);
  }
}

export function registerProject(repoPath: string): RegisteredProject {
  const result = parseConfig(repoPath);
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
    repoPath,
    config,
    configValid: true,
    settings: {
      ...DEFAULT_PROJECT_SETTINGS,
      worktreeSource: { ...DEFAULT_PROJECT_SETTINGS.worktreeSource },
    },
  };

  projects.set(id, project);
  state.addProject({ id, repoPath, settings: project.settings });

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
    // Force path: drop bench records from state.json. No filesystem cleanup —
    // worktree dirs may not exist (folder was deleted) and we can't safely act
    // on a missing repo.
    for (const bench of benches) {
      state.removeBench(projectId, bench.id);
    }
  }

  projects.delete(projectId);
  state.removeProject(projectId);
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
  } else {
    project.configValid = false;
    project.configError = result.errors?.join("; ");
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
  // `state.addProject` is an upsert — filters by id then pushes — so passing
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
  const conflicts = checkPortConflicts(newProject, existingProjects);

  return conflicts.map((msg) => {
    const match = msg.match(
      /^Port conflict: .+?\.(\S+) \((\d+)-(\d+)\) overlaps with (.+?)\.(\S+) \((\d+)-(\d+)\)$/,
    );
    if (!match)
      return {
        port: "",
        base: 0,
        conflictsWith: {
          projectId: "",
          projectName: "",
          port: "",
          range: [0, 0] as [number, number],
        },
      };
    const existingProject = existingProjects.find((p) => p.id === match[4]);
    return {
      port: match[1],
      base: config.ports[match[1]]?.base ?? 0,
      conflictsWith: {
        projectId: match[4],
        projectName: existingProject?.config?.project?.displayName ?? match[4],
        port: match[5],
        range: [parseInt(match[6]), parseInt(match[7])] as [number, number],
      },
    };
  });
}

export function resolveAutoClear(projectId: string, settings = state.loadSettings()): boolean {
  const project = getProject(projectId);
  const override = project?.config?.benches?.autoClear;
  if (typeof override === "boolean") return override;
  return settings.benches?.autoClear ?? DEFAULT_BENCH_SETTINGS.autoClear;
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

export function resolveWorkUnitAutoClear(
  projectId: string,
  settings = state.loadSettings(),
): boolean {
  const project = getProject(projectId);
  const override = project?.config?.benches?.workUnitAutoClear;
  if (typeof override === "boolean") return override;
  return settings.benches?.workUnitAutoClear ?? DEFAULT_BENCH_SETTINGS.workUnitAutoClear;
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
