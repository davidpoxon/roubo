import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_JIG_SETTINGS,
  DEFAULT_BENCH_SETTINGS,
  DEFAULT_TESTBENCH_SETTINGS,
  DEFAULT_GITHUB_SETTINGS,
} from "@roubo/shared";
import { PROJECT_ID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";
import type {
  AssignedIssue,
  Bench,
  JigDefaultSource,
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
  // state.ts lives at <root>/server/services/state.ts: go up 2 levels to reach project root.
  // This only runs in dev mode (ROUBO_PRODUCTION unset), where tsx executes the .ts source directly.
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  // Uses the checkout directory name as the isolation key. Two checkouts with the
  // same directory name will share a dev state directory: acceptable tradeoff.
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
  // Defence-in-depth containment: callers are expected to have already validated
  // `filePath`, but re-resolve via path.resolve + relative check so CodeQL sees a
  // sanitizer immediately before the file ops. This is the same shape the default
  // js/path-injection suite recognises.
  const resolvedFile = path.resolve(filePath);
  const parent = path.dirname(resolvedFile);
  const rel = path.relative(parent, resolvedFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`atomicWrite: invalid file path: ${filePath}`);
  }
  const tmp = resolvedFile + ".tmp";
  fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: mode ?? 0o666 });
  fs.renameSync(tmp, resolvedFile);
}

export function getRouboDir(): string {
  return ROUBO_DIR;
}

export function getWorkspacesDir(): string {
  return WORKSPACES_DIR;
}

export function sanitizeBranchForPath(branch: string): string {
  // Trim leading/trailing runs of '-'/'.' with explicit index walks rather than a
  // regex. An anchored `/[-.]+$/` trim is reported as js/polynomial-redos because the
  // greedy quantifier can backtrack on long separator runs; index walks are strictly
  // linear with no backtracking surface.
  const slashed = branch.replace(/\//g, "-");
  const isTrimChar = (c: string) => c === "-" || c === ".";
  let start = 0;
  let end = slashed.length;
  while (start < end && isTrimChar(slashed[start])) start++;
  while (end > start && isTrimChar(slashed[end - 1])) end--;
  return slashed.slice(start, end) || "branch";
}

/**
 * The directory every bench workspace for one project is provisioned under
 * (`<rouboDir>/workspaces/<projectName>`), i.e. the parent of every
 * `getWorkspacePath(projectName, ...)`. Exposed so a caller that needs to drop a
 * project's workspaces wholesale (the e2e fixture-project cleanup in
 * routes/test.ts, #686) resolves the same containment-checked path the
 * provisioning side does, rather than re-joining `getWorkspacesDir()` by hand.
 */
export function getProjectWorkspacesDir(projectName: string): string {
  assertSafeIdentifier(projectName, PROJECT_ID_RE, "projectName");
  return resolveWithin(WORKSPACES_DIR, projectName);
}

export function getWorkspacePath(
  projectName: string,
  benchNumber: number,
  branch?: string,
): string {
  assertSafeIdentifier(projectName, PROJECT_ID_RE, "projectName");
  if (!Number.isInteger(benchNumber) || benchNumber < 0) {
    throw new Error(`Invalid bench number: ${benchNumber}`);
  }
  const dirName = branch
    ? `bench-${benchNumber}-${sanitizeBranchForPath(branch)}`
    : `bench-${benchNumber}`;
  return resolveWithin(WORKSPACES_DIR, projectName, dirName);
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
 * Idempotent: a fully-formed snapshot passes through unchanged.
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

/**
 * One-shot rename of legacy `injectedBlueprintId` / `injectedBlueprintSource`
 * keys on a persisted bench to the new `injectedJigId` / `injectedJigSource`
 * names. Idempotent: re-running on already-migrated data is a no-op.
 */
function migrateInjectedJigFields(bench: PersistedBench): void {
  const raw = bench as unknown as Record<string, unknown>;
  if (raw.injectedJigId === undefined && typeof raw.injectedBlueprintId === "string") {
    bench.injectedJigId = raw.injectedBlueprintId as string;
  }
  if (raw.injectedJigSource === undefined && typeof raw.injectedBlueprintSource === "string") {
    bench.injectedJigSource = raw.injectedBlueprintSource as JigDefaultSource;
  }
  delete raw.injectedBlueprintId;
  delete raw.injectedBlueprintSource;
}

export function loadState(): PersistedState {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    return { benches: [] };
  }
  const data: PersistedState = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  for (const bench of data.benches) {
    bench.assignedIssue = migrateAssignedIssue(bench.assignedIssue);
    migrateInjectedJigFields(bench);
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
 *
 * NFR-004 audit: the only place a plugin-supplied `raw` may live in
 * state.json is `bench.assignedIssue.raw`. It rides through this function
 * with `assignedIssue` (passed by reference) and is removed when the bench
 * is filtered out in `removeBench`. No other persisted field carries
 * plugin-supplied unknowns.
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
    baseBranch: bench.baseBranch,
    baseCommit: bench.baseCommit,
    injectedJigId: bench.injectedJigId,
    injectedJigSource: bench.injectedJigSource,
    variant: bench.variant,
    focusedSpecPath: bench.focusedSpecPath,
    componentSetupState: Object.fromEntries(
      Object.entries(bench.components).map(([name, c]) => [name, c.setupComplete]),
    ),
    benchSetupComplete: bench.benchSetupComplete,
  };
}

export function removeBench(projectId: string, benchId: number) {
  const data = loadState();
  data.benches = data.benches.filter((b) => !(b.projectId === projectId && b.id === benchId));
  saveState(data);
}

export function loadSettings(opts?: { throwOnCorrupt?: boolean }): UserPreferences {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return {
      theme: "dark",
      jigs: DEFAULT_JIG_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      testBench: DEFAULT_TESTBENCH_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    // Legacy migration: the `blueprints` object plus its `defaultBlueprintId`
    // sub-key were renamed to `jigs` / `defaultJigId`. Honor old keys only if
    // the new ones are absent, so a user-authored settings file keeps working.
    const legacyJigSettings = raw.blueprints as
      (Record<string, unknown> & { defaultBlueprintId?: string }) | undefined;
    const mergedJigSettings = {
      ...DEFAULT_JIG_SETTINGS,
      ...(legacyJigSettings ?? {}),
      ...raw.jigs,
    } as Record<string, unknown>;
    if (
      mergedJigSettings.defaultJigId === undefined &&
      typeof legacyJigSettings?.defaultBlueprintId === "string"
    ) {
      mergedJigSettings.defaultJigId = legacyJigSettings.defaultBlueprintId;
    }
    delete mergedJigSettings.defaultBlueprintId;
    return {
      theme: raw.theme ?? "dark",
      jigs: mergedJigSettings as UserPreferences["jigs"],
      // AP-FR-008 (found while writing the AP-TC-025 e2e, #681): the app-level
      // agent tool presets have to be read back explicitly. This object is
      // rebuilt key by key rather than spread from `raw`, so an unlisted key is
      // dropped on EVERY read: `listAppAgentPresets` saw no presets, the editor
      // re-rendered an empty list, and the next settings write erased the file's
      // copy too (PUT /api/settings falls back to `current.agentTools`). Saving
      // an agent tool therefore never survived a reload.
      ...(Array.isArray(raw.agentTools) && {
        agentTools: raw.agentTools as UserPreferences["agentTools"],
      }),
      benches: { ...DEFAULT_BENCH_SETTINGS, ...raw.benches },
      testBench: { ...DEFAULT_TESTBENCH_SETTINGS, ...raw.testBench },
      github: { ...DEFAULT_GITHUB_SETTINGS, ...raw.github },
    };
  } catch (err) {
    // Fail-open by default: a corrupt settings.json yields built-in defaults so
    // the app keeps working. Callers that need to distinguish corruption from a
    // legitimately-default config (e.g. the global bench-cap check, which warns
    // once per process load) opt in via throwOnCorrupt. A missing file is handled
    // by the early return above and never reaches here, so absence never throws.
    if (opts?.throwOnCorrupt) {
      throw err;
    }
    return {
      theme: "dark",
      jigs: DEFAULT_JIG_SETTINGS,
      benches: DEFAULT_BENCH_SETTINGS,
      testBench: DEFAULT_TESTBENCH_SETTINGS,
      github: DEFAULT_GITHUB_SETTINGS,
    };
  }
}

export function saveSettings(data: UserPreferences) {
  ensureDirs();
  // `UserPreferences` no longer models the retired built-in agent block, but a
  // whole-file rewrite would drop it, and that block is the only signal an
  // install is an upgrade (see `hasLegacyAgentSettings`). Carry it across every
  // save so an unrelated settings change cannot silently retire the first-run
  // notice before the user has seen it (AP-FR-021, AP-TC-109).
  const legacy = readLegacyAgentSettings();
  const payload = legacy === undefined ? data : { ...data, [LEGACY_AGENT_SETTINGS_KEY]: legacy };
  atomicWrite(SETTINGS_FILE, JSON.stringify(payload, null, 2));
}

/**
 * The key the retired built-in agent preferences were stored under. It is a
 * legacy FILE key, not a `UserPreferences` field: #521 removed the field, and
 * nothing reads or writes this block any more. It is named in exactly one place
 * so the core-purity guard can allowlist that one place (AP-FR-021).
 */
const LEGACY_AGENT_SETTINGS_KEY = "claudeCode";

/**
 * The raw legacy block as it sits on disk, or `undefined` when absent. Reads
 * the file directly because `loadSettings` does not model the key at all.
 */
function readLegacyAgentSettings(): unknown {
  if (!fs.existsSync(SETTINGS_FILE)) return undefined;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return (raw as Record<string, unknown>)[LEGACY_AGENT_SETTINGS_KEY];
  } catch {
    return undefined;
  }
}

/**
 * True when `settings.json` still carries the retired built-in agent
 * preferences block, which is the ONLY signal that this install is an upgrade
 * rather than a fresh one (AP-FR-021, AP-TC-110).
 *
 * Deliberately reads the raw file: `loadSettings` merges defaults in, so its
 * result can never distinguish "the user had this block" from "we filled it
 * in". Nothing is migrated from the block and nothing removes it: `saveSettings`
 * carries it across whole-file rewrites, so the signal survives until the user
 * edits `settings.json` by hand.
 */
export function hasLegacyAgentSettings(): boolean {
  return readLegacyAgentSettings() !== undefined;
}

/**
 * Plant or remove the retired built-in agent preferences block (AP-FR-021).
 *
 * A TEST SEAM, reachable only through `POST /test/__seed-legacy-agent-settings`
 * under `ROUBO_E2E=1`. The block is the one signal that an install is an
 * upgrade, and nothing in the product ever writes it: it is a residue of a build
 * that predates the agent plugins. So the "existing user upgrades" journey
 * (AP-TC-102) has no other way to reach its own precondition, and a spec cannot
 * write `settings.json` itself without knowing the key, which would be a second
 * place naming it.
 *
 * It lives here, beside `readLegacyAgentSettings`, precisely so it does not
 * become that second place: `LEGACY_AGENT_SETTINGS_KEY` stays named exactly once
 * (AP-NFR-006). `null` removes the block, which is what lets the journey hand
 * the environment back as a fresh install (NFR-018).
 */
export function writeLegacyAgentSettings(block: Record<string, unknown> | null): void {
  ensureDirs();
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // A corrupt settings file is replaced rather than merged into: the seam's
      // job is to leave the block in a known state, not to salvage the rest.
      raw = {};
    }
  }
  // Rebuilt by omission rather than with `delete`, which the lint rules forbid
  // on a computed key: the block is the only key this seam owns, so dropping it
  // from a filtered copy is exactly equivalent and keeps the rest untouched.
  const next = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== LEGACY_AGENT_SETTINGS_KEY),
  );
  atomicWrite(
    SETTINGS_FILE,
    JSON.stringify(
      block === null ? next : { ...next, [LEGACY_AGENT_SETTINGS_KEY]: block },
      null,
      2,
    ),
  );
}

export function getPersistedBenches(projectId?: string): PersistedBench[] {
  const data = loadState();
  if (projectId) {
    return data.benches.filter((b) => b.projectId === projectId);
  }
  return data.benches;
}

function resolvePermissionsPath(projectId: string): string {
  // Regex-validate projectId so CodeQL recognises a sanitizer barrier on the
  // tainted segment, then re-confine via resolveWithin (path.relative shape).
  assertSafeIdentifier(projectId, PROJECT_ID_RE, "projectId");
  return resolveWithin(PERMISSIONS_DIR, `${projectId}.json`);
}

export function getProjectPermissions(projectId: string): ProjectPermissions {
  const filePath = resolvePermissionsPath(projectId);
  if (!fs.existsSync(filePath)) {
    return { allow: [], deny: [], ask: [] };
  }
  try {
    const data: Partial<ProjectPermissions> = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      allow: data.allow ?? [],
      deny: data.deny ?? [],
      ask: data.ask ?? [],
      // A file written before the posture axis existed simply carries none, and
      // no posture means the agent keeps whatever mode its own config selected.
      ...(data.posture !== undefined && { posture: data.posture }),
    };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}

export function setProjectPermissions(projectId: string, permissions: ProjectPermissions): void {
  const filePath = resolvePermissionsPath(projectId);
  fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
  atomicWrite(filePath, JSON.stringify(permissions, null, 2));
}
