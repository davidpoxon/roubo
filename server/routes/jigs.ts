import fs from "node:fs";
import * as YAML from "yaml";
import { Router } from "express";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as jigManager from "../services/jig-manager.js";
import * as terminalService from "../services/terminal.js";
import { buildTemplateContext, applyContainerOverrides } from "../services/config-parser.js";
import { fetchIssueContext, type IssueContext } from "../services/issue-formatting.js";
import { isAlertExternalId } from "../services/alert-external-id.js";
import { buildAlertIssueContext } from "../services/alert-formatting.js";
import { loadSettings } from "../services/state.js";
import { writeRouboConfig } from "../services/write-roubo-config.js";
import { parseIntParam, VALID_JIG_ID, handleJigError } from "./helpers.js";
import { resolveWithin } from "../lib/safe-path.js";
import { GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";
import type {
  InjectJigRequest,
  JigCreateRequest,
  JigUpdateRequest,
  RouboConfig,
  UpdateProjectDefaultJigRequest,
  UpdateProjectIssueTypeMappingsRequest,
} from "@roubo/shared";

const router = Router();

router.get("/:projectId/jigs", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const jigs = jigManager.listJigsForProject(req.params.projectId);
  res.json(jigs);
});

router.get("/:projectId/jigs/default", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const result = jigManager.resolveEffectiveDefaultJig(req.params.projectId);
  res.json(result);
});

router.put("/:projectId/jigs/default", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { jigId } = req.body as UpdateProjectDefaultJigRequest;

  if (jigId !== null && jigId !== undefined) {
    if (
      jigId !== GLOBAL_DEFAULT_JIG_ID &&
      (typeof jigId !== "string" || !VALID_JIG_ID.test(jigId))
    ) {
      res.status(400).json({ error: "Invalid jig id" });
      return;
    }
    if (jigId !== GLOBAL_DEFAULT_JIG_ID) {
      const jigs = jigManager.listJigsForProject(req.params.projectId);
      const exists = jigs.some((b) => b.id === jigId);
      if (!exists) {
        res.status(400).json({ error: `Jig '${jigId}' not found` });
        return;
      }
    }
  }

  try {
    const configPath = resolveWithin(project.repoPath, ".roubo", "roubo.yaml");
    let config: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = (YAML.parse(raw) as Record<string, unknown>) ?? {};
    } catch {
      // config file doesn't exist yet — start from empty
    }

    if (jigId == null) {
      const jigsSection = config.jigs as Record<string, unknown> | undefined;
      if (jigsSection) {
        delete jigsSection.defaultJig;
        if (Object.keys(jigsSection).length === 0) {
          delete config.jigs;
        }
      }
    } else {
      config.jigs = {
        ...((config.jigs as Record<string, unknown>) ?? {}),
        defaultJig: jigId,
      };
    }

    writeRouboConfig(project.repoPath, config as RouboConfig);

    try {
      projectRegistry.reloadConfig(req.params.projectId);
    } catch {
      // reload failure is non-fatal — save succeeded
    }

    res.json({ jigId: jigId ?? null });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/:projectId/jigs/issue-type-mappings", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const mappings = project.config?.jigs?.issueTypeMappings ?? {};
  res.json({ mappings });
});

router.put("/:projectId/jigs/issue-type-mappings", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { mappings } = req.body as UpdateProjectIssueTypeMappingsRequest;
  if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) {
    res.status(400).json({ error: "mappings must be an object" });
    return;
  }

  const entries = Object.entries(mappings);
  if (entries.length > 100) {
    res.status(400).json({ error: "Too many mappings (max 100)" });
    return;
  }

  const jigs = jigManager.listJigsForProject(req.params.projectId);
  for (const [issueType, jigId] of entries) {
    if (typeof issueType !== "string" || typeof jigId !== "string") {
      res.status(400).json({ error: "All mapping keys and values must be strings" });
      return;
    }
    if (issueType.length > 200) {
      res.status(400).json({
        error: `Issue type key too long (max 200 characters): '${issueType.slice(0, 40)}...'`,
      });
      return;
    }
    if (jigId !== GLOBAL_DEFAULT_JIG_ID) {
      if (!VALID_JIG_ID.test(jigId)) {
        res.status(400).json({ error: `Invalid jig id: '${jigId}'` });
        return;
      }
      if (!jigs.some((b) => b.id === jigId)) {
        res.status(400).json({ error: `Jig '${jigId}' not found` });
        return;
      }
    }
  }

  try {
    const configPath = resolveWithin(project.repoPath, ".roubo", "roubo.yaml");
    let config: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = (YAML.parse(raw) as Record<string, unknown>) ?? {};
    } catch {
      // config file doesn't exist yet — start from empty
    }

    if (Object.keys(mappings).length === 0) {
      const jigsSection = config.jigs as Record<string, unknown> | undefined;
      if (jigsSection) {
        delete jigsSection.issueTypeMappings;
        if (Object.keys(jigsSection).length === 0) {
          delete config.jigs;
        }
      }
    } else {
      config.jigs = {
        ...((config.jigs as Record<string, unknown>) ?? {}),
        issueTypeMappings: mappings,
      };
    }

    writeRouboConfig(project.repoPath, config as RouboConfig);

    try {
      projectRegistry.reloadConfig(req.params.projectId);
    } catch {
      // reload failure is non-fatal — save succeeded
    }

    res.json({ mappings });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/:projectId/jigs/:jigId", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!VALID_JIG_ID.test(req.params.jigId)) {
    res.status(400).json({ error: "Invalid jig id" });
    return;
  }
  const jig = jigManager.getJig(req.params.projectId, req.params.jigId);
  if (!jig) {
    res.status(404).json({ error: "Jig not found" });
    return;
  }
  res.json(jig);
});

router.post("/:projectId/jigs", (req, res) => {
  try {
    const created = jigManager.createProjectJig(req.params.projectId, req.body as JigCreateRequest);
    res.status(201).json(created);
  } catch (err) {
    handleJigError(res, err);
  }
});

router.put("/:projectId/jigs/:jigId", (req, res) => {
  if (!VALID_JIG_ID.test(req.params.jigId)) {
    res.status(400).json({ error: "Invalid jig id" });
    return;
  }
  try {
    const updated = jigManager.updateProjectJig(
      req.params.projectId,
      req.params.jigId,
      req.body as JigUpdateRequest,
    );
    res.json(updated);
  } catch (err) {
    handleJigError(res, err);
  }
});

router.delete("/:projectId/jigs/:jigId", (req, res) => {
  if (!VALID_JIG_ID.test(req.params.jigId)) {
    res.status(400).json({ error: "Invalid jig id" });
    return;
  }
  try {
    jigManager.deleteProjectJig(req.params.projectId, req.params.jigId);
    res.status(204).send();
  } catch (err) {
    handleJigError(res, err);
  }
});

router.post("/:projectId/benches/:benchId/inject-jig", async (req, res) => {
  let benchId: number;
  try {
    benchId = parseIntParam(req.params.benchId, "bench id");
  } catch {
    res.status(400).json({ error: "Invalid bench id" });
    return;
  }

  const projectId = req.params.projectId;
  const { jigId, sessionId } = req.body as InjectJigRequest;

  if (!jigId || typeof jigId !== "string") {
    res.status(400).json({ error: "jigId is required" });
    return;
  }
  if (!VALID_JIG_ID.test(jigId)) {
    res.status(400).json({ error: "Invalid jig id" });
    return;
  }

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) {
    res.status(404).json({ error: "Bench not found" });
    return;
  }

  const jig = jigManager.getJig(projectId, jigId);
  if (!jig) {
    res.status(404).json({ error: "Jig not found" });
    return;
  }

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
        issueCtx = await fetchIssueContext(project.config.project.repo, bench.assignedIssue.number);
      } catch (err) {
        console.warn(
          `[jigs] Failed to fetch issue #${bench.assignedIssue.number} for jig injection, using minimal data: ${(err as Error).message}`,
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
    projectName: project.config.project.displayName,
    ...issueCtx,
  });

  // Find an active Claude session for this bench
  const sessions = terminalService.getSessions(projectId, benchId);
  const claudeSession = sessionId
    ? sessions.find((s) => s.id === sessionId && s.command === "claude" && s.status === "live")
    : sessions.find((s) => s.command === "claude" && s.status === "live");
  if (!claudeSession) {
    res.status(404).json({ error: "No active Claude session found for this bench" });
    return;
  }

  const settings = loadSettings();
  const autoExecute = settings.jigs?.autoExecute ?? true;
  const textToWrite = autoExecute ? resolved + "\r" : resolved;

  const written = terminalService.writeToSession(claudeSession.id, textToWrite);
  if (!written) {
    res.status(500).json({ error: "Failed to write to terminal session" });
    return;
  }

  res.json({ success: true, resolvedLength: resolved.length });
});

export default router;
