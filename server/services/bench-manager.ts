import fs from "node:fs";
import path from "node:path";
import type {
  Bench,
  BenchStatus,
  BenchWorkUnit,
  ComponentStatus,
  ComponentConfig,
  ComponentPhase,
  ProvisioningStep,
  ProvisioningStepStatus,
  RegisteredProject,
  RouboConfig,
} from "@roubo/shared";
import { COMPONENT_STEP_PREFIX } from "@roubo/shared";
import * as projectRegistry from "./project-registry.js";
import * as stateService from "./state.js";
import * as dockerService from "./docker.js";
import type { ContainerStatus } from "./docker.js";
import * as processManager from "./process-manager.js";
import * as terminalService from "./terminal.js";
import * as notificationService from "./notification.js";
import * as sseService from "./sse.js";
import { allocatePorts } from "./port-allocator.js";
import {
  buildTemplateContext,
  resolveTemplate,
  resolveServiceEnv,
  stripSurroundingQuotes,
  type ResolvedTemplateContext,
} from "./config-parser.js";
import { runCommand, parseCommand } from "./exec.js";
import { assertSafeWorkspacePath, UnsafePathError } from "../lib/safe-path.js";
import { injectPermissions } from "./claude-settings-local.js";
import {
  resolveDefaultBranch,
  resolveHeadBranch,
  parseGitmodulesWithBranch,
  resolveSubmoduleBranch,
  type GitmoduleEntry,
} from "./git-helpers.js";

export const RESOLVE_DEFAULT_BRANCH_PHASE = "Resolving default branch";
const benches = new Map<string, Bench>();

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
      // Legacy benches (pre-#538) have no componentSetupState at all — those
      // were created under the old full-provisioning flow, so setup ran.
      // Coerce every component to setupComplete: true for that whole bench.
      // When componentSetupState is present but lacks an entry for a specific
      // component, the component was added to roubo.yaml after the bench was
      // created — fall back to the same default createBench applies: !setup.
      const isLegacy = ps.componentSetupState === undefined;
      for (const [name, componentConfig] of Object.entries(project.config.components)) {
        const persistedFlag = ps.componentSetupState?.[name];
        const setupComplete = isLegacy
          ? true
          : (persistedFlag ?? (componentConfig.setup ? false : true));
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
      workUnits: ps.workUnits,
      baseBranch: ps.baseBranch,
      baseCommit: ps.baseCommit,
      injectedJigId: ps.injectedJigId,
      injectedJigSource: ps.injectedJigSource,
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
    // Benches loaded with a blank workspacePath were rejected by the safe-path
    // allowlist at load time (see initialize()). They already carry their own error
    // state and have no workspace to reconcile — leave them untouched.
    if (!bench.workspacePath) {
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
        "Worktree directory exists but is not tracked by git — use Cleanup & Retry to fix";
      continue;
    }

    validBenches.push(bench);
    for (const [, componentConfig] of Object.entries(project.config.components)) {
      if (componentConfig.docker) {
        dockerQueries.push({
          projectName: dockerService.getComposeProjectName(bench.projectId, bench.id),
          service: componentConfig.docker.service,
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

    for (const [name, componentConfig] of Object.entries(project.config.components)) {
      if (componentConfig.docker) {
        const projectName = dockerService.getComposeProjectName(bench.projectId, bench.id);
        const containerStatus =
          containerStatuses.get(`${projectName}/${componentConfig.docker.service}`) ?? "not_found";
        const newStatus =
          containerStatus === "running"
            ? "running"
            : containerStatus === "starting"
              ? "starting"
              : ("stopped" as const);
        if (bench.components[name]) {
          bench.components[name].status = newStatus;
        } else {
          bench.components[name] = {
            name,
            status: newStatus,
            setupComplete: !componentConfig.setup,
          };
        }
      } else {
        const pid = processId(bench.projectId, bench.id, name);
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
              setupComplete: !componentConfig.setup,
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
  const hasNonDockerComponents = Object.values(components).some((s) => !s.docker);
  if (hasNonDockerComponents) {
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

function isBenchStillActive(projectId: string, benchId: number): boolean {
  return benches.has(benchKey(projectId, benchId));
}

export function createBench(projectId: string, branch?: string): Bench {
  const project = projectRegistry.getProject(projectId);
  if (!project || !project.configValid || !project.config) {
    throw new BenchError(
      `Project '${projectId}' not found or has invalid config`,
      "PROJECT_NOT_FOUND",
    );
  }

  const config = project.config;
  // No `await` between findNextBenchNumber and benches.set — this guarantees atomic
  // bench reservation in Node.js single-threaded event loop. Do not add async
  // operations between here and the benches.set() call below.
  const benchNumber = findNextBenchNumber(projectId, config.benches.max);
  if (benchNumber === null) {
    throw new BenchError(
      `No available benches for '${projectId}' (max: ${config.benches.max})`,
      "NO_BENCHES",
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
      setupComplete: !componentConfig.setup,
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
    if (!isBenchStillActive(bench.projectId, bench.id)) return;
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
    if (!isBenchStillActive(bench.projectId, bench.id)) return;

    const componentStatus = bench.components[name];
    updateStep(bench.provisioningSteps, `${COMPONENT_STEP_PREFIX}${name}`, "running");

    if (config) {
      const componentConfig = config.components[name];
      const needsSetup = !!componentConfig?.setup && !componentStatus.setupComplete;
      componentStatus.phases = makeComponentPhases(componentConfig, needsSetup);

      if (needsSetup) {
        setComponentPhase(componentStatus, "Installing dependencies");
        const cwd = componentConfig.directory
          ? path.resolve(bench.workspacePath, componentConfig.directory)
          : bench.workspacePath;
        const parts = parseCommand(componentConfig.setup as string);
        const result = await runCommand(parts[0], parts.slice(1), cwd, undefined, 300_000);
        processManager.storeCommandLogs(
          processId(bench.projectId, bench.id, name),
          result.stdout,
          result.stderr,
        );
        if (result.code !== 0) {
          const errorMsg = result.stderr || `Setup command failed with exit code ${result.code}`;
          errorCurrentPhase(componentStatus);
          updateStep(bench.provisioningSteps, `${COMPONENT_STEP_PREFIX}${name}`, "error", errorMsg);
          bench.status = "error";
          bench.error = `Setup for '${name}' failed: ${errorMsg}`;
          return;
        }
        completeAllPhases(componentStatus);
        componentStatus.setupComplete = true;
        stateService.updateBench(stateService.toPersistedBench(bench));
      }
    } else {
      componentStatus.phases = [];
    }

    await launchComponent(bench.projectId, bench.id, name);

    if (componentStatus?.status === "error") {
      updateStep(
        bench.provisioningSteps,
        `${COMPONENT_STEP_PREFIX}${name}`,
        "error",
        componentStatus.error,
      );
      bench.status = "error";
      bench.error = `Component '${name}' failed to start: ${componentStatus.error ?? "unknown error"}`;
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
    if (!isBenchStillActive(bench.projectId, bench.id)) return;
    updateStep(bench.provisioningSteps, "workspace", "running");

    // workspace step is always present — makeWorktreeProvisioningSteps guarantees it as steps[0]
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
    // non-fatal — baseBranch stays undefined rather than aborting provisioning.
    let headBranch: string | undefined = sourceBranch;
    if (!headBranch) {
      try {
        headBranch = await resolveHeadBranch(project.repoPath);
      } catch {
        console.warn(`[bench-manager] Could not resolve base branch for bench ${bench.id}`);
      }
    }
    bench.baseBranch = headBranch;
    if (!isBenchStillActive(bench.projectId, bench.id) || bench.status === "clearing") return;

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
          `Failed to fetch 'origin/${pullBranch}' — ${fetchResult.stderr.trim() || "git fetch exited non-zero"}. ` +
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
          `Could not fast-forward '${pullBranch}' — your local branch has diverged from origin/${pullBranch}. ` +
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
            `Failed to update ${subjectClause} to latest — ${detail}. ` +
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
            `at ${bench.workspacePath}: ${detail} — will attempt rmSync fallback`,
        );
      }
      fs.rmSync(bench.workspacePath, { recursive: true, force: true });
    }

    // R1: pass the resolved branch as the base for the new worktree branch so
    // the bench starts from the default branch rather than the current HEAD.
    // The retry path (branch already exists) uses `git worktree add <path> <branch>`
    // without -b, so it cannot take a base argument — it stays unchanged.
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
    let gitmodulesMap: Record<string, GitmoduleEntry> | undefined;
    const declaredSubmodules = isMetaRepo ? (config.layout.submodules ?? {}) : {};
    if (isMetaRepo) {
      // Validate that all submodules declared in roubo.yaml exist in .gitmodules.
      // A missing entry is a fatal provisioning error — the bench must not half-initialize.
      const gitmodulesPath = path.join(bench.workspacePath, ".gitmodules");
      if (!fs.existsSync(gitmodulesPath)) {
        throw new Error(
          `Meta-repo workspace is missing .gitmodules at ${gitmodulesPath}. ` +
            `Ensure the source repository has a valid .gitmodules file.`,
        );
      }
      const gitmodulesContent = await fs.promises.readFile(gitmodulesPath, "utf-8");
      const parsedMap = parseGitmodulesWithBranch(gitmodulesContent);
      gitmodulesMap = parsedMap;

      const missing = Object.keys(declaredSubmodules).filter((name) => !parsedMap[name]);
      if (missing.length > 0) {
        throw new Error(
          `Submodule(s) declared in roubo.yaml but missing from .gitmodules: ${missing.join(", ")}. ` +
            `Check that 'layout.submodules' in roubo.yaml matches the [submodule] entries in .gitmodules.`,
        );
      }

      // Validate that each submodule's path in .gitmodules matches the path declared in roubo.yaml.
      // The worktree paths for work units are derived from roubo.yaml — a mismatch would produce
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

      if (!isBenchStillActive(bench.projectId, bench.id)) return;
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

    // Populate workUnits for meta-repo benches after submodule init
    if (isMetaRepo && gitmodulesMap) {
      const map = gitmodulesMap; // capture narrowed type — TypeScript doesn't narrow outer lets inside async callbacks
      const workUnits: BenchWorkUnit[] = [];

      workUnits.push({
        submodule: ".",
        branch: bench.branch,
        workspacePath: bench.workspacePath,
      });

      const subEntries = await Promise.all(
        Object.entries(declaredSubmodules).map(async ([name, relativePath]) => {
          const absPath = path.join(bench.workspacePath, relativePath);
          const branch = await resolveSubmoduleBranch(absPath, map[name]?.branch);
          return { submodule: name, branch, workspacePath: absPath };
        }),
      );
      workUnits.push(...subEntries);

      bench.workUnits = workUnits;
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
      workUnits: bench.workUnits,
      baseBranch: bench.baseBranch,
      baseCommit: bench.baseCommit,
      injectedJigId: bench.injectedJigId,
      injectedJigSource: bench.injectedJigSource,
    });

    // Inject project-level permissions into the workspace before any sessions start.
    // Failure is non-fatal — the bench can still run without pre-seeded permissions.
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
  // Bail if worktree provisioning failed or the bench is being torn down — the
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
  if (!isBenchStillActive(bench.projectId, bench.id)) return;

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

  // Guard against double teardown — return current state if already in progress
  const hasActiveTeardown =
    bench.teardownSteps.length > 0 && !bench.teardownSteps.some((s) => s.status === "error");
  if (bench.status === "clearing" && hasActiveTeardown) {
    return bench;
  }

  const project = projectRegistry.getProject(projectId);
  const components = project?.config?.components ?? {};
  const hasDockerComponents = Object.values(components).some((s) => !!s.docker);

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

    // Step 2: Stop non-docker components
    if (bench.teardownSteps.some((s) => s.id === "stop-components")) {
      updateStep(bench.teardownSteps, "stop-components", "running");
      for (const name of Object.keys(bench.components)) {
        if (project?.config?.components[name]?.docker) continue;
        const pid = processId(projectId, benchId, name);
        await processManager.stopProcess(pid);
        bench.components[name].status = "stopped";
      }
      updateStep(bench.teardownSteps, "stop-components", "done");
    }

    // Step 3: Docker compose down
    if (bench.teardownSteps.some((s) => s.id === "docker-down")) {
      updateStep(bench.teardownSteps, "docker-down", "running");
      if (project?.config) {
        const downedComposeFiles = new Set<string>();
        for (const [name, componentConfig] of Object.entries(project.config.components)) {
          if (componentConfig.docker) {
            if (!downedComposeFiles.has(componentConfig.docker.composeFile)) {
              const projectName = dockerService.getComposeProjectName(projectId, benchId);
              await dockerService.composeDown(
                projectName,
                componentConfig.docker.composeFile,
                bench.workspacePath,
              );
              downedComposeFiles.add(componentConfig.docker.composeFile);
            }
            if (bench.components[name]) bench.components[name].status = "stopped";
          }
        }
      }
      updateStep(bench.teardownSteps, "docker-down", "done");
    }

    // Step 4: Save permissions from workspace before removal
    updateStep(bench.teardownSteps, "save-permissions", "running");
    extractWorkspacePermissions(bench.projectId, bench.workspacePath);
    updateStep(bench.teardownSteps, "save-permissions", "done");

    // Step 5: Remove workspace and branch
    if (removeWorkspace && project) {
      updateStep(bench.teardownSteps, "remove-workspace", "running");

      const wtList = await execGit(["worktree", "list", "--porcelain"], project.repoPath);

      if (wtList.code !== 0) {
        // Can't determine worktree state — fall back to the original forceful path
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
        // else: neither on disk nor registered — nothing to remove
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

    // Final removal from memory — after this, GET /bench returns 404
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

export async function cleanupAndRetryBench(projectId: string, benchId: number): Promise<Bench> {
  const key = benchKey(projectId, benchId);
  const bench = benches.get(key);
  if (!bench) {
    throw new BenchError(`Bench ${benchId} not found for project '${projectId}'`, "NOT_FOUND");
  }
  if (!bench.error) {
    throw new BenchError("Bench has no error to clean up", "INVALID_STATE");
  }
  if (!bench.workspacePath) {
    // The bench was loaded with a blank workspacePath because its persisted path
    // failed the safe-path allowlist (see initialize()). There is no usable path to
    // re-provision from, and recomputing it would only regenerate the same rejected
    // path, so retry cannot succeed: the only safe action is to clear the bench.
    throw new BenchError(
      "Bench has no valid workspace path and cannot be retried; clear it instead.",
      "INVALID_STATE",
    );
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

  for (const name of Object.keys(bench.components)) {
    if (config.components[name]?.docker) continue;
    await processManager.stopProcess(processId(projectId, benchId, name));
  }

  if (fs.existsSync(bench.workspacePath)) {
    const downedComposeFiles = new Set<string>();
    for (const [, componentConfig] of Object.entries(config.components)) {
      if (componentConfig.docker && !downedComposeFiles.has(componentConfig.docker.composeFile)) {
        const projectName = dockerService.getComposeProjectName(projectId, benchId);
        await dockerService
          .composeDown(projectName, componentConfig.docker.composeFile, bench.workspacePath)
          .catch(() => {});
        downedComposeFiles.add(componentConfig.docker.composeFile);
      }
    }
  }

  extractWorkspacePermissions(projectId, bench.workspacePath);

  const wtList = await execGit(["worktree", "list", "--porcelain"], project.repoPath);
  if (wtList.code !== 0) {
    // Can't determine worktree state — fall back to the forceful path so we
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
    // else: neither registered nor on disk — nothing to remove
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
      setupComplete: !componentConfig.setup,
    };
  }

  void runWorktreeProvisioning(bench, project);
  return bench;
}

/**
 * Pure launch — runs the docker / process steps for a component without doing
 * any setup. `runComponentsInOrder` is responsible for running setup first when
 * needed; `startComponent` (the route-facing entry point) wraps both steps.
 */
async function launchComponent(
  projectId: string,
  benchId: number,
  componentName: string,
): Promise<void> {
  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError(`Bench not found`, "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new BenchError(`Project config not found`, "PROJECT_NOT_FOUND");

  const componentConfig = project.config.components[componentName];
  if (!componentConfig)
    throw new BenchError(`Component '${componentName}' not defined`, "COMPONENT_NOT_FOUND");

  const componentStatus = bench.components[componentName];
  if (!componentStatus)
    throw new BenchError(`Component '${componentName}' not found in bench`, "COMPONENT_NOT_FOUND");

  componentStatus.status = "starting";
  if (!componentStatus.phases || componentStatus.phases.length === 0) {
    componentStatus.phases = makeComponentPhases(componentConfig);
  }

  const ctx = buildTemplateContext(project.config, benchId, bench.workspacePath);

  try {
    if (componentConfig.docker) {
      componentStatus.startedAt = new Date().toISOString();
      await startDockerComponent(
        projectId,
        benchId,
        componentName,
        componentConfig,
        bench.workspacePath,
        ctx,
        componentStatus,
      );
      completeAllPhases(componentStatus);
      componentStatus.status = "running";
    } else if (componentConfig.type === "process") {
      await startProcessComponent(
        projectId,
        benchId,
        componentName,
        componentConfig,
        bench.workspacePath,
        ctx,
      );
      componentStatus.status = "running";
    }
  } catch (err) {
    errorCurrentPhase(componentStatus);
    componentStatus.status = "error";
    componentStatus.error = (err as Error).message;
    notificationService.createNotification(bench, "component-error");
  }

  componentStatus.statusDetail = undefined;
  componentStatus.statusDetailStartedAt = undefined;
  componentStatus.startedAt = undefined;

  updateBenchStatus(bench);
}

/**
 * Route-facing per-component Start. Runs setup-if-needed → launch via the same
 * `runComponentsInOrder` chain that bench-level Start uses, just with a single
 * component. Does not seed the `bench-setup` step, so bench-level setup is
 * never run from a per-component Start.
 */
// A bench loaded with a blank workspacePath was rejected by the safe-path allowlist
// at load time (see initialize()). It cannot be provisioned or started — its only
// valid action is Clear. Guard the start entry points so they neither run setup/launch
// commands against the server's own cwd (path.resolve("", dir) / path.join("", envFile)
// both root there) nor clear the bench's error state.
function assertStartableWorkspace(bench: Bench): void {
  if (!bench.workspacePath) {
    throw new BenchError(
      "Bench has no valid workspace path and cannot be started; clear it instead.",
      "INVALID_STATE",
    );
  }
}

export async function startComponent(
  projectId: string,
  benchId: number,
  componentName: string,
): Promise<void> {
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
  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError(`Bench not found`, "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  const componentConfig = project?.config?.components[componentName];
  const componentStatus = bench.components[componentName];
  if (!componentStatus)
    throw new BenchError(`Component '${componentName}' not found`, "COMPONENT_NOT_FOUND");

  componentStatus.status = "stopping";

  if (componentConfig?.docker) {
    const projectName = dockerService.getComposeProjectName(projectId, benchId);
    await dockerService.composeStop(
      projectName,
      componentConfig.docker.composeFile,
      bench.workspacePath,
      componentConfig.docker.service,
    );
  }

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

function makeComponentPhases(
  componentConfig: ComponentConfig,
  includeSetup = false,
): ComponentPhase[] {
  const phases: ComponentPhase[] = [];
  if (includeSetup && componentConfig.setup) {
    phases.push({ label: "Installing dependencies", status: "pending" });
  }
  if (!componentConfig.docker) return phases;
  phases.push(
    { label: "Starting container", status: "pending" },
    { label: "Waiting for healthy", status: "pending" },
  );
  if (componentConfig.docker.initService) {
    phases.push({ label: "Running init component", status: "pending" });
  }
  if (componentConfig.migration) {
    phases.push({ label: "Running migrations", status: "pending" });
  }
  return phases;
}

function setComponentPhase(componentStatus: ComponentStatus, detail: string): void {
  componentStatus.statusDetail = detail;
  componentStatus.statusDetailStartedAt = new Date().toISOString();
  if (componentStatus.phases) {
    for (const phase of componentStatus.phases) {
      if (phase.label === detail) {
        phase.status = "running";
      } else if (phase.status === "running") {
        phase.status = "done";
      }
    }
  }
}

function completeAllPhases(componentStatus: ComponentStatus): void {
  if (componentStatus.phases) {
    for (const phase of componentStatus.phases) {
      if (phase.status === "running") {
        phase.status = "done";
      }
    }
  }
}

function errorCurrentPhase(componentStatus: ComponentStatus): void {
  if (componentStatus.phases) {
    for (const phase of componentStatus.phases) {
      if (phase.status === "running") {
        phase.status = "error";
      }
    }
  }
}

async function startDockerComponent(
  projectId: string,
  benchId: number,
  componentName: string,
  componentConfig: ComponentConfig,
  workspacePath: string,
  ctx: ResolvedTemplateContext,
  componentStatus: ComponentStatus,
) {
  if (!componentConfig.docker) return;

  processManager.clearProcessLogs(processId(projectId, benchId, componentName));

  // Skip docker-compose if using an externally assigned container
  const bench = getBench(projectId, benchId);
  if (bench?.assignedContainers?.[componentName]) {
    const assigned = bench.assignedContainers[componentName];
    const status = await dockerService.getContainerStatusById(assigned.containerId);
    if (status !== "running") {
      throw new Error(`Assigned container '${assigned.containerName}' is not running`);
    }
    return;
  }

  const projectName = dockerService.getComposeProjectName(projectId, benchId);

  const componentEnv = componentConfig.env ? resolveServiceEnv(componentConfig.env, ctx) : {};

  const portOverrides: Record<string, string> = { ...componentEnv };
  if (ctx.ports[componentName]) {
    const envVarName = componentConfig.docker?.portEnvVar ?? "HOST_PORT";
    portOverrides[envVarName] = String(ctx.ports[componentName]);
  }

  setComponentPhase(componentStatus, "Starting container");
  const result = await dockerService.composeUp({
    composeFile: componentConfig.docker.composeFile,
    service: componentConfig.docker.service,
    projectName,
    portOverrides,
    cwd: workspacePath,
  });

  processManager.storeCommandLogs(
    processId(projectId, benchId, componentName),
    result.stdout,
    result.stderr,
  );

  if (!result.success) {
    throw new Error(result.error);
  }

  setComponentPhase(componentStatus, "Waiting for healthy");
  const healthy = await dockerService.waitForHealthy(projectName, componentConfig.docker.service);
  if (!healthy) {
    throw new Error(
      `Container '${componentConfig.docker.service}' did not become healthy within timeout`,
    );
  }

  if (componentConfig.docker.initService) {
    setComponentPhase(componentStatus, "Running init component");
    const initResult = await dockerService.composeRunInit({
      composeFile: componentConfig.docker.composeFile,
      initService: componentConfig.docker.initService,
      projectName,
      portOverrides,
      cwd: workspacePath,
      timeoutMs: 120_000,
    });
    processManager.storeCommandLogs(
      processId(projectId, benchId, componentName),
      initResult.stdout,
      initResult.stderr,
    );

    if (!initResult.success) {
      throw new Error(initResult.error);
    }
  }

  if (componentConfig.migration) {
    setComponentPhase(componentStatus, "Running migrations");
    const cmdParts = parseCommand(componentConfig.migration.command);
    const migCmd = cmdParts[0];
    const migrationArgs = [
      ...cmdParts.slice(1),
      ...(componentConfig.migration.args ?? []).map((arg) => resolveTemplate(arg, ctx)),
    ];
    const migResult = await runCommand(migCmd, migrationArgs, workspacePath, componentEnv, 300_000);
    processManager.storeCommandLogs(
      processId(projectId, benchId, componentName),
      migResult.stdout,
      migResult.stderr,
    );

    if (migResult.code !== 0) {
      throw new Error(`Migration failed: ${migResult.stderr}`);
    }
  }
}

async function startProcessComponent(
  projectId: string,
  benchId: number,
  componentName: string,
  componentConfig: ComponentConfig,
  workspacePath: string,
  ctx: ResolvedTemplateContext,
) {
  const componentDir = componentConfig.directory
    ? path.resolve(workspacePath, componentConfig.directory)
    : workspacePath;

  if (componentConfig.envFile && componentConfig.envVars) {
    const envContent = Object.entries(componentConfig.envVars)
      .map(([k, v]) => `${k}=${stripSurroundingQuotes(resolveTemplate(v, ctx))}`)
      .join("\n");
    // envFile paths are always relative to the workspace root, not the component's directory.
    await fs.promises.writeFile(
      path.join(workspacePath, componentConfig.envFile),
      envContent + "\n",
    );
  }

  const resolvedCommand = resolveTemplate(componentConfig.command ?? "", ctx);
  const parts = parseCommand(resolvedCommand);
  if (parts.length === 0) throw new Error(`Component '${componentName}' has no command`);

  const env = componentConfig.env ? resolveServiceEnv(componentConfig.env, ctx) : {};
  const pid = processId(projectId, benchId, componentName);
  await processManager.startProcess(pid, parts[0], parts.slice(1), env, componentDir);
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

export function getComponentLogs(
  projectId: string,
  benchId: number,
  componentName: string,
  tail?: number,
): string[] {
  return processManager.getProcessLogs(processId(projectId, benchId, componentName), tail);
}

export async function refreshComponentStatuses() {
  // Collect all docker queries to batch into a single listContainers call
  const dockerQueries: Array<{ projectName: string; service: string }> = [];
  for (const bench of benches.values()) {
    const project = projectRegistry.getProject(bench.projectId);
    if (!project?.config) continue;
    for (const [name, componentConfig] of Object.entries(project.config.components)) {
      if (componentConfig.docker && bench.components[name]) {
        dockerQueries.push({
          projectName: dockerService.getComposeProjectName(bench.projectId, bench.id),
          service: componentConfig.docker.service,
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

    for (const [name, componentConfig] of Object.entries(project.config.components)) {
      const componentStatus = bench.components[name];
      if (!componentStatus) continue;

      // Don't override error/stopping states — they must be cleared by an
      // explicit startComponent/stopComponent call. Also don't interfere while
      // an active startComponent call is managing the lifecycle (startedAt set).
      if (componentStatus.status === "error" || componentStatus.status === "stopping") continue;
      if (componentStatus.startedAt) continue;

      if (componentConfig.docker) {
        const projectName = dockerService.getComposeProjectName(bench.projectId, bench.id);
        const containerStatus =
          containerStatuses.get(`${projectName}/${componentConfig.docker.service}`) ?? "not_found";
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
      } else {
        const procStatus = processManager.getProcessStatus(
          processId(bench.projectId, bench.id, name),
        );
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
// Reject the prototype-polluting keys before any indexing so a malicious
// '__proto__'/'constructor'/'prototype' value can't mutate Object.prototype
// (CodeQL js/prototype-polluting-assignment, alert #27).
const PROTOTYPE_POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeComponentName(componentName: string): void {
  if (PROTOTYPE_POLLUTING_KEYS.has(componentName)) {
    throw new BenchError(`Invalid component name '${componentName}'`, "INVALID_COMPONENT");
  }
}

export async function assignContainer(
  projectId: string,
  benchId: number,
  componentName: string,
  containerId: string,
): Promise<Bench> {
  assertSafeComponentName(componentName);

  const bench = getBench(projectId, benchId);
  if (!bench)
    throw new BenchError(`Bench ${benchId} not found for project '${projectId}'`, "NOT_FOUND");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new BenchError(`Project config not found`, "PROJECT_NOT_FOUND");

  const componentConfig = project.config.components[componentName];
  if (!componentConfig)
    throw new BenchError(`Component '${componentName}' not defined`, "COMPONENT_NOT_FOUND");
  if (componentConfig.type !== "database")
    throw new BenchError(
      `Component '${componentName}' is not a database component`,
      "INVALID_COMPONENT_TYPE",
    );

  const containers = await dockerService.listDatabaseContainers();
  const container = containers.find((c) => c.id === containerId);
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
  assertSafeComponentName(componentName);

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
 * Refreshes a work unit's branch from HEAD after a successful git fetch.
 * Call this after any successful `git fetch` in a work unit's worktree.
 * Non-fatal: if HEAD resolution fails, the stored branch remains unchanged.
 */
export async function refreshWorkUnitBranch(bench: Bench, submoduleKey: string): Promise<void> {
  const workUnit = bench.workUnits?.find((wu) => wu.submodule === submoduleKey);
  if (!workUnit) return;

  try {
    const branch = await resolveHeadBranch(workUnit.workspacePath);
    if (branch !== workUnit.branch) {
      workUnit.branch = branch;
      stateService.updateBench(stateService.toPersistedBench(bench));
    }
  } catch {
    console.warn(
      `[bench-manager] Could not refresh branch for work unit '${submoduleKey}' in bench ${bench.id}`,
    );
  }
}

/**
 * Sets the ignoredForAutoClear flag on a work unit and persists the change.
 * Returns the updated bench.
 */
export function setWorkUnitIgnoredForAutoClear(
  projectId: string,
  benchId: number,
  submoduleKey: string,
  ignored: boolean,
): Bench {
  const bench = getBench(projectId, benchId);
  if (!bench) throw new BenchError("Bench not found", "NOT_FOUND");
  const workUnit = bench.workUnits?.find((wu) => wu.submodule === submoduleKey);
  if (!workUnit)
    throw new BenchError(`Work unit '${submoduleKey}' not found on bench ${benchId}`, "NOT_FOUND");
  workUnit.ignoredForAutoClear = ignored;
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
