import { Router } from "express";
import * as terminalService from "../services/terminal.js";
import * as benchManager from "../services/bench-manager.js";
import * as notificationService from "../services/notification.js";
import * as projectRegistry from "../services/project-registry.js";
import * as blueprintManager from "../services/blueprint-manager.js";
import { buildTemplateContext, applyContainerOverrides } from "../services/config-parser.js";
import { fetchIssueContext, type IssueContext } from "../services/issue-formatting.js";
import { loadSettings, getProjectPermissions } from "../services/state.js";
import { parseIntParam, VALID_BLUEPRINT_ID } from "./helpers.js";
import type { TerminalCreateRequest } from "@roubo/shared";
import { CLAUDE_STARTUP_DELAY_MS, GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";

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
  let { blueprintId } = req.body as TerminalCreateRequest;

  if (blueprintId !== undefined && !VALID_BLUEPRINT_ID.test(blueprintId)) {
    res.status(400).json({ error: "Invalid blueprint id" });
    return;
  }

  // Resolve the global-default sentinel to the project's actual default blueprint.
  if (blueprintId === GLOBAL_DEFAULT_BLUEPRINT_ID) {
    blueprintId = blueprintManager.getDefaultBlueprintId(projectId);
  }

  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) {
    res.status(404).json({ error: "Bench not found" });
    return;
  }

  const project = projectRegistry.getProject(projectId);
  const projectName = project?.config?.project?.displayName ?? projectId;

  const settings = loadSettings();
  let initialInput: string | undefined;
  let blueprintInjected = false;
  let blueprintScheduled = false;
  let sizeWarning = false;
  let scheduleWrite: ((sessionId: string) => void) | undefined;

  if (blueprintId && command === "claude" && project?.config) {
    const blueprint = blueprintManager.getBlueprint(projectId, blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }

    sizeWarning = blueprint.sizeWarning ?? false;

    const templateCtx = buildTemplateContext(project.config, benchId, bench.workspacePath);
    applyContainerOverrides(templateCtx, bench.assignedContainers);

    let issueCtx: Partial<IssueContext> = {};
    if (bench.assignedIssue && project.config.project.repo) {
      try {
        issueCtx = await fetchIssueContext(project.config.project.repo, bench.assignedIssue.number);
      } catch (err) {
        console.warn(
          `[terminal] Failed to fetch issue #${bench.assignedIssue.number} for blueprint injection: ${(err as Error).message}`,
        );
        issueCtx = {
          issueNumber: bench.assignedIssue.number,
          issueTitle: bench.assignedIssue.title,
        };
      }
    }

    const resolved = blueprintManager.resolveBlueprintContent(blueprint.content, {
      ...templateCtx,
      benchBranch: bench.branch,
      benchId,
      projectName,
      ...issueCtx,
    });

    const autoExecute = settings.blueprints?.autoExecute ?? true;

    if (autoExecute) {
      initialInput = resolved;
      blueprintInjected = true;
    } else {
      scheduleWrite = (sessionId: string) => {
        setTimeout(() => {
          terminalService.writeToSession(sessionId, resolved);
        }, CLAUDE_STARTUP_DELAY_MS);
      };
      blueprintScheduled = true;
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
    ...(blueprintInjected && { blueprintInjected: true }),
    ...(blueprintScheduled && { blueprintScheduled: true }),
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
