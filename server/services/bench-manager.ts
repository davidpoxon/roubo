import fs from "node:fs";
import path from "node:path";
import type {
  AuditEntry,
  Bench,
  BenchStatus,
  BrokerContext,
  BrokerPermissionCategory,
  ComponentLogLine,
  ComponentStatus,
  ComponentConfig,
  ComponentPhase,
  ProvisioningStep,
  ProvisioningStepStatus,
  RegisteredProject,
  RouboConfig,
} from "@roubo/shared";
import { COMPONENT_STEP_PREFIX, declaredCategories } from "@roubo/shared";
import type { PermissionCategory } from "@roubo/shared";
import * as projectRegistry from "./project-registry.js";
import * as stateService from "./state.js";
import * as dockerService from "./docker.js";
import type { ContainerStatus } from "./docker.js";
import * as processManager from "./process-manager.js";
import * as ledger from "./resource-ownership-ledger.js";
import * as pluginManager from "./plugin-manager.js";
import { resolveBinding, isNotBound, type NotBound } from "./component-plugin-registry.js";
import { runDescriptor, type LifecycleContext } from "./lifecycle-engine.js";
import type { ProvisionDescriptor } from "@roubo/shared/provision-descriptor-schema";
import * as componentLogStore from "./component-log-store.js";
import { AuditLog } from "./audit-log.js";
import * as terminalService from "./terminal.js";
import * as notificationService from "./notification.js";
import * as sseService from "./sse.js";
import { allocatePorts } from "./port-allocator.js";
import {
  buildTemplateContext,
  resolveTemplate,
  resolveServiceEnv,
  type ResolvedTemplateContext,
} from "./config-parser.js";
import { runCommand, parseCommand } from "./exec.js";
import { assertSafeWorkspacePath, UnsafePathError } from "../lib/safe-path.js";
import { resolveFocusedSpec } from "../lib/testbench-spec-discovery.js";
import { isBenchOperable, benchNotOperableMessage } from "./bench-operability.js";
import { injectPermissions } from "./claude-settings-local.js";
import {
  resolveDefaultBranch,
  resolveHeadBranch,
  parseGitmodulesWithBranch,
} from "./git-helpers.js";

export const RESOLVE_DEFAULT_BRANCH_PHASE = "Resolving default branch";
const benches = new Map<string, Bench>();

// Guards the one-warning-per-process-load contract for a corrupt settings.json
// when the global bench cap is evaluated (NFR-004). Reset only on process restart.
let corruptedSettingsWarned = false;

// Reads the application-wide bench cap from settings.json. Returns null (unlimited)
// when the cap is absent, null, malformed, or unreadable. On a corrupt settings.json
// it fails open and warns at most once per process load. Performs exactly one
// loadSettings call (a single fs read) so it adds no extra I/O to the create path.
function readGlobalBenchCap(): number | null {
  let settings;
  try {
    settings = stateService.loadSettings({ throwOnCorrupt: true });
  } catch {
    if (!corruptedSettingsWarned) {
      console.warn(
        "[bench-manager] settings.json unreadable; treating global bench limit as unlimited.",
      );
      corruptedSettingsWarned = true;
    }
    return null;
  }
  const max = settings.benches?.maxGlobal;
  return typeof max === "number" && Number.isInteger(max) && max >= 1 ? max : null;
}

/**
 * Whether a component declares a one-time `setup` step, read from the opaque
 * plugin-config block (where the bundled process plugin carries it) rather than
 * a legacy top-level field. This is the only field core consults to seed the
 * initial `setupComplete` flag; it is not a component-type literal or a
 * docker-field branch (#612, NFR-006). The engine owns actually running setup.
 */
function componentHasSetup(componentConfig: ComponentConfig | undefined): boolean {
  // Prefer the opaque plugin config (the post-migration home of `setup`); fall
  // back to the legacy top-level field still present on pre-migration configs
  // (#609 transition shim, migrated by #614). Either being a non-empty string
  // means the component declares a one-time setup the engine will run once.
  const setup = componentConfig?.config?.setup ?? componentConfig?.setup;
  return typeof setup === "string" && setup.trim().length > 0;
}

function resolveComponentOrder(components: Record<string, ComponentConfig>): string[] {
  const names = Object.keys(components);
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(name: string, ancestors: Set<string>) {
    if (visited.has(name)) return;
    if (ancestors.has(name)) {
      console.warn(
        `roubo: circular dependency detected in dependsOn for component '${name}', breaking cycle`,
      );
      return;
    }
    ancestors.add(name);
    for (const dep of components[name]?.dependsOn ?? []) {
      if (names.includes(dep)) visit(dep, ancestors);
    }
    ancestors.delete(name);
    visited.add(name);
    order.push(name);
  }

  for (const name of names) visit(name, new Set());
  return order;
}

function getComponentOrder(components: Record<string, ComponentConfig>): string[] {
  const hasDependsOn = Object.values(components).some((s) => s.dependsOn?.length);
  if (hasDependsOn) return resolveComponentOrder(components);

  // Fallback: hardcoded order for configs without dependsOn
  const defaultOrder = ["app", "backend", "frontend"];
  const componentNames = Object.keys(components);
  const known = defaultOrder.filter((n) => componentNames.includes(n));
  const remaining = componentNames.filter((n) => !known.includes(n));
  return [...known, ...remaining];
}

function benchKey(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

function processId(projectId: string, benchId: number, component: string): string {
  return `${projectId}-bench-${benchId}-${component}`;
}

export function initialize() {
  const persisted = stateService.loadState();
  for (const ps of persisted.benches) {
    // workspacePath is read back from ~/.roubo/state.json (untrusted on disk) and
    // later flows into the executable position of spawn() via {{workspace}} command
    // substitution, so it must clear the allowlist barrier before it enters the live
    // bench model (CodeQL #31, js/command-line-injection). A value that fails the
    // allowlist is tampered, corrupt, or rooted at a home directory containing a
    // character outside the allowlist. We cannot safely manage such a bench, but
    // silently dropping it would orphan its worktree with no trace in the UI. Instead
    // load it in an error state with a blank workspacePath: the bench stays visible
    // and clearable, and the tainted value never reaches a spawn/git/fs sink.
    let safeWorkspacePath = "";
    let workspacePathError: string | undefined;
    try {
      safeWorkspacePath = assertSafeWorkspacePath(ps.workspacePath);
    } catch (err) {
      if (!(err instanceof UnsafePathError)) throw err;
      workspacePathError =
        "Persisted workspace path failed the safe-path allowlist; clear this bench to remove it.";
      console.warn(
        `Bench ${ps.projectId}:${ps.id} loaded in error state: unsafe persisted workspace path (${err.message})`,
      );
    }

    const project = projectRegistry.getProject(ps.projectId);
    const components: Record<string, ComponentStatus> = {};

    if (project?.config) {
      // Legacy benches (pre-#538) have no componentSetupState at all: those
      // were created under the old full-provisioning flow, so setup ran.
      // Coerce every component to setupComplete: true for that whole bench.
      // When componentSetupState is present but lacks an entry for a specific
      // component, the component was added to roubo.yaml after the bench was
      // created, so fall back to the same default createBench applies: !setup.
      const isLegacy = ps.componentSetupState === undefined;
      for (const [name, componentConfig] of Object.entries(project.config.components)) {
        const persistedFlag = ps.componentSetupState?.[name];
        const setupComplete = isLegacy
          ? true
          : (persistedFlag ?? (componentHasSetup(componentConfig) ? false : true));
        components[name] = { name, status: "stopped", setupComplete };
      }
    }

    const bench: Bench = {
      id: ps.id,
      projectId: ps.projectId,
      branch: ps.branch,
      workspacePath: safeWorkspacePath,
      status: workspacePathError ? "error" : "idle",
      error: workspacePathError,
      ports: ps.ports,
      components,
      createdAt: ps.createdAt,
      provisioningSteps: [],
      teardownSteps: [],
      notifications: ps.notifications ?? [],
      assignedContainers: ps.assignedContainers,
      assignedIssue: ps.assignedIssue,
      baseBranch: ps.baseBranch,
      baseCommit: ps.baseCommit,
      injectedJigId: ps.injectedJigId,
      injectedJigSource: ps.injectedJigSource,
      variant: ps.variant,
      focusedSpecPath: ps.focusedSpecPath,
    };

    benches.set(benchKey(ps.projectId, ps.id), bench);
  }
}

export async function reconcile() {
  // Collect docker queries across all benches for a single batched API call
  const dockerQueries: Array<{ projectName: string; service: string }> = [];
  const validBenches: Bench[] = [];
  const workspaceCache = new Map<string, string>();

  for (const bench of benches.values()) {
    // Non-operable benches (blank workspacePath, see bench-operability.ts) already
    // carry their own error state and have no workspace to reconcile: leave them
    // untouched.
    if (!isBenchOperable(bench)) {
      continue;
    }
    if (!fs.existsSync(bench.workspacePath)) {
      bench.status = "error";
      bench.error = "Workspace directory not found";
      continue;
    }

    const project = projectRegistry.getProject(bench.projectId);
    if (!project?.config) continue;

    // Verify git actually tracks this worktree (directory may exist but be orphaned)
    if (!workspaceCache.has(project.repoPath)) {
      const wtCheck = await execGit(["worktree", "list", "--porcelain"], project.repoPath);
      workspaceCache.set(project.repoPath, wtCheck.code === 0 ? wtCheck.stdout : "");
    }
    const wtOutput = workspaceCache.get(project.repoPath) ?? "";
    if (wtOutput && !wtOutput.includes(bench.workspacePath)) {
      bench.status = "error";
      bench.error =
        "Worktree directory exists but is not tracked by git: use Cleanup & Retry to fix";
      continue;
    }

    validBenches.push(bench);
    for (const name of Object.keys(project.config.components)) {
      const descriptor = await getOrResolveDescriptor(bench.projectId, bench.id, name);
      if (descriptor?.kind === "docker") {
        dockerQueries.push({
          projectName: dockerService.getComposeProjectName(bench.projectId, bench.id),
          service: descriptor.service,
        });
      }
    }
  }

  const containerStatuses =
    dockerQueries.length > 0
      ? await dockerService.getContainerStatuses(dockerQueries)
      : new Map<string, ContainerStatus>();

  for (const bench of validBenches) {
    const project = projectRegistry.getProject(bench.projectId);
    if (!project?.config) continue;

    // Reconcile from live HOST state (container / process), never by polling the
    // plugin over IPC (NFR-002). The cached descriptor tells core which host
    // resource backs each component, with no config docker-field read.
    for (const name of Object.keys(project.config.components)) {
      const descriptor = componentDescriptors.get(
        descriptorKindKey(bench.projectId, bench.id, name),
      );
      const binding = resolveBinding(bench.projectId, name);
      const pluginId = isNotBound(binding) ? undefined : binding.pluginId;
      if (descriptor?.kind === "docker") {
        const projectName = dockerService.getComposeProjectName(bench.projectId, bench.id);
        const containerStatus =
          containerStatuses.get(`${projectName}/${descriptor.service}`) ?? "not_found";
        const newStatus =
          containerStatus === "running"
            ? "running"
            : containerStatus === "starting"
              ? "starting"
              : ("stopped" as const);
        if (bench.components[name]) {
          bench.components[name].status = newStatus;
        } else {
          bench.components[name] = { name, status: newStatus, setupComplete: true };
        }
      } else if (pluginId) {
        const pid = `${pluginId}:${bench.id}:${name}`;
        const procStatus = processManager.getProcessStatus(pid);
        if (procStatus.alive) {
          if (bench.components[name]) {
            bench.components[name].status = "running";
            bench.components[name].pid = processManager.getProcessPid(pid);
          } else {
            bench.components[name] = {
              name,
              status: "running",
              pid: processManager.getProcessPid(pid),
              setupComplete: true,
            };
          }
        }
      }
    }

    updateBenchStatus(bench);
  }
}

function findNextBenchNumber(projectId: string, maxBenches: number): number | null {
  const usedIds = new Set<number>();
  for (const bench of benches.values()) {
    if (bench.projectId === projectId) {
      usedIds.add(bench.id);
    }
  }
  for (let i = 1; i <= maxBenches; i++) {
    if (!usedIds.has(i)) return i;
  }
  return null;
}

function execGit(args: string[], cwd: string) {
  return runCommand("git", args, cwd);
}

async function execGitChecked(
  args: string[],
  cwd: string,
  ctx: { benchId: number; workspacePath: string },
): Promise<void> {
  const result = await runCommand("git", args, cwd);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    console.error(
      `[bench-manager] Git command failed for bench ${ctx.benchId} ` +
        `at ${ctx.workspacePath}: git ${args.join(" ")}: ${detail}`,
    );
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function extractFailingSubmodulePath(stderr: string): string | null {
  const match = stderr.match(/submodule path '([^']+)'/);
  return match ? match[1] : null;
}

function makeComponentOnlyProvisioningSteps(componentOrder: string[]): ProvisioningStep[] {
  return componentOrder.map((name) => ({
    id: `${COMPONENT_STEP_PREFIX}${name}`,
    label: `Starting ${name}`,
    status: "pending" as ProvisioningStepStatus,
  }));
}

function makeStartProvisioningSteps(
  config: RouboConfig,
  componentOrder: string[],
): ProvisioningStep[] {
  const steps: ProvisioningStep[] = [];
  if (config.benches.setup) {
    steps.push({ id: "bench-setup", label: "Running bench setup", status: "pending" });
  }
  steps.push(...makeComponentOnlyProvisioningSteps(componentOrder));
  return steps;
}

function hasStep(steps: ProvisioningStep[], id: string): boolean {
  return steps.some((s) => s.id === id);
}

function makeWorktreeProvisioningSteps(
  isMetaRepo: boolean,
  branchFromDefault: boolean,
): ProvisioningStep[] {
  const workspaceStep: ProvisioningStep = {
    id: "workspace",
    label: "Creating workspace",
    status: "pending",
  };
  const phases: ComponentPhase[] = [];
  if (branchFromDefault) {
    phases.push({ label: RESOLVE_DEFAULT_BRANCH_PHASE, status: "pending" });
  }
  if (isMetaRepo) {
    phases.push({ label: "Initializing submodules", status: "pending" });
  }
  if (phases.length > 0) {
    workspaceStep.phases = phases;
  }
  return [workspaceStep];
}

function updateStep(
  steps: ProvisioningStep[],
  id: string,
  status: ProvisioningStepStatus,
  error?: string,
): void {
  const step = steps.find((s) => s.id === id);
  if (step) {
    step.status = status;
    if (error !== undefined) step.error = error;
  }
}

function extractWorkspacePermissions(projectId: string, workspacePath: string): void {
  try {
    const filePath = path.join(workspacePath, ".claude", "settings.local.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const permissions = (parsed as Record<string, unknown>).permissions;
    if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions))
      return;
    const permsRecord = permissions as Record<string, unknown>;

    const extractStrings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
    const extractedAllow = extractStrings(permsRecord.allow);
    const extractedDeny = extractStrings(permsRecord.deny);
    const extractedAsk = extractStrings(permsRecord.ask);
    if (extractedAllow.length === 0 && extractedDeny.length === 0 && extractedAsk.length === 0)
      return;

    const existing = stateService.getProjectPermissions(projectId);
    stateService.setProjectPermissions(projectId, {
      allow: [...new Set([...existing.allow, ...extractedAllow])],
      deny: [...new Set([...existing.deny, ...extractedDeny])],
      ask: [...new Set([...(existing.ask ?? []), ...extractedAsk])],
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && !(err instanceof SyntaxError)) {
      console.warn("[bench-manager] extractWorkspacePermissions failed:", err);
    }
  }
}

function makeTeardownSteps(
  components: Record<string, ComponentConfig>,
  hasDockerComponents: boolean,
  removeWorkspace: boolean,
): ProvisioningStep[] {
  const steps: ProvisioningStep[] = [
    { id: "terminals", label: "Closing terminals", status: "pending" },
  ];
  // Core no longer knows which components are docker-backed (#612), so the
  // process-stop step is shown whenever the bench has any components: stopping a
  // component's engine-spawned process is a no-op when none exists, and a
  // docker-backed component is additionally torn down by the docker-down step.
  if (Object.keys(components).length > 0) {
    steps.push({
      id: "stop-components",
      label: "Stopping components",
      status: "pending",
    });
  }
  if (hasDockerComponents) {
    steps.push({
      id: "docker-down",
      label: "Stopping containers",
      status: "pending",
    });
  }
  steps.push({
    id: "save-permissions",
    label: "Saving permissions",
    status: "pending",
  });
  if (removeWorkspace) {
    steps.push({
      id: "remove-workspace",
      label: "Removing workspace",
      status: "pending",
    });
  }
  steps.push({ id: "cleanup", label: "Cleaning up", status: "pending" });
  return steps;
}

/**
 * True while a bench is still tracked in the in-memory map. Goes false the moment
 * teardown calls `benches.delete` (right after it removes the bench from state.json),
 * so background writers can gate their persists on it to avoid resurrecting a bench
 * that was cleared mid-flight. See issue-assignment guarded writes.
 */
export function isBenchLive(projectId: string, benchId: number): boolean {
  return benches.has(benchKey(projectId, benchId));
}

export interface CreateBenchOptions {
  // TestBench variant discriminator. When "testbench", focusedSpecPath is
  // required and validated for containment before the bench is reserved.
  variant?: "testbench";
  // Absolute (or repo-relative) path to the spec's test-cases.json the TestBench
  // focuses on. Validated against the project repo via resolveFocusedSpec; an
  // out-of-repo or malformed path throws BenchError("INVALID_FOCUS").
  focusedSpecPath?: string;
}

export function createBench(
  projectId: string,
  branch?: string,
  options: CreateBenchOptions = {},
): Bench {
  const project = projectRegistry.getProject(projectId);
  if (!project || !project.configValid || !project.config) {
    throw new BenchError(
      `Project '${projectId}' not found or has invalid config`,
      "PROJECT_NOT_FOUND",
    );
  }

  // TestBench variant: require + validate the focused spec path before any bench
  // slot is reserved, so a bad path fails fast with no side effects. The resolved
  // absolute path is what we persist (laundered through the containment barrier).
  let resolvedFocusedSpecPath: string | undefined;
  if (options.variant === "testbench") {
    if (options.focusedSpecPath === undefined) {
      throw new BenchError("focusedSpecPath is required for a testbench variant", "INVALID_FOCUS");
    }
    try {
      resolvedFocusedSpecPath = resolveFocusedSpec(
        project.repoPath,
        options.focusedSpecPath,
      ).resolvedPath;
    } catch (err) {
      throw new BenchError(`Invalid focusedSpecPath: ${(err as Error).message}`, "INVALID_FOCUS");
    }
  }

  const config = project.config;
  // No `await` between findNextBenchNumber and benches.set: this guarantees atomic
  // bench reservation in Node.js single-threaded event loop. Do not add async
  // operations between here and the benches.set() call below.
  const benchNumber = findNextBenchNumber(projectId, config.benches.max);
  if (benchNumber === null) {
    throw new BenchError(
      `No available benches for '${projectId}' (max: ${config.benches.max})`,
      "NO_BENCHES",
    );
  }

  // Application-wide cap, on top of the per-Project cap above (which takes
  // precedence when tighter). Every Map entry counts, including in-flight
  // `preparing` and failed `error` benches, because the cap governs host load,
  // not just healthy benches. This stays inside the synchronous reservation
  // block so a parallel create observes an already-reserved slot.
  const maxGlobal = readGlobalBenchCap();
  if (maxGlobal !== null && benches.size >= maxGlobal) {
    throw new BenchError(
      `Global bench limit reached: ${benches.size} of ${maxGlobal} benches in use.`,
      "GLOBAL_CAP_REACHED",
    );
  }

  const ports = allocatePorts(config, benchNumber);
  const workspacePath = stateService.getWorkspacePath(config.project.name, benchNumber, branch);
  const branchName = branch ?? `bench-${benchNumber}`;
  const isMetaRepo = config.layout.type === "meta-repo" && !!config.layout.submodules;

  const components: Record<string, ComponentStatus> = {};
  for (const [name, componentConfig] of Object.entries(config.components)) {
    components[name] = {
      name,
      status: "stopped",
      setupComplete: !componentHasSetup(componentConfig),
    };
  }

  const bench: Bench = {
    id: benchNumber,
    projectId,
    branch: branchName,
    workspacePath: workspacePath,
    status: "preparing",
    ports,
    components,
    createdAt: new Date().toISOString(),
    provisioningSteps: makeWorktreeProvisioningSteps(
      isMetaRepo,
      project.settings.worktreeSource.branchFromDefault,
    ),
    teardownSteps: [],
    notifications: [],
    variant: options.variant,
    focusedSpecPath: resolvedFocusedSpecPath,
  };

  benches.set(benchKey(projectId, benchNumber), bench);
  void runCreateBenchBackground(bench, project);
  return bench;
}

function markBackgroundError(bench: Bench, err: Error): void {
  bench.status = "error";
  bench.error = err.message;
  const failedStep = bench.provisioningSteps.find((s) => s.status === "running");
  if (failedStep) {
    failedStep.status = "error";
    failedStep.error = err.message;
  }
}

async function runComponentsInOrder(
  bench: Bench,
  componentOrder: string[],
  config?: RouboConfig,
): Promise<void> {
  // Bench-level setup (e.g. `npm ci` at the monorepo root). Gated on the
  // `bench-setup` step being seeded onto bench.provisioningSteps, which only
  // happens on bench-level Start. Per-component Start never seeds it.
  if (config?.benches.setup && hasStep(bench.provisioningSteps, "bench-setup")) {
    if (!isBenchLive(bench.projectId, bench.id)) return;
    updateStep(bench.provisioningSteps, "bench-setup", "running");
    const setupParts = parseCommand(config.benches.setup);
    const result = await runCommand(
      setupParts[0],
      setupParts.slice(1),
      bench.workspacePath,
      undefined,
      600_000,
    );
    processManager.storeCommandLogs(
      `${bench.projectId}:${bench.id}:bench-setup`,
      result.stdout,
      result.stderr,
    );
    if (result.code !== 0) {
      const errorMsg = result.stderr || `Bench setup failed with exit code ${result.code}`;
      updateStep(bench.provisioningSteps, "bench-setup", "error", errorMsg);
      bench.status = "error";
      bench.error = `Bench setup failed: ${errorMsg}`;
      return;
    }
    updateStep(bench.provisioningSteps, "bench-setup", "done");
  }

  for (const name of componentOrder) {
    // Guard inline as the first loop statement, not just in the route-facing
    // callers. The user-controlled name reaches this loop via startComponent as
    // [name], and the bench.components[name] lookup plus the componentStatus.*
    // assignments below would mutate Object.prototype for a '__proto__'/
    // 'constructor'/'prototype' value. The check must be inline here so CodeQL
    // sees it dominate every sink in the loop body.
    if (PROTOTYPE_POLLUTING_KEYS.includes(name)) {
      throw new BenchError(`Invalid component name '${name}'`, "INVALID_COMPONENT");
    }

    if (!isBenchLive(bench.projectId, bench.id)) return;

    const componentStatus = bench.components[name];
    updateStep(bench.provisioningSteps, `${COMPONENT_STEP_PREFIX}${name}`, "running");

    // The plugin's LifecycleEngine owns one-time setup and phase reporting now
    // (#612); core no longer reads legacy setup/docker fields here. The engine
    // pushes phases through reportStatus into componentStatus.
    componentStatus.phases = [];

    await launchComponent(bench.projectId, bench.id, name);

    // Re-read the live status: the engine's reportStatus sink replaces the
    // bench.components[name] object, so the captured reference is now stale.
    const launched = bench.components[name];
    if (launched?.status === "error") {
      updateStep(
        bench.provisioningSteps,
        `${COMPONENT_STEP_PREFIX}${name}`,
        "error",
        launched.error,
      );
      bench.status = "error";
      bench.error = `Component '${name}' failed to start: ${launched.error ?? "unknown error"}`;
      return;
    }
    updateStep(bench.provisioningSteps, `${COMPONENT_STEP_PREFIX}${name}`, "done");
  }

  bench.status = "idle";
  updateBenchStatus(bench);
}

async function runWorktreeProvisioning(bench: Bench, project: RegisteredProject): Promise<void> {
  const config = project.config;
  if (!config) return;
  const isMetaRepo = config.layout.type === "meta-repo" && !!config.layout.submodules;

  try {
    if (!isBenchLive(bench.projectId, bench.id)) return;
    updateStep(bench.provisioningSteps, "workspace", "running");

    // workspace step is always present: makeWorktreeProvisioningSteps guarantees it as steps[0]
    const workspaceStep =
      bench.provisioningSteps.find((s) => s.id === "workspace") ?? bench.provisioningSteps[0];
    const { branchFromDefault, pullLatest } = project.settings.worktreeSource;

    // R1: resolve the default branch up front so both the worktree add and R2
    // (fetch/ff) can use it. When R1 is off, sourceBranch stays undefined.
    let sourceBranch: string | undefined;
    if (branchFromDefault) {
      // resolvePhase is guaranteed to exist here: makeWorktreeProvisioningSteps always seeds
      // the RESOLVE_DEFAULT_BRANCH_PHASE phase when branchFromDefault=true.
      const resolvePhase = workspaceStep.phases?.find(
        (p) => p.label === RESOLVE_DEFAULT_BRANCH_PHASE,
      );
      if (resolvePhase) resolvePhase.status = "running";
      try {
        sourceBranch = await resolveDefaultBranch(project.repoPath);
      } catch (err) {
        if (resolvePhase) resolvePhase.status = "error";
        throw err;
      }
      if (resolvePhase) resolvePhase.status = "done";
    }

    // Capture the source branch for display in the bench detail view. When R1 is
    // on, sourceBranch was already resolved above; when R1 is off, resolve the
    // current HEAD branch of the source repo. Failure (e.g. detached HEAD) is
    // non-fatal: baseBranch stays undefined rather than aborting provisioning.
    let headBranch: string | undefined = sourceBranch;
    if (!headBranch) {
      try {
        headBranch = await resolveHeadBranch(project.repoPath);
      } catch {
        console.warn(`[bench-manager] Could not resolve base branch for bench ${bench.id}`);
      }
    }
    bench.baseBranch = headBranch;
    if (!isBenchLive(bench.projectId, bench.id) || bench.status === "clearing") return;

    // R2: fetch + fast-forward before creating the worktree
    if (pullLatest) {
      // For R1=off R2=on, headBranch may be undefined if resolveHeadBranch failed
      // above; re-resolve so that a missing branch name correctly aborts the fetch.
      const pullBranch = headBranch ?? (await resolveHeadBranch(project.repoPath));
      const fetchPhase: ComponentPhase = {
        label: `Fetching origin/${pullBranch}`,
        status: "running",
      };
      const ffPhase: ComponentPhase = {
        label: `Fast-forwarding ${pullBranch}`,
        status: "pending",
      };
      const subRemotePhase: ComponentPhase | null = isMetaRepo
        ? { label: "Updating submodules to latest", status: "pending" }
        : null;
      // Insert fetch/ff (and submodule-remote for meta-repos) after "Resolving default branch"
      // (if present) and before any trailing phases like "Initializing submodules", matching
      // actual execution order.
      const existing = workspaceStep.phases ?? [];
      const insertAfter = existing.findIndex((p) => p.label === RESOLVE_DEFAULT_BRANCH_PHASE);
      const insertAt = insertAfter >= 0 ? insertAfter + 1 : 0;
      const newPhases: ComponentPhase[] = [
        fetchPhase,
        ffPhase,
        ...(subRemotePhase ? [subRemotePhase] : []),
      ];
      workspaceStep.phases = [
        ...existing.slice(0, insertAt),
        ...newPhases,
        ...existing.slice(insertAt),
      ];

      const fetchResult = await runCommand(
        "git",
        ["fetch", "origin", pullBranch],
        project.repoPath,
        undefined,
        60_000,
      );
      if (fetchResult.code !== 0) {
        fetchPhase.status = "error";
        throw new Error(
          `Failed to fetch 'origin/${pullBranch}': ${fetchResult.stderr.trim() || "git fetch exited non-zero"}. ` +
            `Check your network connection and origin remote, or disable 'Pull latest' in project settings.`,
        );
      }
      fetchPhase.status = "done";

      ffPhase.status = "running";
      const ffResult = await runCommand(
        "git",
        ["merge", "--ff-only", `origin/${pullBranch}`],
        project.repoPath,
        undefined,
        60_000,
      );
      if (ffResult.code !== 0) {
        ffPhase.status = "error";
        throw new Error(
          `Could not fast-forward '${pullBranch}': your local branch has diverged from origin/${pullBranch}. ` +
            `Resolve manually in the source repo, or disable 'Pull latest' in project settings.`,
        );
      }
      ffPhase.status = "done";

      if (subRemotePhase) {
        subRemotePhase.status = "running";
        const subResult = await runCommand(
          "git",
          ["submodule", "update", "--init", "--remote", "--recursive"],
          project.repoPath,
          undefined,
          300_000,
        );
        if (subResult.code !== 0) {
          subRemotePhase.status = "error";
          const failingSubmodule = extractFailingSubmodulePath(subResult.stderr);
          const detail =
            subResult.stderr
              .split("\n")
              .map((l) => l.trim())
              .find(Boolean) ?? `exit code ${subResult.code}`;
          const subjectClause = failingSubmodule
            ? `submodule '${failingSubmodule}'`
            : "a submodule";
          throw new Error(
            `Failed to update ${subjectClause} to latest: ${detail}. ` +
              `Resolve manually in the source repo, or disable 'Pull latest' in project settings.`,
          );
        }
        subRemotePhase.status = "done";
      }
    }

    fs.mkdirSync(path.dirname(bench.workspacePath), { recursive: true });

    // Pre-flight: clean up any stale worktree directory left behind by a previous
    // failed or interrupted teardown. Without this, `git worktree add` fails with
    // "fatal: '<path>' already exists" even on a clean repo.
    if (fs.existsSync(bench.workspacePath)) {
      const removeResult = await execGit(
        ["worktree", "remove", "--force", bench.workspacePath],
        project.repoPath,
      );
      if (removeResult.code !== 0) {
        const detail = removeResult.stderr.trim() || `exit code ${removeResult.code}`;
        console.debug(
          `[bench-manager] Pre-flight worktree remove failed for bench ${bench.id} ` +
            `at ${bench.workspacePath}: ${detail}, will attempt rmSync fallback`,
        );
      }
      fs.rmSync(bench.workspacePath, { recursive: true, force: true });
    }

    // R1: pass the resolved branch as the base for the new worktree branch so
    // the bench starts from the default branch rather than the current HEAD.
    // The retry path (branch already exists) uses `git worktree add <path> <branch>`
    // without -b, so it cannot take a base argument: it stays unchanged.
    const wtArgs = sourceBranch
      ? ["worktree", "add", bench.workspacePath, "-b", bench.branch, sourceBranch]
      : ["worktree", "add", bench.workspacePath, "-b", bench.branch];
    const wtResult = await execGit(wtArgs, project.repoPath);
    if (wtResult.code !== 0) {
      const wtRetry = await execGit(
        ["worktree", "add", bench.workspacePath, bench.branch],
        project.repoPath,
      );
      if (wtRetry.code !== 0) {
        throw new Error(`Failed to create workspace: ${wtRetry.stderr}`);
      }
    }
    // Capture the short SHA of the initial HEAD in the new worktree so it can be
    // displayed in the bench detail view ("Branched from <branch> @ <sha>").
    const revParseResult = await execGit(["rev-parse", "HEAD"], bench.workspacePath);
    if (revParseResult.code === 0) {
      bench.baseCommit = revParseResult.stdout.trim().slice(0, 7);
    } else {
      console.warn(
        `[bench-manager] Could not resolve base commit for bench ${bench.id}: ${revParseResult.stderr.trim()}`,
      );
    }

    // Validate and initialize submodules (meta-repo only)
    const declaredSubmodules = isMetaRepo ? (config.layout.submodules ?? {}) : {};
    if (isMetaRepo) {
      // Validate that all submodules declared in roubo.yaml exist in .gitmodules.
      // A missing entry is a fatal provisioning error: the bench must not half-initialize.
      const gitmodulesPath = path.join(bench.workspacePath, ".gitmodules");
      if (!fs.existsSync(gitmodulesPath)) {
        throw new Error(
          `Meta-repo workspace is missing .gitmodules at ${gitmodulesPath}. ` +
            `Ensure the source repository has a valid .gitmodules file.`,
        );
      }
      const gitmodulesContent = await fs.promises.readFile(gitmodulesPath, "utf-8");
      const parsedMap = parseGitmodulesWithBranch(gitmodulesContent);

      const missing = Object.keys(declaredSubmodules).filter((name) => !parsedMap[name]);
      if (missing.length > 0) {
        throw new Error(
          `Submodule(s) declared in roubo.yaml but missing from .gitmodules: ${missing.join(", ")}. ` +
            `Check that 'layout.submodules' in roubo.yaml matches the [submodule] entries in .gitmodules.`,
        );
      }

      // Validate that each submodule's path in .gitmodules matches the path declared in roubo.yaml.
      // The worktree paths for work units are derived from roubo.yaml: a mismatch would produce
      // paths that don't correspond to actual submodule checkouts.
      for (const [name, relativePath] of Object.entries(declaredSubmodules)) {
        const entry = parsedMap[name];
        if (entry && entry.path !== relativePath) {
          throw new Error(
            `Submodule '${name}': path in .gitmodules ('${entry.path}') does not match ` +
              `roubo.yaml declaration ('${relativePath}'). These must be consistent.`,
          );
        }
      }

      if (!isBenchLive(bench.projectId, bench.id)) return;
      const subPhase = workspaceStep.phases?.find((p) => p.label === "Initializing submodules");
      if (subPhase) subPhase.status = "running";

      const subResult = await execGit(
        ["submodule", "update", "--init", "--recursive"],
        bench.workspacePath,
      );
      if (subResult.code !== 0) {
        console.warn(`Submodule init warning: ${subResult.stderr}`);
        if (subPhase) subPhase.status = "error";
      } else {
        if (subPhase) subPhase.status = "done";
      }
    }

    updateStep(bench.provisioningSteps, "workspace", "done");

    // Persist bench to disk now that workspace exists
    stateService.addBench({
      id: bench.id,
      projectId: bench.projectId,
      branch: bench.branch,
      workspacePath: bench.workspacePath,
      ports: bench.ports,
      createdAt: bench.createdAt,
      notifications: bench.notifications,
      baseBranch: bench.baseBranch,
      baseCommit: bench.baseCommit,
      injectedJigId: bench.injectedJigId,
      injectedJigSource: bench.injectedJigSource,
      variant: bench.variant,
      focusedSpecPath: bench.focusedSpecPath,
    });

    // Inject project-level permissions into the workspace before any sessions start.
    // Failure is non-fatal: the bench can still run without pre-seeded permissions.
    try {
      injectPermissions(bench.workspacePath, stateService.getProjectPermissions(bench.projectId));
    } catch (err) {
      console.warn(`[bench-manager] Failed to inject permissions for bench ${bench.id}:`, err);
    }

    // Worktree-only create: transition out of "preparing" and let the bench sit
    // idle. Bench-level setup, component setup, and component launch all run later
    // via the Start path.
    bench.status = "idle";
    updateBenchStatus(bench);
    sseService.broadcastBenchStatus(bench);
  } catch (err) {
    markBackgroundError(bench, err as Error);

    if (fs.existsSync(bench.workspacePath)) {
      const removeResult = await execGit(
        ["worktree", "remove", "--force", bench.workspacePath],
        project.repoPath,
      );
      if (removeResult.code !== 0) {
        const detail = removeResult.stderr.trim() || `exit code ${removeResult.code}`;
        console.error(
          `[bench-manager] Git command failed for bench ${bench.id} ` +
            `at ${bench.workspacePath}: git worktree remove --force: ${detail}`,
        );
      }
      fs.rmSync(bench.workspacePath, { recursive: true, force: true });
    }
  }

  if (bench.status === "error") {
    notificationService.createNotification(bench, "bench-error");
  }
}

async function runStartAllBackground(
  bench: Bench,
  componentOrder: string[],
  config: RouboConfig,
): Promise<void> {
  // Yield so the caller can return the bench with all steps still 'pending'
  await Promise.resolve();
  try {
    await runComponentsInOrder(bench, componentOrder, config);
  } catch (err) {
    markBackgroundError(bench, err as Error);
  }
}

async function runCreateBenchBackground(bench: Bench, project: RegisteredProject): Promise<void> {
  await runWorktreeProvisioning(bench, project);
  // Bail if worktree provisioning failed or the bench is being torn down: the
  // status here may be "error" (provisioning failed) or "clearing" (teardown
  // started while we were awaiting). Either case means we must not chain into
  // component setup/launch.
  if ((bench.status as BenchStatus) === "error" || (bench.status as BenchStatus) === "clearing") {
    return;
  }

  const settings = stateService.loadSettings();
  if (!(settings.benches?.autoStartComponents ?? false)) return;

  const config = project.config;
  if (!config) return;
  if (!isBenchLive(bench.projectId, bench.id)) return;

  const ordered = getComponentOrder(config.components);
  bench.provisioningSteps = [
    ...bench.provisioningSteps,
    ...makeStartProvisioningSteps(config, ordered),
  ];
  bench.status = "preparing";
  updateBenchStatus(bench);

  try {
    await runComponentsInOrder(bench, ordered, config);
  } catch (err) {
    markBackgroundError(bench, err as Error);
  }

  if ((bench.status as BenchStatus) === "error") {
    notificationService.createNotification(bench, "bench-error");
  }
}

export function teardownBench(projectId: string, benchId: number, removeWorkspace = true): Bench {
  const key = benchKey(projectId, benchId);
  const bench = benches.get(key);
  if (!bench) {
    throw new BenchError(`Bench ${benchId} not found for project '${projectId}'`, "NOT_FOUND");
  }

  // Guard against double teardown: return current state if already in progress
  const hasActiveTeardown =
    bench.teardownSteps.length > 0 && !bench.teardownSteps.some((s) => s.status === "error");
  if (bench.status === "clearing" && hasActiveTeardown) {
    return bench;
  }

  const project = projectRegistry.getProject(projectId);
  const components = project?.config?.components ?? {};
  // Whether any component the engine provisioned this bench is docker-backed,
  // read from the cached descriptors (the plugin's output) rather than a config
  // docker-field (#612, NFR-006). A never-started bench has no descriptors, so
  // its teardown shows no docker-down step, matching prior behaviour for benches
  // that never brought a container up.
  const hasDockerComponents = Object.keys(components).some(
    (name) =>
      componentDescriptors.get(descriptorKindKey(projectId, benchId, name))?.kind === "docker",
  );

  bench.status = "clearing";
  bench.teardownSteps = makeTeardownSteps(components, hasDockerComponents, removeWorkspace);

  // Mark any in-flight provisioning steps as cancelled for UI feedback
  for (const step of bench.provisioningSteps) {
    if (step.status === "running" || step.status === "pending") {
      step.status = "cancelled";
    }
  }

  void runTeardownBackground(bench, project, removeWorkspace);
  return bench;
}

async function runTeardownBackground(
  bench: Bench,
  project: RegisteredProject | undefined,
  removeWorkspace: boolean,
): Promise<void> {
  // Yield so the caller can return the bench with all steps still 'pending'
  await Promise.resolve();

  const { projectId, id: benchId } = bench;
  const key = benchKey(projectId, benchId);

  try {
    // Step 1: Close terminals
    updateStep(bench.teardownSteps, "terminals", "running");
    terminalService.destroyBenchSessions(projectId, benchId);
    updateStep(bench.teardownSteps, "terminals", "done");

    // Step 2: Stop component processes. Core branches on the descriptor KIND the
    // plugin emitted (its output), not a config docker-field (#612): a
    // docker-backed component is left for the docker-down step, every other
    // component's engine-spawned process is stopped.
    if (bench.teardownSteps.some((s) => s.id === "stop-components")) {
      updateStep(bench.teardownSteps, "stop-components", "running");
      for (const name of Object.keys(bench.components)) {
        const descriptor = componentDescriptors.get(descriptorKindKey(projectId, benchId, name));
        if (descriptor?.kind === "docker") continue;
        const binding = resolveBinding(projectId, name);
        if (!isNotBound(binding)) {
          await processManager.stopProcess(`${binding.pluginId}:${benchId}:${name}`);
        }
        await processManager.stopProcess(processId(projectId, benchId, name));
        bench.components[name].status = "stopped";
      }
      updateStep(bench.teardownSteps, "stop-components", "done");
    }

    // Step 3: Docker compose down. Driven by the cached descriptors (the
    // plugin's output) rather than a config docker-field: each docker-backed
    // component's compose file is downed once, scoped to the bench project name.
    if (bench.teardownSteps.some((s) => s.id === "docker-down")) {
      updateStep(bench.teardownSteps, "docker-down", "running");
      const downedComposeFiles = new Set<string>();
      for (const name of Object.keys(bench.components)) {
        const descriptor = componentDescriptors.get(descriptorKindKey(projectId, benchId, name));
        if (descriptor?.kind !== "docker") continue;
        if (!downedComposeFiles.has(descriptor.composeFile)) {
          const projectName = dockerService.getComposeProjectName(projectId, benchId);
          await dockerService.composeDown(projectName, descriptor.composeFile, bench.workspacePath);
          downedComposeFiles.add(descriptor.composeFile);
        }
        if (bench.components[name]) bench.components[name].status = "stopped";
      }
      updateStep(bench.teardownSteps, "docker-down", "done");
    }

    // After the bench's processes and compose projects are stopped, drop its
    // ledger entries (issue #613): the resources are gone, so the startup orphan
    // sweep must not later try to reap them. Scoped to this bench's id across
    // every owning plugin.
    clearLedgerForBench(benchId);

    // Drop this bench's in-memory audit log (#671) so a cleared bench's recorded
    // broker calls do not leak into a later bench that reuses the same id, and
    // drop the per-bench BrokerContext(s) the plugin connection resolved against
    // (#677) for the same reason.
    clearAuditLog(projectId, benchId);
    unregisterBrokerContextsForBench(projectId, benchId);

    // Step 4: Save permissions from workspace before removal
    updateStep(bench.teardownSteps, "save-permissions", "running");
    extractWorkspacePermissions(bench.projectId, bench.workspacePath);
    updateStep(bench.teardownSteps, "save-permissions", "done");

    // Step 5: Remove workspace and branch
    if (removeWorkspace && project) {
      updateStep(bench.teardownSteps, "remove-workspace", "running");

      const wtList = await execGit(["worktree", "list", "--porcelain"], project.repoPath);

      if (wtList.code !== 0) {
        // Can't determine worktree state: fall back to the original forceful path
        // so we don't risk deleting a valid workspace based on stale assumptions.
        await execGitChecked(
          ["worktree", "remove", "--force", bench.workspacePath],
          project.repoPath,
          { benchId, workspacePath: bench.workspacePath },
        );
      } else {
        const isRegistered = wtList.stdout
          .split("\n")
          .some((line) => line === `worktree ${bench.workspacePath}`);
        const existsOnDisk = fs.existsSync(bench.workspacePath);

        if (isRegistered) {
          // Worktree is registered: use 'remove --force' whether or not the directory
          // is present. Git ≥ 2.39 handles the missing-directory case cleanly and only
          // touches this entry (unlike 'prune', which is project-wide).
          await execGitChecked(
            ["worktree", "remove", "--force", bench.workspacePath],
            project.repoPath,
            { benchId, workspacePath: bench.workspacePath },
          );
        } else if (existsOnDisk) {
          // Orphaned directory: not tracked as a worktree but still on disk
          try {
            fs.rmSync(bench.workspacePath, { recursive: true, force: true });
          } catch (err) {
            console.warn(
              `[bench-manager] Could not remove orphaned workspace directory ` +
                `${bench.workspacePath} for bench ${benchId}: ${err}`,
            );
          }
        }
        // else: neither on disk nor registered: nothing to remove
      }

      // Best-effort branch delete: tolerate "branch not found" in case the
      // user already deleted it when they cleaned up the workspace
      const branchResult = await execGit(["branch", "-D", bench.branch], project.repoPath);
      if (branchResult.code !== 0) {
        const detail = branchResult.stderr.trim() || `exit code ${branchResult.code}`;
        if (!/not found|does not exist/i.test(detail)) {
          console.error(
            `[bench-manager] Git command failed for bench ${benchId} ` +
              `at ${bench.workspacePath}: git branch -D ${bench.branch}: ${detail}`,
          );
          throw new Error(`git branch -D ${bench.branch} failed: ${detail}`);
        }
      }

      updateStep(bench.teardownSteps, "remove-workspace", "done");
    }

    // Step 6: Clean up state
    updateStep(bench.teardownSteps, "cleanup", "running");
    stateService.removeBench(projectId, benchId);
    updateStep(bench.teardownSteps, "cleanup", "done");

    // Final removal from memory: after this, GET /bench returns 404
    benches.delete(key);
  } catch (err) {
    const failedStep = bench.teardownSteps.find((s) => s.status === "running");
    if (failedStep) {
      failedStep.status = "error";
      failedStep.error = (err as Error).message;
    }
    bench.error = `Teardown failed: ${(err as Error).message}`;
    bench.status = "error";
    notificationService.createNotification(bench, "bench-error");
  }
}

/**
 * Clears every resource-ownership ledger entry for `benchId`, across all owning
 * plugins (issue #613). The ledger keys on (pluginId, benchId), so a single
 * bench may have entries under several plugins; teardown removes them all once
 * the bench's resources are stopped, so the startup sweep never re-reaps them.
 */
function clearLedgerForBench(benchId: number): void {
  for (const entry of ledger.getAllEntries()) {
    if (entry.benchId === benchId) {
      ledger.clearEntry(entry.pluginId, entry.benchId);
    }
  }
}

/**
 * Pre-restart crash cleanup for a component plugin (issue #613, FR-015).
 *
 * Registered with plugin-manager via `registerComponentPluginHooks` and fired
 * the instant the supervisor sees a `component` plugin exit unexpectedly,
 * before it restarts the plugin (or errors out on an exhausted budget). Reads
 * the ledger for the crashed plugin and stops every process and compose project
 * it owned, then clears those ledger entries so nothing is orphaned and the
 * restart cannot bring up a duplicate container.
 *
 * Scoped strictly to the crashed plugin's own entries: sibling components,
 * supervised by other plugins, are never touched (graceful degradation). Every
 * stop is best-effort; a single failure is logged and the rest still run.
 */
export async function handleComponentPluginPreRestart(pluginId: string): Promise<void> {
  const entries = ledger.getAllEntries().filter((e) => e.pluginId === pluginId);
  for (const entry of entries) {
    for (const processId of entry.processIds) {
      await processManager.stopProcess(processId).catch((err) => {
        console.warn(
          `[bench-manager] pre-restart cleanup: stopProcess(${processId}) failed for ` +
            `plugin '${pluginId}' bench ${entry.benchId}: ${err}`,
        );
      });
    }
    for (const composeProject of entry.composeProjects) {
      await dockerService.composeDownByProject(composeProject).catch((err) => {
        console.warn(
          `[bench-manager] pre-restart cleanup: composeDown(${composeProject}) failed for ` +
            `plugin '${pluginId}' bench ${entry.benchId}: ${err}`,
        );
      });
    }
    ledger.clearEntry(entry.pluginId, entry.benchId);
  }
}

/**
 * Post-restart re-provision for a component plugin (issue #613, FR-016).
 *
 * Registered with plugin-manager and fired once the crashed `component` plugin
 * has been respawned. Re-provisions every bench whose components the plugin was
 * supervising, so the crashed component auto-recovers to running while sibling
 * components keep their existing state. A bench that is no longer present (torn
 * down during the crash window) is skipped.
 */
export async function handleComponentPluginRestarted(pluginId: string): Promise<void> {
  // The pre-restart hook clears the ledger, so re-provision is driven from the
  // live bench model. Auto-recovery (AC4) is scoped per component: re-launch only
  // a component bound to this plugin whose last observed status was `running` or
  // `starting`, so components the user had stopped (or never started) are left
  // untouched. The scope is deliberately per-component, not per-bench: in a
  // degraded bench (a crashed component still `running` alongside a `stopped` or
  // one-shot `completed` sibling) the bench status is `idle`, not `active`, yet
  // the running component must still recover (AC3 graceful degradation). Only
  // `clearing` / `preparing` benches are skipped wholesale, since launching into
  // a teardown or a half-built bench is never right. The pre-restart cleanup
  // stops processes directly (not via the status-setting stop path), so a
  // crashed-but-running component still reads `running` here.
  for (const bench of benches.values()) {
    if (bench.status === "clearing" || bench.status === "preparing") continue;
    const project = projectRegistry.getProject(bench.projectId);
    if (!project?.config) continue;
    for (const [name, componentConfig] of Object.entries(project.config.components)) {
      if (componentConfig.plugin?.id !== pluginId) continue;
      const priorStatus = bench.components[name]?.status;
      if (priorStatus !== "running" && priorStatus !== "starting") continue;
      await launchComponent(bench.projectId, bench.id, name).catch((err) => {
        console.warn(
          `[bench-manager] post-restart re-provision: launchComponent(${name}) failed for ` +
            `plugin '${pluginId}' bench ${bench.id}: ${err}`,
        );
      });
    }
  }
}

/**
 * Startup orphan sweep (issue #613, FR-015 / NFR-003).
 *
 * Run once at boot, before reconcile. Replays the ledger and tears down every
 * compose project it still records: after a hard host kill the host's treeKill
 * never reaped daemonised containers, so the ledger is the authoritative list
 * of what escaped. Each project name matches the `roubo-<projectId>-bench-<N>`
 * convention, so this leaves any non-Roubo compose project on the machine
 * untouched. Ledger-recorded processes are not swept here: their pids died with
 * the host, and process-manager rebuilds its map from a clean slate on restart.
 * After downing a project its ledger entry is cleared so a second boot is a
 * no-op.
 */
export async function sweepOrphanedComposeProjects(): Promise<void> {
  const ROUBO_PROJECT_PREFIX = "roubo-";
  for (const entry of ledger.getAllEntries()) {
    for (const composeProject of entry.composeProjects) {
      // Defence in depth: only ever down a project that matches our own naming
      // convention, so a corrupt or hand-edited ledger entry can never reap an
      // unrelated compose project.
      if (!composeProject.startsWith(ROUBO_PROJECT_PREFIX)) continue;
      await dockerService.composeDownByProject(composeProject).catch((err) => {
        console.warn(
          `[bench-manager] startup sweep: composeDown(${composeProject}) failed for ` +
            `plugin '${entry.pluginId}' bench ${entry.benchId}: ${err}`,
        );
      });
    }
    ledger.clearEntry(entry.pluginId, entry.benchId);
  }
}

export async function cleanupAndRetryBench(projectId: string, benchId: number): Promise<Bench> {
  const key = benchKey(projectId, benchId);
  const bench = benches.get(key);
  if (!bench) {
    throw new BenchError(`Bench ${benchId} not found for project '${projectId}'`, "NOT_FOUND");
  }
  if (!bench.error) {
    throw new BenchError("Bench has no error to clean up", "INVALID_STATE");
  }
  if (!isBenchOperable(bench)) {
    // A non-operable bench (blank workspacePath, see bench-operability.ts) has no
    // usable path to re-provision from, and recomputing it would only regenerate the
    // same rejected path, so retry cannot succeed: the only safe action is to clear it.
    throw new BenchError(benchNotOperableMessage("be retried"), "INVALID_STATE");
  }

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) {
    throw new BenchError(
      `Project '${projectId}' not found or has invalid config`,
      "PROJECT_NOT_FOUND",
    );
  }
  const config = project.config;

  // Clean up stale resources
  terminalService.destroyBenchSessions(projectId, benchId);

  // Stop every component's engine-spawned process (a no-op for docker-backed
  // components); no component-type / docker-field branch in core (#612).
  for (const name of Object.keys(bench.components)) {
    const binding = resolveBinding(projectId, name);
    if (!isNotBound(binding)) {
      await processManager.stopProcess(`${binding.pluginId}:${benchId}:${name}`).catch(() => {});
    }
    await processManager.stopProcess(processId(projectId, benchId, name)).catch(() => {});
  }

  if (fs.existsSync(bench.workspacePath)) {
    const downedComposeFiles = new Set<string>();
    for (const name of Object.keys(config.components)) {
      const descriptor = componentDescriptors.get(descriptorKindKey(projectId, benchId, name));
      if (descriptor?.kind === "docker" && !downedComposeFiles.has(descriptor.composeFile)) {
        const projectName = dockerService.getComposeProjectName(projectId, benchId);
        await dockerService
          .composeDown(projectName, descriptor.composeFile, bench.workspacePath)
          .catch(() => {});
        downedComposeFiles.add(descriptor.composeFile);
      }
    }
  }

  extractWorkspacePermissions(projectId, bench.workspacePath);

  const wtList = await execGit(["worktree", "list", "--porcelain"], project.repoPath);
  if (wtList.code !== 0) {
    // Can't determine worktree state: fall back to the forceful path so we
    // don't risk leaving a registered worktree behind.
    await execGitChecked(["worktree", "remove", "--force", bench.workspacePath], project.repoPath, {
      benchId,
      workspacePath: bench.workspacePath,
    });
  } else {
    const isRegistered = wtList.stdout
      .split("\n")
      .some((line) => line === `worktree ${bench.workspacePath}`);
    const existsOnDisk = fs.existsSync(bench.workspacePath);
    if (isRegistered) {
      await execGitChecked(
        ["worktree", "remove", "--force", bench.workspacePath],
        project.repoPath,
        { benchId, workspacePath: bench.workspacePath },
      );
    } else if (existsOnDisk) {
      try {
        fs.rmSync(bench.workspacePath, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[bench-manager] Could not remove orphaned workspace directory ` +
            `${bench.workspacePath} for bench ${benchId}: ${err}`,
        );
      }
    }
    // else: neither registered nor on disk: nothing to remove
  }

  const pruneResult = await execGit(["worktree", "prune"], project.repoPath);
  if (pruneResult.code !== 0) {
    console.warn(
      `[bench-manager] git worktree prune for bench ${benchId}: ` +
        `${pruneResult.stderr.trim() || `exit code ${pruneResult.code}`}`,
    );
  }
  stateService.removeBench(projectId, benchId);

  // Reset bench state for re-provisioning
  const isMetaRepo = config.layout.type === "meta-repo" && !!config.layout.submodules;

  bench.status = "preparing";
  bench.error = undefined;
  bench.teardownSteps = [];
  bench.provisioningSteps = makeWorktreeProvisioningSteps(
    isMetaRepo,
    project.settings.worktreeSource.branchFromDefault,
  );
  for (const [name, componentConfig] of Object.entries(config.components)) {
    bench.components[name] = {
      name,
      status: "stopped",
      setupComplete: !componentHasSetup(componentConfig),
    };
  }

  void runWorktreeProvisioning(bench, project);
  return bench;
}

/**
 * Per-(bench, component) cache of the ProvisionDescriptor the plugin's
 * `translate` last emitted, keyed by `${projectId}:${benchId}:${componentName}`.
 *
 * The descriptor is the PLUGIN's output (the engine's domain), not a core
 * component-type literal or a docker-FIELD branch: NFR-006 forbids
 * `=== "database"` / `=== "process"` dispatch and `componentConfig.docker` field
 * reads, neither of which reading a cached descriptor is. Stop and reconcile
 * consult it to drive the right teardown / live-state check for a component
 * without re-deriving the shape from config, mirroring how the ledger (not
 * config) already drives crash cleanup. A component the engine has never
 * provisioned this process has no entry; stop then only stops its process id.
 */
const componentDescriptors = new Map<string, ProvisionDescriptor>();

function descriptorKindKey(projectId: string, benchId: number, componentName: string): string {
  return `${projectId}:${benchId}:${componentName}`;
}

/**
 * Recursively resolve template placeholders in the string values of an opaque
 * component config (e.g. a `command` carrying `{{urls.backend}}`), using the
 * bench template context. This is the host's job (it owns ports / the resolved
 * context), done before the plugin's pure translate, so command/value templating
 * matches the built-in path (FR-007). Non-string leaves pass through unchanged.
 */
function resolveConfigTemplates(value: unknown, ctx: ResolvedTemplateContext): unknown {
  if (typeof value === "string") return resolveTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveConfigTemplates(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveConfigTemplates(v, ctx);
    }
    return out;
  }
  return value;
}

/**
 * Resolve a component's ProvisionDescriptor for reconcile, preferring the cache.
 * On a cold start (a bench provisioned in a previous process) the cache is empty,
 * so the descriptor is resolved once via the plugin's pure `translate` and cached.
 * This is a one-time provision-shape resolve, NOT status polling: reconcile reads
 * live status from host container/process state (and pushed reportStatus), never
 * by polling the plugin per cycle, so NFR-002 (no polling IPC) holds. Returns
 * undefined when the component is unbound or translate fails.
 */
async function getOrResolveDescriptor(
  projectId: string,
  benchId: number,
  componentName: string,
): Promise<ProvisionDescriptor | undefined> {
  const cached = componentDescriptors.get(descriptorKindKey(projectId, benchId, componentName));
  if (cached) return cached;

  const binding = resolveBinding(projectId, componentName);
  if (isNotBound(binding)) return undefined;
  const project = projectRegistry.getProject(projectId);
  const bench = getBench(projectId, benchId);
  if (!project?.config || !bench) return undefined;
  const componentConfig = project.config.components[componentName];
  if (!componentConfig) return undefined;

  try {
    const tplCtx = buildTemplateContext(project.config, benchId, bench.workspacePath);
    const ports = tplCtx?.ports ?? bench.ports;
    const resolvedEnv = resolveServiceEnv(
      (componentConfig.config?.env as Record<string, string> | undefined) ?? {},
      tplCtx,
    );
    const raw = await pluginManager.invoke<unknown>(binding.pluginId, "translate", {
      config: componentConfig.config ?? {},
      context: {
        projectId,
        benchId,
        componentName,
        workspacePath: bench.workspacePath,
        ports,
        env: resolvedEnv,
      },
    });
    if (raw && typeof raw === "object" && "kind" in raw) {
      const descriptor = raw as ProvisionDescriptor;
      componentDescriptors.set(descriptorKindKey(projectId, benchId, componentName), descriptor);
      return descriptor;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Human-readable reason a component could not be resolved to a running plugin.
 * A built-in component whose roubo.yaml entry carries no `plugin:` binding
 * resolves to `not-bound`: binding the bundled process/database plugins to the
 * live configs is the config migration of #614 (F1.13), out of scope here, so
 * core surfaces a clear, actionable error rather than silently doing nothing.
 */
function notBoundMessage(componentName: string, nb: NotBound): string {
  switch (nb.reason) {
    case "unknown-project":
      return `Component '${componentName}' could not be resolved: project not registered`;
    case "invalid-config":
      return `Component '${componentName}' could not be resolved: invalid roubo.yaml`;
    case "unknown-component":
      return `Component '${componentName}' is not defined in roubo.yaml`;
    case "not-bound":
      return `Component '${componentName}' has no plugin binding (bind it to a component plugin in roubo.yaml)`;
    case "not-consented":
      return `Component plugin '${nb.pluginId}' has not been consented; acknowledge its permissions before starting '${componentName}'`;
    case "plugin-unavailable":
      return `Component plugin '${nb.pluginId}' is not running; cannot start '${componentName}'`;
  }
}

/**
 * Resolve the component's bound plugin, ask it to `translate` its opaque config
 * into a ProvisionDescriptor, and run that descriptor through the host
 * LifecycleEngine. This is the single delegation seam that replaces the four
 * built-in dispatch sites (#612, FR-006 / FR-009): core carries no component
 * type or docker-field knowledge; the plugin describes and the host owns the
 * lifecycle. Status is pushed through the engine's `reportStatus` sink into
 * `bench.components` (NFR-002, no polling).
 */
async function provisionComponent(
  projectId: string,
  benchId: number,
  componentName: string,
): Promise<void> {
  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError(`Bench not found`, "NOT_FOUND");

  const binding = resolveBinding(projectId, componentName);
  if (isNotBound(binding)) {
    throw new BenchError(notBoundMessage(componentName, binding), "COMPONENT_NOT_BOUND");
  }

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new BenchError(`Project config not found`, "PROJECT_NOT_FOUND");
  const componentConfig = project.config.components[componentName];
  if (!componentConfig)
    throw new BenchError(`Component '${componentName}' not defined`, "COMPONENT_NOT_FOUND");

  const componentStatus = bench.components[componentName];
  if (!componentStatus)
    throw new BenchError(`Component '${componentName}' not found in bench`, "COMPONENT_NOT_FOUND");

  // Mark the component in-flight: `startedAt` is the guard reconcile /
  // refreshComponentStatuses honour to avoid overriding a component while an
  // active start is managing its lifecycle (parity with the built-in path).
  componentStatus.status = "starting";
  componentStatus.startedAt = new Date().toISOString();

  // Resolve the per-bench env (templates filled, e.g. {{ports.x}}) the engine
  // needs in the BenchContext, preserving FR-005/FR-007 env injection parity.
  const tplCtx = buildTemplateContext(project.config, benchId, bench.workspacePath);
  const resolvedEnv = resolveServiceEnv(
    (componentConfig.config?.env as Record<string, string> | undefined) ?? {},
    tplCtx,
  );

  // Resolve `{{ports.x}}` / `{{urls.x}}` / `{{components.x}}` template strings in
  // the opaque config before the plugin's pure translate sees it, preserving the
  // built-in command/value templating parity (FR-007). Resolution is a host
  // concern (the host owns ports), keeping translate pure.
  const resolvedConfig = resolveConfigTemplates(componentConfig.config ?? {}, tplCtx) as Record<
    string,
    unknown
  >;

  // Merge an externally-assigned container into the opaque config so the
  // database plugin's translate emits a descriptor that adopts it (AC: container
  // assignment routes through the plugin path, not a core type === 'database').
  const assigned = bench.assignedContainers?.[componentName];
  const translateConfig: Record<string, unknown> = {
    ...resolvedConfig,
    ...(assigned ? { assignedContainerId: assigned.containerId } : {}),
  };

  let rawDescriptor: unknown;
  try {
    rawDescriptor = await pluginManager.invoke(binding.pluginId, "translate", {
      config: translateConfig,
      context: {
        projectId,
        benchId,
        componentName,
        workspacePath: bench.workspacePath,
        ports: tplCtx.ports,
        env: resolvedEnv,
      },
    });
  } catch (err) {
    componentStatus.status = "error";
    componentStatus.error = (err as Error).message;
    notificationService.createNotification(bench, "component-error");
    updateBenchStatus(bench);
    return;
  }

  if (rawDescriptor && typeof rawDescriptor === "object" && "kind" in rawDescriptor) {
    componentDescriptors.set(
      descriptorKindKey(projectId, benchId, componentName),
      rawDescriptor as ProvisionDescriptor,
    );
  }

  // Wire the per-bench BrokerContext onto the plugin's live connection (#677).
  // The broker handlers are registered once per component-plugin connection in
  // plugin-manager; here we supply the context they resolve against so a
  // privileged broker call this component's plugin makes accumulates an
  // AuditEntry into THIS bench's AuditLog (via recordAuditEntry). Registered
  // before runDescriptor runs so the broker is live for the launch, and dropped
  // on bench teardown alongside clearAuditLog.
  registerBrokerContextForBench(projectId, benchId, componentName, binding.pluginId, tplCtx.ports);

  const lifecycleCtx: LifecycleContext = {
    pluginId: binding.pluginId,
    projectId,
    benchId,
    componentName,
    workspacePath: bench.workspacePath,
    ports: tplCtx.ports,
    reportStatus: buildReportStatus(projectId, benchId),
    setupComplete: componentStatus.setupComplete,
  };

  const result = await runDescriptor(rawDescriptor, lifecycleCtx, {
    processManager,
    docker: dockerService,
    ledger,
  });

  // The engine's reportStatus sink REPLACES bench.components[name] with a fresh
  // object, so re-read the live status here rather than mutate the now-stale
  // local reference.
  const liveStatus = bench.components[componentName] ?? componentStatus;

  // The engine ran any one-time setup; persist setupComplete on first success so
  // a later Stop -> Start cycle skips it (FR-007 parity).
  if (result.status !== "error" && liveStatus.setupComplete !== true) {
    liveStatus.setupComplete = true;
    stateService.updateBench(stateService.toPersistedBench(bench));
  }
  if (result.status === "error") {
    notificationService.createNotification(bench, "component-error");
  }

  // Clear the in-flight markers (parity with the built-in launch path), so
  // reconcile resumes managing this component's live state.
  liveStatus.statusDetail = undefined;
  liveStatus.statusDetailStartedAt = undefined;
  liveStatus.startedAt = undefined;

  updateBenchStatus(bench);
}

/**
 * Pure launch: delegates a component's lifecycle to its bound plugin via the
 * LifecycleEngine. `runComponentsInOrder` orders the launches; `startComponent`
 * (the route-facing entry point) wraps it.
 */
async function launchComponent(
  projectId: string,
  benchId: number,
  componentName: string,
): Promise<void> {
  if (PROTOTYPE_POLLUTING_KEYS.includes(componentName)) {
    throw new BenchError(`Invalid component name '${componentName}'`, "INVALID_COMPONENT");
  }

  await provisionComponent(projectId, benchId, componentName);
}

/**
 * Route-facing per-component Start. Runs setup-if-needed → launch via the same
 * `runComponentsInOrder` chain that bench-level Start uses, just with a single
 * component. Does not seed the `bench-setup` step, so bench-level setup is
 * never run from a per-component Start.
 */
// A non-operable bench (blank workspacePath, see bench-operability.ts) cannot be
// provisioned or started: its only valid action is Clear. Guard the start entry points
// so they neither run setup/launch commands against the server's own cwd
// (path.resolve("", dir) / path.join("", envFile) both root there) nor clear the
// bench's error state.
function assertStartableWorkspace(bench: Bench): void {
  if (!isBenchOperable(bench)) {
    throw new BenchError(benchNotOperableMessage("be started"), "INVALID_STATE");
  }
}

export async function startComponent(
  projectId: string,
  benchId: number,
  componentName: string,
): Promise<void> {
  if (PROTOTYPE_POLLUTING_KEYS.includes(componentName)) {
    throw new BenchError(`Invalid component name '${componentName}'`, "INVALID_COMPONENT");
  }

  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError(`Bench not found`, "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new BenchError(`Project config not found`, "PROJECT_NOT_FOUND");

  assertStartableWorkspace(bench);

  const componentConfig = project.config.components[componentName];
  if (!componentConfig)
    throw new BenchError(`Component '${componentName}' not defined`, "COMPONENT_NOT_FOUND");

  if (!bench.components[componentName])
    throw new BenchError(`Component '${componentName}' not found in bench`, "COMPONENT_NOT_FOUND");

  bench.provisioningSteps = makeComponentOnlyProvisioningSteps([componentName]);
  bench.status = "preparing";
  bench.error = undefined;

  await runComponentsInOrder(bench, [componentName], project.config);
}

export async function stopComponent(
  projectId: string,
  benchId: number,
  componentName: string,
): Promise<void> {
  if (PROTOTYPE_POLLUTING_KEYS.includes(componentName)) {
    throw new BenchError(`Invalid component name '${componentName}'`, "INVALID_COMPONENT");
  }

  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError(`Bench not found`, "NOT_FOUND");

  const componentStatus = bench.components[componentName];
  if (!componentStatus)
    throw new BenchError(`Component '${componentName}' not found`, "COMPONENT_NOT_FOUND");

  componentStatus.status = "stopping";

  // Delegate teardown to the plugin path: stop whatever the LifecycleEngine
  // provisioned, driven by the descriptor the plugin emitted (the plugin's
  // output, not a core docker-field branch). A docker component's compose
  // service is stopped; every component's engine-spawned process id is stopped
  // (a no-op when none exists). No component-type literal, no `.docker` field.
  const descriptor = await getOrResolveDescriptor(projectId, benchId, componentName);
  if (descriptor?.kind === "docker" && !bench.assignedContainers?.[componentName]) {
    const projectName = dockerService.getComposeProjectName(projectId, benchId);
    await dockerService.composeStop(
      projectName,
      descriptor.composeFile,
      bench.workspacePath,
      descriptor.service,
    );
  }

  const binding = resolveBinding(projectId, componentName);
  const enginePid = isNotBound(binding)
    ? undefined
    : `${binding.pluginId}:${benchId}:${componentName}`;
  if (enginePid) {
    await processManager.stopProcess(enginePid);
  }
  // Also stop the legacy host-id process (idempotent) so a process started
  // before this refactor's id scheme is cleaned up.
  await processManager.stopProcess(processId(projectId, benchId, componentName));
  componentStatus.status = "stopped";
  componentStatus.pid = undefined;
  componentStatus.error = undefined;
  componentStatus.statusDetail = undefined;
  componentStatus.statusDetailStartedAt = undefined;
  componentStatus.startedAt = undefined;

  updateBenchStatus(bench);
}

export function startAllComponents(projectId: string, benchId: number): Bench {
  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError(`Bench not found`, "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new BenchError(`Project config not found`, "PROJECT_NOT_FOUND");

  assertStartableWorkspace(bench);

  const ordered = getComponentOrder(project.config.components);

  bench.provisioningSteps = makeStartProvisioningSteps(project.config, ordered);
  bench.status = "preparing";
  bench.error = undefined;

  void runStartAllBackground(bench, ordered, project.config);

  return bench;
}

export async function stopAllComponents(projectId: string, benchId: number): Promise<void> {
  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError(`Bench not found`, "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  const ordered = project?.config
    ? getComponentOrder(project.config.components).reverse()
    : Object.keys(bench.components);

  for (const name of ordered) {
    await stopComponent(projectId, benchId, name);
  }
}

function updateBenchStatus(bench: Bench) {
  if (bench.status === "preparing" || bench.status === "clearing") return;
  const statuses = Object.values(bench.components).map((s) => s.status);
  if (statuses.some((s) => s === "error")) {
    bench.status = "error";
  } else if (statuses.every((s) => s === "running")) {
    bench.status = "active";
  } else {
    bench.status = "idle";
  }
}

export function getBench(projectId: string, benchId: number): Bench | undefined {
  return benches.get(benchKey(projectId, benchId));
}

export function getBenches(projectId?: string): Bench[] {
  const all = Array.from(benches.values());
  if (projectId) {
    return all.filter((b) => b.projectId === projectId);
  }
  return all;
}

/**
 * Structured component logs for the GET /components/:name/logs surface. Returns
 * ComponentLogLine[] ({ source, text, ts }) so a plugin-backed component and a
 * built-in component yield the identical field shape (FR-014, NFR-004 parity).
 *
 * A plugin-backed component pushes logs into the structured store via
 * host.component.reportLog (see {@link buildReportLog}); a built-in component's
 * logs come from the process-manager buffer, now also structured. When a
 * plugin-backed store exists for this component it wins; otherwise the built-in
 * process buffer is read.
 */
export function getComponentLogs(
  projectId: string,
  benchId: number,
  componentName: string,
  tail?: number,
): ComponentLogLine[] {
  if (componentLogStore.hasComponentLogs(projectId, benchId, componentName)) {
    return componentLogStore.getComponentLogLines(projectId, benchId, componentName, tail);
  }
  // A declarative plugin-backed component's process logs are captured by
  // process-manager under the engine's id scheme (`${pluginId}:${benchId}:${name}`).
  const binding = resolveBinding(projectId, componentName);
  const pid = isNotBound(binding)
    ? processId(projectId, benchId, componentName)
    : `${binding.pluginId}:${benchId}:${componentName}`;
  return processManager.getProcessLogLines(pid, tail);
}

// Per-bench AuditLog registry (FR-019, #671). One in-memory AuditLog accumulates
// the privileged HostComponentBroker calls for a single (projectId, benchId), keyed
// the same way as the component-log store. The log is created lazily on first record
// and dropped when the bench is torn down. This is an in-process store only: nothing
// is persisted to state.json, so a bench's audit log is empty after a server restart.
const auditLogs = new Map<string, AuditLog>();

function auditLogKey(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

/**
 * Record one privileged broker call into the per-bench AuditLog (FR-019). This is
 * the audit sink future broker-per-bench wiring attaches to BrokerContext.recordAudit:
 * the broker stamps pluginId, benchId, method, params, and outcome, and the host
 * appends the entry here in call order. The bench's log is created on first record.
 */
export function recordAuditEntry(projectId: string, benchId: number, entry: AuditEntry): void {
  const k = auditLogKey(projectId, benchId);
  let log = auditLogs.get(k);
  if (!log) {
    log = new AuditLog();
    auditLogs.set(k, log);
  }
  log.record(entry);
}

/**
 * Query a bench's recorded privileged broker calls in chronological order, optionally
 * filtered by pluginId, for the GET .../audit-log surface (#671). A bench with no
 * recorded calls (or one that has been torn down) yields an empty array.
 */
export function queryAuditLog(projectId: string, benchId: number, pluginId?: string): AuditEntry[] {
  const log = auditLogs.get(auditLogKey(projectId, benchId));
  if (!log) return [];
  return log.query({ pluginId });
}

/**
 * Drop a bench's accumulated AuditLog. Called on bench teardown, alongside the
 * other per-bench in-memory state, so a cleared bench's audit history does not
 * leak into a later bench that reuses the same id.
 */
export function clearAuditLog(projectId: string, benchId: number): void {
  auditLogs.delete(auditLogKey(projectId, benchId));
}

/** Test-only reset of the whole per-bench AuditLog registry. */
export function _resetAuditLogsForTest(): void {
  auditLogs.clear();
}

/**
 * Build the host.component.reportStatus sink for a plugin-backed component on a
 * given bench. Merging the pushed ComponentStatus into bench.components[name] and
 * broadcasting through the SAME sseService.broadcastBenchStatus path the built-in
 * Start/Stop flow uses is what gives the SSE stream parity: identical event shape
 * and identical dedup, with no duplicate or missing events (FR-014, NFR-004).
 *
 * This sink is the host-side wiring F1.11's plugin dispatch attaches to
 * BrokerContext.reportStatus / LifecycleContext.reportStatus at plugin
 * activation; it does not itself start any plugin.
 */
export function buildReportStatus(
  projectId: string,
  benchId: number,
): (status: ComponentStatus) => void {
  return (status: ComponentStatus) => {
    const bench = getBench(projectId, benchId);
    if (!bench) return;
    const existing = bench.components[status.name];
    // Merge over any existing entry so a partial push (e.g. a phase update that
    // omits pid) never drops a field the previous status carried.
    bench.components[status.name] = { ...existing, ...status };
    updateBenchStatus(bench);
    sseService.broadcastBenchStatus(bench);
  };
}

/**
 * Build the host.component.reportLog sink for a plugin-backed component on a given
 * bench. Appends to the restart-safe structured log store keyed by
 * (projectId, benchId, componentName), the read side of getComponentLogs.
 */
export function buildReportLog(
  projectId: string,
  benchId: number,
  componentName: string,
): (line: ComponentLogLine) => void {
  return (line: ComponentLogLine) => {
    componentLogStore.appendComponentLog(projectId, benchId, componentName, line);
  };
}

// Maps a broker permission category to the manifest's consent-category name.
// The broker speaks "process" (singular); the manifest / consent ledger speaks
// "processes". "docker" and "ports" line up one-to-one.
const BROKER_TO_CONSENT_CATEGORY: Record<BrokerPermissionCategory, PermissionCategory> = {
  process: "processes",
  docker: "docker",
  ports: "ports",
};

/**
 * Build and register the per-bench BrokerContext a component plugin's broker
 * handlers service for this bench (#677). The context carries this bench's ports,
 * the recordAudit sink wired to recordAuditEntry(projectId, benchId, entry), the
 * push sinks for host.component.report*, and a hasPermission check derived from
 * the plugin manifest's declared broker categories. Registered through
 * plugin-manager so the broker handlers (registered once on the plugin's shared
 * connection) resolve against it. Dropped on bench teardown via
 * unregisterBrokerContextsForBench.
 */
function registerBrokerContextForBench(
  projectId: string,
  benchId: number,
  componentName: string,
  pluginId: string,
  ports: Record<string, number>,
): void {
  // Derive the categories the plugin declared from its manifest, so a broker
  // call outside the declared set is denied (and recorded "denied") rather than
  // delegated. An absent record / manifest declares nothing, so every privileged
  // call is denied: the safe default.
  const record = pluginManager.getRecord(pluginId);
  const declared = record?.manifest
    ? new Set(declaredCategories(record.manifest.permissions))
    : null;

  const ctx: BrokerContext = {
    pluginId,
    benchId,
    ports,
    reportStatus: buildReportStatus(projectId, benchId),
    // The registry keys a BrokerContext by (pluginId, benchId) only, so when two
    // components in one bench share a plugin the later provision overwrites this
    // ctx. reportStatus carries params.name and self-corrects, but reportLog binds
    // a single componentName here (the RPC carries no component name), so its
    // output routes to the last-provisioned component. Precise per-component
    // routing is tracked in #685.
    reportLog: buildReportLog(projectId, benchId, componentName),
    hasPermission: (category: BrokerPermissionCategory) =>
      declared !== null && declared.has(BROKER_TO_CONSENT_CATEGORY[category]),
    recordAudit: (entry: AuditEntry) => recordAuditEntry(projectId, benchId, entry),
    // assignContainer (the ResourceOwnershipLedger sink) stays out of this v1
    // wiring: the broker handler guards it with `?.`, and container-assignment
    // routing is not in scope for the audit wiring (#677).
  };
  pluginManager.registerBrokerContext(pluginId, benchId, ctx);
}

/**
 * Drop every per-bench BrokerContext this bench registered (#677), one per
 * distinct plugin backing one of the bench's components. Called on bench teardown
 * alongside clearAuditLog so a torn-down bench's broker context does not leak into
 * a later bench that reuses the same id.
 */
function unregisterBrokerContextsForBench(projectId: string, benchId: number): void {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return;
  const pluginIds = new Set<string>();
  for (const name of Object.keys(project.config.components)) {
    const binding = resolveBinding(projectId, name);
    if (!isNotBound(binding)) pluginIds.add(binding.pluginId);
  }
  for (const pluginId of pluginIds) {
    pluginManager.unregisterBrokerContext(pluginId, benchId);
  }
}

export async function refreshComponentStatuses() {
  // Collect all docker queries to batch into a single listContainers call. The
  // descriptor the engine pushed (the plugin's output) tells core which host
  // resource backs each component; core reads no config docker-field (#612,
  // NFR-006) and never polls the plugin over IPC (NFR-002).
  const dockerQueries: Array<{ projectName: string; service: string }> = [];
  for (const bench of benches.values()) {
    const project = projectRegistry.getProject(bench.projectId);
    if (!project?.config) continue;
    for (const name of Object.keys(project.config.components)) {
      const descriptor = await getOrResolveDescriptor(bench.projectId, bench.id, name);
      if (descriptor?.kind === "docker" && bench.components[name]) {
        dockerQueries.push({
          projectName: dockerService.getComposeProjectName(bench.projectId, bench.id),
          service: descriptor.service,
        });
      }
    }
  }

  const containerStatuses =
    dockerQueries.length > 0
      ? await dockerService.getContainerStatuses(dockerQueries)
      : new Map<string, ContainerStatus>();

  for (const bench of benches.values()) {
    const project = projectRegistry.getProject(bench.projectId);
    if (!project?.config) continue;

    for (const name of Object.keys(project.config.components)) {
      const componentStatus = bench.components[name];
      if (!componentStatus) continue;

      // Don't override error/stopping states: they must be cleared by an
      // explicit startComponent/stopComponent call. Also don't interfere while
      // an active startComponent call is managing the lifecycle (startedAt set).
      if (componentStatus.status === "error" || componentStatus.status === "stopping") continue;
      if (componentStatus.startedAt) continue;

      const descriptor = componentDescriptors.get(
        descriptorKindKey(bench.projectId, bench.id, name),
      );
      const binding = resolveBinding(bench.projectId, name);
      const pluginId = isNotBound(binding) ? undefined : binding.pluginId;

      if (descriptor?.kind === "docker") {
        const projectName = dockerService.getComposeProjectName(bench.projectId, bench.id);
        const containerStatus =
          containerStatuses.get(`${projectName}/${descriptor.service}`) ?? "not_found";
        if (containerStatus === "running") {
          componentStatus.status = "running";
        } else if (containerStatus === "starting") {
          componentStatus.status = "starting";
        } else if (containerStatus === "unhealthy") {
          componentStatus.status = "stopped";
          componentStatus.error = "Container health check failed";
        } else if (componentStatus.status === "running") {
          componentStatus.status = "stopped";
        }
      } else if (pluginId) {
        const procStatus = processManager.getProcessStatus(`${pluginId}:${bench.id}:${name}`);
        if (procStatus.alive && componentStatus.status === "starting") {
          componentStatus.status = "running";
        } else if (
          !procStatus.alive &&
          (componentStatus.status === "running" || componentStatus.status === "starting")
        ) {
          componentStatus.status = "stopped";
          componentStatus.error =
            procStatus.exitCode !== null && procStatus.exitCode !== 0
              ? `Exited with code ${procStatus.exitCode}`
              : undefined;
        }
      }
    }

    updateBenchStatus(bench);
  }
}

// Component names index plain objects (bench.components, bench.ports,
// bench.assignedContainers) and arrive from user-controlled request params.
// The prototype-polluting keys. Any function that indexes a per-component record
// (bench.components, bench.ports, bench.assignedContainers) with a user-controlled
// name must reject these inline, before the lookup, or a '__proto__'/'constructor'/
// 'prototype' value would resolve to Object.prototype and the assignment that
// follows would mutate it (CodeQL js/prototype-polluting-assignment).
//
// The guard is inlined at each call site rather than wrapped in a helper on
// purpose: CodeQL only treats the membership check itself as a dataflow barrier
// when it lives in the same function as the sink and dominates it. A helper call
// is not recognized, even sharing a function with the sink, so it leaves the
// alert open.
const PROTOTYPE_POLLUTING_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

export async function assignContainer(
  projectId: string,
  benchId: number,
  componentName: string,
  containerId: string,
): Promise<Bench> {
  if (PROTOTYPE_POLLUTING_KEYS.includes(componentName)) {
    throw new BenchError(`Invalid component name '${componentName}'`, "INVALID_COMPONENT");
  }

  const bench = getBench(projectId, benchId);
  if (!bench)
    throw new BenchError(`Bench ${benchId} not found for project '${projectId}'`, "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new BenchError(`Project config not found`, "PROJECT_NOT_FOUND");

  const componentConfig = project.config.components[componentName];
  if (!componentConfig)
    throw new BenchError(`Component '${componentName}' not defined`, "COMPONENT_NOT_FOUND");

  // No core `type === 'database'` guard (#612): the assigned container is
  // validated generically (it exists, it publishes a port) and the bound plugin
  // owns the type-specific adoption. At provision time provisionComponent injects
  // `assignedContainerId` into the plugin's translate config, so the database
  // plugin emits a descriptor the LifecycleEngine adopts (the plugin path), and
  // assignment is gated on the plugin's `docker` permission via the broker.
  const container = await dockerService.getContainerInfoById(containerId);
  if (!container)
    throw new BenchError(`Container '${containerId}' not found`, "CONTAINER_NOT_FOUND");
  if (!container.port)
    throw new BenchError(`Container '${containerId}' has no published port`, "NO_PORT");

  if (!bench.assignedContainers) bench.assignedContainers = {};
  bench.assignedContainers[componentName] = {
    containerId: container.id,
    containerName: container.name,
    port: container.port,
  };

  bench.ports[componentName] = container.port;

  // Update component status to reflect external container
  if (bench.components[componentName]) {
    bench.components[componentName].status = container.status === "running" ? "running" : "stopped";
  }

  stateService.updateBench(stateService.toPersistedBench(bench));

  updateBenchStatus(bench);
  return bench;
}

export async function unassignContainer(
  projectId: string,
  benchId: number,
  componentName: string,
): Promise<Bench> {
  if (PROTOTYPE_POLLUTING_KEYS.includes(componentName)) {
    throw new BenchError(`Invalid component name '${componentName}'`, "INVALID_COMPONENT");
  }

  const bench = getBench(projectId, benchId);
  if (!bench)
    throw new BenchError(`Bench ${benchId} not found for project '${projectId}'`, "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new BenchError(`Project config not found`, "PROJECT_NOT_FOUND");

  if (!bench.assignedContainers?.[componentName]) {
    throw new BenchError(`No container assigned to component '${componentName}'`, "NOT_ASSIGNED");
  }

  const remaining = Object.fromEntries(
    Object.entries(bench.assignedContainers).filter(([key]) => key !== componentName),
  );
  bench.assignedContainers = Object.keys(remaining).length > 0 ? remaining : undefined;

  // Restore original allocated port
  const ports = allocatePorts(project.config, benchId);
  bench.ports[componentName] = ports[componentName];

  // Reset component status since it's no longer backed by a container
  if (bench.components[componentName]) {
    bench.components[componentName].status = "stopped";
  }

  stateService.updateBench(stateService.toPersistedBench(bench));

  updateBenchStatus(bench);
  return bench;
}

/**
 * Re-points a TestBench at a different focused spec (FR-024). Validates and
 * contains the new focusedSpecPath against the project repo (same barrier as
 * create), updates bench.focusedSpecPath to the resolved absolute path, persists,
 * and returns the updated bench. The prior spec's test-results.json is untouched:
 * results are keyed per spec, so re-pointing loses nothing and staleness is
 * re-evaluated on the next plan load. Rejects with BenchError when the bench is
 * not found, is not a testbench variant, or the path fails validation/containment.
 */
export function setFocusedSpecPath(
  projectId: string,
  benchId: number,
  focusedSpecPath: string,
): Bench {
  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError("Bench not found", "NOT_FOUND");
  if (bench.variant !== "testbench") {
    throw new BenchError("Bench is not a testbench variant", "NOT_TESTBENCH");
  }
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) {
    throw new BenchError(`Project '${projectId}' not found`, "PROJECT_NOT_FOUND");
  }
  let resolvedPath: string;
  try {
    resolvedPath = resolveFocusedSpec(project.repoPath, focusedSpecPath).resolvedPath;
  } catch (err) {
    throw new BenchError(`Invalid focusedSpecPath: ${(err as Error).message}`, "INVALID_FOCUS");
  }
  bench.focusedSpecPath = resolvedPath;
  stateService.updateBench(stateService.toPersistedBench(bench));
  return bench;
}

export class BenchError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "BenchError";
  }
}

// Test-only surface. `reloadFromState` drops the in-memory `benches` Map and
// re-hydrates it from `state.json` using the same logic as `initialize()`.
// The e2e harness route `POST /test/__register-fixture-project` calls it
// after `state.addBench(...)` so seeded benches become visible to
// `getBenches` without a server restart. `initialize()` on its own would
// append duplicates if called twice with the same projectId+id, so this
// helper clears first.
export const __test = {
  reloadFromState(): void {
    benches.clear();
    initialize();
  },
};
