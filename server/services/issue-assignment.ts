import fs from "node:fs";
import type {
  AssignIssueResponse,
  CreateBenchWithIssueResponse,
  Bench,
  NormalizedIssue,
  PersistedBench,
  RouboConfig,
  JigDefaultSource,
} from "@roubo/shared";
import { CLAUDE_STARTUP_DELAY_MS, DONE_STATUSES } from "@roubo/shared";
import { parseAlertExternalId, isAlertExternalId } from "./alert-external-id.js";
import { formatAlertBody } from "./alert-formatting.js";
import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as stateService from "./state.js";
import * as githubService from "./github.js";
import * as terminalService from "./terminal.js";
import * as jigManager from "./jig-manager.js";
import { buildTemplateContext } from "./config-parser.js";
import { runCommand } from "./exec.js";
import { formatIssueBody, formatComments } from "./issue-formatting.js";
import { ServiceError } from "./service-error.js";
import { assertBenchOperable } from "./bench-operability.js";
import { loadSettings } from "./state.js";

/**
 * Persist a bench only if it is still tracked in the in-memory map. The
 * create/assign flows hold the bench reference across awaited GitHub and git
 * calls; if a teardown cleared the bench in that window (removeBench +
 * benches.delete), persisting here would resurrect it in state.json and it would
 * reappear on the next app restart. Mirrors the guard in pr-sync.
 */
function persistBenchIfLive(persisted: PersistedBench): void {
  if (benchManager.isBenchLive(persisted.projectId, persisted.id)) {
    stateService.updateBench(persisted);
  }
}

function toPersisted(bench: Bench): PersistedBench {
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
    injectedJigId: bench.injectedJigId,
    injectedJigSource: bench.injectedJigSource,
  };
}

/**
 * Shared tail for the create-and-assign flows once the bench exists and its
 * `assignedIssue` is set: persist, start the Claude session (injecting the
 * resolved jig), persist the injected jig, and return the success response.
 * Used by the alert and generic plugin-issue paths.
 */
function finalizeAssignedBench(
  projectId: string,
  bench: Bench,
  projectName: string,
  config: RouboConfig,
  sessionIssue: {
    number?: number;
    externalId?: string;
    title: string;
    body: string | null;
    htmlUrl: string;
  },
  comments: Array<{ user: string; body: string }>,
  issueType: string | null,
): CreateBenchWithIssueResponse {
  // Persist before the network/session work so a failure can't orphan the bench.
  persistBenchIfLive(toPersisted(bench));

  const {
    sessionId: terminalSessionId,
    jigId,
    jigSource,
  } = buildAndStartClaudeSession(
    projectId,
    bench.id,
    bench,
    projectName,
    config,
    sessionIssue,
    comments,
    issueType,
  );

  if (jigId) {
    bench.injectedJigId = jigId;
    bench.injectedJigSource = jigSource;
    persistBenchIfLive(toPersisted(bench));
  }

  return {
    status: "success",
    bench,
    terminalSessionId,
  };
}

function buildAndStartClaudeSession(
  projectId: string,
  benchId: number,
  bench: { workspacePath: string; branch: string },
  projectName: string,
  config: RouboConfig,
  issue: {
    // Absent for integrations whose issues have no numeric form (e.g. Jira);
    // such issues carry `externalId`, surfaced to jigs as {{issueKey}}.
    number?: number;
    externalId?: string;
    title: string;
    body: string | null;
    htmlUrl: string;
  },
  comments: Array<{ user: string; body: string }>,
  issueType?: string | null,
): { sessionId?: string } & (
  | { jigId: string; jigSource: JigDefaultSource }
  | { jigId?: undefined; jigSource?: undefined }
) {
  const settings = loadSettings();
  const autoInject = settings.jigs?.autoInject ?? true;
  const autoExecute = settings.jigs?.autoExecute ?? true;

  let jig: string | undefined;
  let jigId: string | undefined;
  let jigSource: JigDefaultSource | undefined;

  if (autoInject) {
    const resolved = jigManager.resolveJigForIssue(projectId, issueType ?? undefined, settings);
    jigId = resolved.jigId;
    jigSource = resolved.source;
    const jigDef = jigManager.getJig(projectId, jigId);
    const templateCtx = buildTemplateContext(config, benchId, bench.workspacePath);
    jig = jigManager.resolveJigContent(jigDef?.content ?? "", {
      ...templateCtx,
      benchBranch: bench.branch,
      benchId,
      projectName,
      issueNumber: issue.number,
      issueKey: issue.externalId,
      issueTitle: issue.title,
      issueBody: formatIssueBody(issue.body),
      issueUrl: issue.htmlUrl,
      comments: formatComments(comments),
    });
  }

  let session;
  try {
    session = terminalService.createSession(
      projectId,
      benchId,
      bench.workspacePath,
      projectName,
      "claude",
      autoInject && autoExecute ? jig : undefined,
      settings.claudeCode,
    );
  } catch (err) {
    console.warn(
      `Failed to start Claude terminal for bench ${benchId} (issue ${issue.externalId ?? `#${issue.number}`}):`,
      err,
    );
    return {};
  }

  if (autoInject && !autoExecute && jig) {
    setTimeout(() => {
      terminalService.writeToSession(session.id, jig);
    }, CLAUDE_STARTUP_DELAY_MS);
  }

  if (jigId && jigSource) {
    return { sessionId: session.id, jigId, jigSource };
  }
  return { sessionId: session.id };
}

function slugify(text: string, maxLength = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

type BranchResolution =
  | {
      status: "conflict";
      branchConflict: { branchExists: true; workspaceExists: boolean; branchName: string };
    }
  | { status: "ok"; branchName: string };

/**
 * Resolves the final branch name for a create-and-assign flow, honoring the
 * caller's conflict-resolution choice. Returns a `conflict` payload when the
 * branch already exists and the caller has not chosen how to proceed; appends a
 * numeric suffix when "new" was chosen. Shared by the issue and alert paths so
 * both behave identically.
 */
async function resolveBranchNameForCreate(
  repoPath: string,
  baseBranchName: string,
  conflictResolution: "resume" | "new" | undefined,
): Promise<BranchResolution> {
  let branchName = baseBranchName;
  const branchCheck = await runCommand(
    "git",
    ["rev-parse", "--verify", `refs/heads/${branchName}`],
    repoPath,
  );
  const branchExists = branchCheck.code === 0;

  if (branchExists && !conflictResolution) {
    const existingBench = stateService.getPersistedBenches().find((s) => s.branch === branchName);
    const workspaceExists = existingBench ? fs.existsSync(existingBench.workspacePath) : false;
    return {
      status: "conflict",
      branchConflict: { branchExists: true, workspaceExists, branchName },
    };
  }

  if (branchExists && conflictResolution === "new") {
    let suffix = 2;
    let candidate = `${branchName}-${suffix}`;
    while (true) {
      const check = await runCommand(
        "git",
        ["rev-parse", "--verify", `refs/heads/${candidate}`],
        repoPath,
      );
      if (check.code !== 0) break;
      suffix++;
      if (suffix > 100) throw new ServiceError(409, "Too many branch name conflicts");
      candidate = `${branchName}-${suffix}`;
    }
    branchName = candidate;
  }

  return { status: "ok", branchName };
}

/**
 * Extract a GitHub-style numeric id from an externalId: the trailing `#<n>` or a
 * bare `<n>`. Returns undefined for keys with no numeric form (e.g. Jira's
 * PLNRPTGOOG-3782) and for alert externalIds (handled separately).
 */
function numericIdFromExternalId(externalId: string): number | undefined {
  const after = externalId.includes("#") ? externalId.split("#").pop() : externalId;
  if (!after) return undefined;
  const n = Number(after);
  return Number.isInteger(n) && n > 0 && String(n) === after ? n : undefined;
}

/**
 * Derive the bench branch base name for an issue, preserving the historical
 * naming per integration: GitHub issues `issue-<n>-<slug>`, security alerts
 * `<category>-<n>-<slug>`, everything else `<slug(externalId)>-<slug>`. Never
 * ends in a bare hyphen when the title slugifies to empty. Naming only; no
 * network or integration behavior beyond the externalId shape.
 */
function branchBaseForIssue(issue: NormalizedIssue): string {
  const titleSlug = slugify(issue.title);
  const join = (prefix: string) => (titleSlug ? `${prefix}-${titleSlug}` : prefix);

  const alert = parseAlertExternalId(issue.externalId);
  if (alert) return join(`${alert.category}-${alert.alertNumber}`);

  const num = numericIdFromExternalId(issue.externalId);
  if (issue.integrationId === "github-com" && num !== undefined) return join(`issue-${num}`);

  return join(slugify(issue.externalId));
}

/**
 * Unified create-and-assign flow for an issue from any active integration
 * plugin. `issue` is the NormalizedIssue already fetched (and, for alerts,
 * redacted) by the active plugin's `getIssue`, so the host never reaches into a
 * specific integration's API. Derives the bench's `number` (GitHub issue or
 * alert number; absent for key-based integrations like Jira) and branch name
 * from the issue, and seeds GitHub linked PRs best-effort when applicable.
 */
export async function createBenchAndAssignFromIssue(
  projectId: string,
  issue: NormalizedIssue,
  comments: Array<{ user: string; body: string }>,
  conflictResolution?: "resume" | "new",
): Promise<CreateBenchWithIssueResponse> {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new ServiceError(404, "Project config not found");
  if (!project.config.project.repo) throw new ServiceError(400, "Project has no repo configured");

  const projectName = project.config.project.displayName;
  const issueType = issue.issueType ?? null;
  const isAlert = isAlertExternalId(issue.externalId);
  const number = isAlert
    ? parseAlertExternalId(issue.externalId)?.alertNumber
    : numericIdFromExternalId(issue.externalId);

  // Just-in-time open-check (integration-agnostic), keyed on the plugin's
  // normalized state. Alerts are exempt: the cut list only surfaces open alerts
  // and their state vocabulary differs.
  if (!isAlert && DONE_STATUSES.has(issue.currentState.toLowerCase())) {
    throw new ServiceError(
      409,
      `Issue ${issue.externalId} is not open (state: ${issue.currentState})`,
    );
  }

  const branchResult = await resolveBranchNameForCreate(
    project.repoPath,
    branchBaseForIssue(issue),
    conflictResolution,
  );
  if (branchResult.status === "conflict") {
    return branchResult;
  }

  const bench = benchManager.createBench(projectId, branchResult.branchName);

  // Linked PRs are a GitHub repo-domain concept (not in the plugin contract).
  // Seed best-effort for real GitHub issues only, gated on the GitHub token.
  let linkedPullRequests: Array<{ repoFullName: string; number: number }> | undefined;
  if (
    !isAlert &&
    number !== undefined &&
    issue.integrationId === "github-com" &&
    githubService.getGithubToken() &&
    project.config.project.repo
  ) {
    linkedPullRequests = await githubService.fetchLinkedPullRequests(
      project.config.project.repo,
      number,
    );
  }

  // Persist the redacted alert raw (re-injection re-hydrates from it) and any
  // non-GitHub plugin's raw; a plain GitHub issue's REST raw is not persisted.
  const persistRaw = isAlert || issue.integrationId !== "github-com";

  bench.assignedIssue = {
    ...(number !== undefined ? { number } : {}),
    integrationId: issue.integrationId,
    externalId: issue.externalId,
    title: issue.title,
    issueType,
    ...(linkedPullRequests ? { linkedPullRequests } : {}),
    ...(persistRaw ? { raw: issue.raw } : {}),
  };

  return finalizeAssignedBench(
    projectId,
    bench,
    projectName,
    project.config,
    {
      number,
      externalId: issue.externalId,
      title: issue.title,
      // Alerts re-derive the body from the redacted raw; other integrations use
      // the issue body directly.
      body: isAlert ? formatAlertBody(issue) : issue.body,
      htmlUrl: issue.externalUrl,
    },
    comments,
    issueType,
  );
}

export async function assignIssue(
  projectId: string,
  benchId: number,
  issue: NormalizedIssue,
  comments: Array<{ user: string; body: string }>,
): Promise<AssignIssueResponse> {
  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) throw new ServiceError(404, "Bench not found");

  // Refuse a non-operable bench (blank workspacePath, see bench-operability.ts): the
  // git checkout below would otherwise run with cwd="" (the server's own repo) and
  // create/switch a branch there.
  assertBenchOperable(bench, "be assigned an issue");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new ServiceError(404, "Project config not found");
  if (!project.config.project.repo) throw new ServiceError(400, "Project has no repo configured");

  const projectName = project.config.project.displayName;
  const issueType = issue.issueType ?? null;
  const isAlert = isAlertExternalId(issue.externalId);
  const number = isAlert
    ? parseAlertExternalId(issue.externalId)?.alertNumber
    : numericIdFromExternalId(issue.externalId);

  // Branch name from the issue (preserves per-integration naming).
  const branchName = branchBaseForIssue(issue);

  // Create and checkout branch in worktree
  const checkoutResult = await runCommand(
    "git",
    ["checkout", "-b", branchName],
    bench.workspacePath,
  );
  if (checkoutResult.code !== 0) {
    // Branch might already exist, try switching to it
    const switchResult = await runCommand("git", ["checkout", branchName], bench.workspacePath);
    if (switchResult.code !== 0) {
      throw new ServiceError(422, `Failed to create/checkout branch: ${switchResult.stderr}`);
    }
  }

  // Linked PRs are GitHub repo-domain; seed best-effort for real GitHub issues.
  let linkedPullRequests: Array<{ repoFullName: string; number: number }> | undefined;
  if (
    !isAlert &&
    number !== undefined &&
    issue.integrationId === "github-com" &&
    githubService.getGithubToken()
  ) {
    linkedPullRequests = await githubService.fetchLinkedPullRequests(
      project.config.project.repo,
      number,
    );
  }

  const persistRaw = isAlert || issue.integrationId !== "github-com";

  // Update bench
  bench.branch = branchName;
  bench.assignedIssue = {
    ...(number !== undefined ? { number } : {}),
    integrationId: issue.integrationId,
    externalId: issue.externalId,
    title: issue.title,
    issueType,
    ...(linkedPullRequests ? { linkedPullRequests } : {}),
    ...(persistRaw ? { raw: issue.raw } : {}),
  };

  // Persist changes
  persistBenchIfLive({
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
  });

  const {
    sessionId: terminalSessionId,
    jigId,
    jigSource,
  } = buildAndStartClaudeSession(
    projectId,
    benchId,
    bench,
    projectName,
    project.config,
    {
      number,
      externalId: issue.externalId,
      title: issue.title,
      body: isAlert ? formatAlertBody(issue) : issue.body,
      htmlUrl: issue.externalUrl,
    },
    comments,
    issueType,
  );

  if (jigId) {
    bench.injectedJigId = jigId;
    bench.injectedJigSource = jigSource;
    persistBenchIfLive({
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
      injectedJigId: bench.injectedJigId,
      injectedJigSource: bench.injectedJigSource,
    });
  }

  return {
    bench,
    terminalSessionId,
  };
}

export async function unassignIssue(projectId: string, benchId: number): Promise<Bench> {
  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) throw new ServiceError(404, "Bench not found");

  if (!bench.assignedIssue) throw new ServiceError(400, "No issue assigned to this bench");

  bench.assignedIssue = undefined;

  persistBenchIfLive({
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
    injectedJigId: bench.injectedJigId,
    injectedJigSource: bench.injectedJigSource,
  });

  return bench;
}
