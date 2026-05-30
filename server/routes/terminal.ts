import { Router } from "express";
import * as terminalService from "../services/terminal.js";
import * as benchManager from "../services/bench-manager.js";
import { isBenchOperable, benchNotOperableMessage } from "../services/bench-operability.js";
import * as notificationService from "../services/notification.js";
import * as projectRegistry from "../services/project-registry.js";
import * as jigManager from "../services/jig-manager.js";
import { buildTemplateContext, applyContainerOverrides } from "../services/config-parser.js";
import { fetchIssueContext, type IssueContext } from "../services/issue-formatting.js";
import { isAlertExternalId } from "../services/alert-external-id.js";
import { buildAlertIssueContext } from "../services/alert-formatting.js";
import { loadSettings, getProjectPermissions } from "../services/state.js";
import { parseIntParam, VALID_JIG_ID } from "./helpers.js";
import type { TerminalCreateRequest } from "@roubo/shared";
import { CLAUDE_STARTUP_DELAY_MS, GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";

const router = Router();

router.post("/:projectId/benches/:id/terminals", async (req, res) => {
  const { projectId } = req.params;
  let benchId: number;
  try {
    benchId = parseIntParam(req.params.id, "bench id");
  } catch {
    res.status(400).json({ error: "Invalid bench id" });
    return;
  }
  const { command } = req.body as TerminalCreateRequest;
  let { jigId } = req.body as TerminalCreateRequest;

  if (jigId !== undefined && !VALID_JIG_ID.test(jigId)) {
    res.status(400).json({ error: "Invalid jig id" });
    return;
  }

  // Resolve the global-default sentinel to the project's actual default jig.
  if (jigId === GLOBAL_DEFAULT_JIG_ID) {
    jigId = jigManager.getDefaultJigId(projectId);
  }

  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) {
    res.status(404).json({ error: "Bench not found" });
    return;
  }

  // Refuse a non-operable bench (blank workspacePath, see bench-operability.ts):
  // spawning a terminal here would set cwd="" (the server's own working directory) and
  // write .claude/settings.local.json into it.
  if (!isBenchOperable(bench)) {
    res.status(400).json({ error: benchNotOperableMessage() });
    return;
  }

  const project = projectRegistry.getProject(projectId);
  const projectName = project?.config?.project?.displayName ?? projectId;

  const settings = loadSettings();
  let initialInput: string | undefined;
  let jigInjected = false;
  let jigScheduled = false;
  let sizeWarning = false;
  let scheduleWrite: ((sessionId: string) => void) | undefined;

  if (jigId && command === "claude" && project?.config) {
    const jig = jigManager.getJig(projectId, jigId);
    if (!jig) {
      res.status(404).json({ error: "Jig not found" });
      return;
    }

    sizeWarning = jig.sizeWarning ?? false;

    const templateCtx = buildTemplateContext(project.config, benchId, bench.workspacePath);
    applyContainerOverrides(templateCtx, bench.assignedContainers);

    let issueCtx: Partial<IssueContext> = {};
    // Alert-backed benches have no GitHub issue to fetch by number, so re-hydrate
    // from the persisted redacted raw. Plain issues fetch fresh from GitHub.
    if (bench.assignedIssue) {
      if (isAlertExternalId(bench.assignedIssue.externalId)) {
        issueCtx = buildAlertIssueContext(bench.assignedIssue);
      } else if (project.config.project.repo) {
        try {
          issueCtx = await fetchIssueContext(
            project.config.project.repo,
            bench.assignedIssue.number,
          );
        } catch (err) {
          console.warn(
            `[terminal] Failed to fetch issue #${bench.assignedIssue.number} for jig injection: ${(err as Error).message}`,
          );
          issueCtx = {
            issueNumber: bench.assignedIssue.number,
            issueTitle: bench.assignedIssue.title,
          };
        }
      }
    }

    const resolved = jigManager.resolveJigContent(jig.content, {
      ...templateCtx,
      benchBranch: bench.branch,
      benchId,
      projectName,
      ...issueCtx,
    });

    const autoExecute = settings.jigs?.autoExecute ?? true;

    if (autoExecute) {
      initialInput = resolved;
      jigInjected = true;
    } else {
      scheduleWrite = (sessionId: string) => {
        setTimeout(() => {
          terminalService.writeToSession(sessionId, resolved);
        }, CLAUDE_STARTUP_DELAY_MS);
      };
      jigScheduled = true;
    }
  }

  const onClaudeExit =
    command === "claude"
      ? (sessionId: string) => {
          notificationService.createNotification(bench, "claude-exited", sessionId);
        }
      : undefined;

  const projectPermissions = command === "claude" ? getProjectPermissions(projectId) : undefined;

  let session;
  try {
    session = terminalService.createSession(
      projectId,
      benchId,
      bench.workspacePath,
      projectName,
      command,
      initialInput,
      settings.claudeCode,
      projectPermissions,
      onClaudeExit,
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(
      `[terminal] createSession failed for bench ${benchId} (cwd: ${bench.workspacePath}):`,
      err,
    );
    res.status(500).json({ error: `Terminal could not be started: ${message}` });
    return;
  }

  scheduleWrite?.(session.id);

  res.status(201).json({
    sessionId: session.id,
    label: session.label,
    wsUrl: `/ws/terminal/${session.id}`,
    ...(jigInjected && { jigInjected: true }),
    ...(jigScheduled && { jigScheduled: true }),
    ...(sizeWarning && { sizeWarning: true }),
  });
});

router.get("/:projectId/benches/:id/terminals", (req, res) => {
  let benchId: number;
  try {
    benchId = parseIntParam(req.params.id, "bench id");
  } catch {
    res.status(400).json({ error: "Invalid bench id" });
    return;
  }
  const sessions = terminalService.getSessions(req.params.projectId, benchId);
  res.json(sessions);
});

router.delete("/:projectId/benches/:id/terminals/:sid", (req, res) => {
  const destroyed = terminalService.destroySession(req.params.sid);
  if (!destroyed) {
    res.status(404).json({ error: "Terminal session not found" });
    return;
  }
  res.status(204).send();
});

export default router;
