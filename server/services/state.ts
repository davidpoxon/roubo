import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BLUEPRINT_SETTINGS,
  DEFAULT_BENCH_SETTINGS,
  DEFAULT_CLAUDE_CODE_SETTINGS,
  DEFAULT_GITHUB_SETTINGS,
} from "@roubo/shared";
import type {
  AssignedIssue,
  Bench,
  PersistedProjects,
  PersistedProjectEntry,
  PersistedState,
  PersistedBench,
  UserPreferences,
  ProjectPermissions,
} from "@roubo/shared";

function resolveRouboDir(): string {
  if (process.env.ROUBO_PRODUCTION) {
    return path.join(os.homedir(), ".roubo");
  }
  // state.ts lives at <root>/server/services/state.ts — go up 2 levels to reach project root.
  // This only runs in dev mode (ROUBO_PRODUCTION unset), where tsx executes the .ts source directly.
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  // Uses the checkout directory name as the isolation key. Two checkouts with the
  // same directory name will share a dev state directory — acceptable tradeoff.
  return path.join(os.homedir(), ".roubo-dev", path.basename(projectRoot));
}

const ROUBO_DIR = resolveRouboDir();
const WORKSPACES_DIR = path.join(ROUBO_DIR, "workspaces");
const PROJECTS_FILE = path.join(ROUBO_DIR, "projects.json");
const STATE_FILE = path.join(ROUBO_DIR, "state.json");
const SETTINGS_FILE = path.join(ROUBO_DIR, "settings.json");
const PERMISSIONS_DIR = path.join(ROUBO_DIR, "permissions");

let dirsEnsured = false;
export function ensureDirs() {
  if (dirsEnsured) return;
  fs.mkdirSync(ROUBO_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
  dirsEnsured = true;
}

export function atomicWrite(filePath: string, data: string, mode?: number) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: mode ?? 0o666 });
  fs.renameSync(tmp, filePath);
}

export function getRouboDir(): string {
  return ROUBO_DIR;
}

export function getWorkspacesDir(): string {
  return WORKSPACES_DIR;
}

export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/\//g, "-").replace(/^[-.]+|[-.]+$/g, "") || "branch";
}

export function getWorkspacePath(
  projectName: string,
  benchNumber: number,
  branch?: string,
): string {
  const dirName = branch
    ? `bench-${benchNumber}-${sanitizeBranchForPath(branch)}`
    : `bench-${benchNumber}`;
  return path.join(WORKSPACES_DIR, projectName, dirName);
}

export function loadProjects(): PersistedProjects {
  ensureDirs();
  if (!fs.existsSync(PROJECTS_FILE)) {
    return { projects: [] };
  }
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"));
}

export function saveProjects(data: PersistedProjects) {
  ensureDirs();
  atomicWrite(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Fills integrationId + externalId on a pre-plugin assignedIssue snapshot.
 * Pre-plugin benches only have `number` and `title`; this defaults them to
 * the github-com integration and stringifies `number` into `externalId`.
 * Idempotent — a fully-formed snapshot passes through unchanged.
 */
export function migrateAssignedIssue(issue: AssignedIssue | undefined): AssignedIssue | undefined {
  if (!issue) return issue;
  if (issue.integrationId && issue.externalId) return issue;
  return {
    ...issue,
    integrationId: issue.integrationId ?? "github-com",
    externalId: issue.externalId ?? String(issue.number ?? ""),
  };
}

export function loadState(): PersistedState {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    return { benches: [] };
  }
  const data: PersistedState = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  for (const bench of data.benches) {
    bench.assignedIssue = migrateAssignedIssue(bench.assignedIssue);
  }
  return data;
}

export function saveState(data: PersistedState) {
  ensureDirs();
  atomicWrite(STATE_FILE, JSON.stringify(data, null, 2));
}

export function addProject(entry: PersistedProjectEntry) {
  const data = loadProjects();
  data.projects = data.projects.filter((a) => a.id !== entry.id);
  data.projects.push(entry);
  saveProjects(data);
}

export function removeProject(projectId: string) {
  const data = loadProjects();
  data.projects = data.projects.filter((a) => a.id !== projectId);
  saveProjects(data);
}

export function addBench(bench: PersistedBench) {
  const data = loadState();
  data.benches = data.benches.filter(
    (b) => !(b.projectId === bench.projectId && b.id === bench.id),
  );
  data.benches.push(bench);
  saveState(data);
}

export function updateBench(bench: PersistedBench) {
  addBench(bench);
}

/**
 * Extracts the persisted subset of a Bench, stripping runtime-only fields
 * (status, components, error, provisioningSteps, teardownSteps).
 */
export function toPersistedBench(bench: Bench): PersistedBench {
  return {
    id: bench.id,
    projectId: bench.projectId,
    branch: bench.branch,
    workspacePath: bench.workspacePath,
    ports: bench.ports,
    createdAt: bench.createdAt,
    assignedContainers: bench.assignedContainers,
    assignedIssue: bench.assignedIssue,
    notifications: bench.notifications,
    workUnits: bench.workUnits,
    baseBranch: bench.baseBranch,
    baseCommit: bench.baseCommit,
    injectedBlueprintId: bench.injectedBlueprintId,
    injectedBlueprintSource: bench.injectedBlueprintSource,
    componentSetupState: Object.fromEntries(
      Object.entries(bench.components).map(([name, c]) => [name, c.setupComplete]),
    ),
  };
}

export function removeBench(projectId: string, benchId: number) {
  const data = loadState();
  data.benches = data.benches.filter((b) => !(b.projectId === projectId && b.id === benchId));
  saveState(data);
}

export function loadSettings(): UserPreferences {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return {
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    return {
      theme: raw.theme ?? "dark",
      blueprints: { ...DEFAULT_BLUEPRINT_SETTINGS, ...raw.blueprints },
      benches: { ...DEFAULT_BENCH_SETTINGS, ...raw.benches },
      claudeCode: { ...DEFAULT_CLAUDE_CODE_SETTINGS, ...raw.claudeCode },
      github: { ...DEFAULT_GITHUB_SETTINGS, ...raw.github },
    };
  } catch {
    return {
      theme: "dark",
      blueprints: DEFAULT_BLUEPRINT_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    };
  }
}

export function saveSettings(data: UserPreferences) {
  ensureDirs();
  atomicWrite(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

export function getPersistedBenches(projectId?: string): PersistedBench[] {
  const data = loadState();
  if (projectId) {
    return data.benches.filter((b) => b.projectId === projectId);
  }
  return data.benches;
}

function resolvePermissionsPath(projectId: string): string {
  const filePath = path.resolve(PERMISSIONS_DIR, `${projectId}.json`);
  if (!filePath.startsWith(PERMISSIONS_DIR + path.sep) && filePath !== PERMISSIONS_DIR) {
    throw new Error(`Invalid projectId: ${projectId}`);
  }
  return filePath;
}

export function getProjectPermissions(projectId: string): ProjectPermissions {
  const filePath = resolvePermissionsPath(projectId);
  if (!fs.existsSync(filePath)) {
    return { allow: [], deny: [], ask: [] };
  }
  try {
    const data: Partial<ProjectPermissions> = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return { allow: data.allow ?? [], deny: data.deny ?? [], ask: data.ask ?? [] };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}

export function setProjectPermissions(projectId: string, permissions: ProjectPermissions): void {
  const filePath = resolvePermissionsPath(projectId);
  fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
  atomicWrite(filePath, JSON.stringify(permissions, null, 2));
}
