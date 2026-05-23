import fs from "node:fs";
import type {
  AssignIssueResponse,
  CreateBenchWithIssueResponse,
  Bench,
  RouboConfig,
  JigDefaultSource,
} from "@roubo/shared";
import { CLAUDE_STARTUP_DELAY_MS } from "@roubo/shared";
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
import { loadSettings } from "./state.js";

function buildAndStartClaudeSession(
  projectId: string,
  benchId: number,
  bench: { workspacePath: string; branch: string },
  projectName: string,
  config: RouboConfig,
  issue: {
    number: number;
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
      `Failed to start Claude terminal for bench ${benchId} (issue #${issue.number}):`,
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

export async function createBenchAndAssignIssue(
  projectId: string,
  issueNumber: number,
  conflictResolution?: "resume" | "new",
): Promise<CreateBenchWithIssueResponse> {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new ServiceError(404, "Project config not found");
  if (!project.config.project.repo) throw new ServiceError(400, "Project has no repo configured");

  const repoFullName = project.config.project.repo;
  const projectName = project.config.project.displayName;

  // Just-in-time validation: fetch issue and verify it's open
  const issue = await githubService.fetchIssueDetail(repoFullName, issueNumber);
  if (issue.state !== "open") {
    throw new ServiceError(409, `Issue #${issueNumber} is not open (state: ${issue.state})`);
  }

  // Best-effort: REST fetchIssueDetail does not include issue type (GitHub Projects v2 concept only).
  // fetchIssueType catches all errors internally and returns null on failure.
  const issueType = await githubService.fetchIssueType(repoFullName, issueNumber);

  // Generate branch name
  let branchName = `issue-${issueNumber}-${slugify(issue.title)}`;

  // Check if branch already exists
  const branchCheck = await runCommand(
    "git",
    ["rev-parse", "--verify", `refs/heads/${branchName}`],
    project.repoPath,
  );
  const branchExists = branchCheck.code === 0;

  if (branchExists && !conflictResolution) {
    // Check if any existing bench is using this branch
    const existingBench = stateService.getPersistedBenches().find((s) => s.branch === branchName);
    const workspaceExists = existingBench ? fs.existsSync(existingBench.workspacePath) : false;

    return {
      status: "conflict",
      branchConflict: {
        branchExists: true,
        workspaceExists,
        branchName,
      },
    };
  }

  if (branchExists && conflictResolution === "new") {
    // Append numeric suffix
    let suffix = 2;
    let candidate = `${branchName}-${suffix}`;
    while (true) {
      const check = await runCommand(
        "git",
        ["rev-parse", "--verify", `refs/heads/${candidate}`],
        project.repoPath,
      );
      if (check.code !== 0) break;
      suffix++;
      if (suffix > 100) throw new ServiceError(409, "Too many branch name conflicts");
      candidate = `${branchName}-${suffix}`;
    }
    branchName = candidate;
  }

  // Create bench with the branch name
  const bench = benchManager.createBench(projectId, branchName);

  // Fetch linked PRs before persisting (best-effort; never throws — returns [] on failure)
  const linkedPullRequests = await githubService.fetchLinkedPullRequests(repoFullName, issueNumber);

  // Assign issue metadata including seeded linked PRs
  bench.assignedIssue = {
    number: issueNumber,
    integrationId: "github-com",
    externalId: String(issueNumber),
    title: issue.title,
    linkedPullRequests,
  };

  // Persist the assignment
  stateService.updateBench({
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

  // Fetch comments after persisting so a network failure doesn't orphan the bench
  const comments = await githubService.fetchIssueComments(repoFullName, issueNumber);
  const {
    sessionId: terminalSessionId,
    jigId,
    jigSource,
  } = buildAndStartClaudeSession(
    projectId,
    bench.id,
    bench,
    projectName,
    project.config,
    issue,
    comments,
    issueType,
  );

  if (jigId) {
    bench.injectedJigId = jigId;
    bench.injectedJigSource = jigSource;
    stateService.updateBench({
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
    status: "success",
    bench,
    terminalSessionId,
  };
}

export async function assignIssue(
  projectId: string,
  benchId: number,
  issueNumber: number,
): Promise<AssignIssueResponse> {
  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) throw new ServiceError(404, "Bench not found");

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) throw new ServiceError(404, "Project config not found");
  if (!project.config.project.repo) throw new ServiceError(400, "Project has no repo configured");

  const repoFullName = project.config.project.repo;
  const projectName = project.config.project.displayName;

  // Fetch issue details, comments, linked PRs, and issue type in parallel
  const [issue, comments, linkedPullRequests, issueType] = await Promise.all([
    githubService.fetchIssueDetail(repoFullName, issueNumber),
    githubService.fetchIssueComments(repoFullName, issueNumber),
    githubService.fetchLinkedPullRequests(repoFullName, issueNumber),
    githubService.fetchIssueType(repoFullName, issueNumber),
  ]);

  // Create branch name from issue
  const branchName = `issue-${issueNumber}-${slugify(issue.title)}`;

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

  // Update bench
  bench.branch = branchName;
  bench.assignedIssue = {
    number: issueNumber,
    integrationId: "github-com",
    externalId: String(issueNumber),
    title: issue.title,
    linkedPullRequests,
  };

  // Persist changes
  stateService.updateBench({
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
    issue,
    comments,
    issueType,
  );

  if (jigId) {
    bench.injectedJigId = jigId;
    bench.injectedJigSource = jigSource;
    stateService.updateBench({
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

  stateService.updateBench({
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
