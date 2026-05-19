import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import { Router } from "express";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as blueprintManager from "../services/blueprint-manager.js";
import * as terminalService from "../services/terminal.js";
import { buildTemplateContext, applyContainerOverrides } from "../services/config-parser.js";
import { fetchIssueContext, type IssueContext } from "../services/issue-formatting.js";
import { loadSettings, atomicWrite } from "../services/state.js";
import { parseIntParam, VALID_BLUEPRINT_ID, handleBlueprintError } from "./helpers.js";
import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";
import type {
  InjectBlueprintRequest,
  BlueprintCreateRequest,
  BlueprintUpdateRequest,
  UpdateProjectDefaultBlueprintRequest,
  UpdateProjectIssueTypeMappingsRequest,
} from "@roubo/shared";

const router = Router();

router.get("/:projectId/blueprints", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const blueprints = blueprintManager.listBlueprintsForProject(req.params.projectId);
  res.json(blueprints);
});

router.get("/:projectId/blueprints/default", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const result = blueprintManager.resolveEffectiveDefaultBlueprint(req.params.projectId);
  res.json(result);
});

router.put("/:projectId/blueprints/default", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { blueprintId } = req.body as UpdateProjectDefaultBlueprintRequest;

  if (blueprintId !== null && blueprintId !== undefined) {
    if (
      blueprintId !== GLOBAL_DEFAULT_BLUEPRINT_ID &&
      (typeof blueprintId !== "string" || !VALID_BLUEPRINT_ID.test(blueprintId))
    ) {
      res.status(400).json({ error: "Invalid blueprint id" });
      return;
    }
    if (blueprintId !== GLOBAL_DEFAULT_BLUEPRINT_ID) {
      const blueprints = blueprintManager.listBlueprintsForProject(req.params.projectId);
      const exists = blueprints.some((b) => b.id === blueprintId);
      if (!exists) {
        res.status(400).json({ error: `Blueprint '${blueprintId}' not found` });
        return;
      }
    }
  }

  try {
    const configPath = path.join(project.repoPath, ".roubo", "roubo.yaml");
    let config: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = (YAML.parse(raw) as Record<string, unknown>) ?? {};
    } catch {
      // config file doesn't exist yet — start from empty
    }

    if (blueprintId == null) {
      const blueprintsSection = config.blueprints as Record<string, unknown> | undefined;
      if (blueprintsSection) {
        delete blueprintsSection.defaultBlueprint;
        if (Object.keys(blueprintsSection).length === 0) {
          delete config.blueprints;
        }
      }
    } else {
      config.blueprints = {
        ...((config.blueprints as Record<string, unknown>) ?? {}),
        defaultBlueprint: blueprintId,
      };
    }

    const dir = path.join(project.repoPath, ".roubo");
    fs.mkdirSync(dir, { recursive: true });
    const yamlContent = YAML.stringify(config, { indent: 2, lineWidth: 0 });
    atomicWrite(configPath, yamlContent);

    try {
      projectRegistry.reloadConfig(req.params.projectId);
    } catch {
      // reload failure is non-fatal — save succeeded
    }

    res.json({ blueprintId: blueprintId ?? null });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/:projectId/blueprints/issue-type-mappings", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const mappings = project.config?.blueprints?.issueTypeMappings ?? {};
  res.json({ mappings });
});

router.put("/:projectId/blueprints/issue-type-mappings", (req, res) => {
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

  const blueprints = blueprintManager.listBlueprintsForProject(req.params.projectId);
  for (const [issueType, blueprintId] of entries) {
    if (typeof issueType !== "string" || typeof blueprintId !== "string") {
      res.status(400).json({ error: "All mapping keys and values must be strings" });
      return;
    }
    if (issueType.length > 200) {
      res.status(400).json({
        error: `Issue type key too long (max 200 characters): '${issueType.slice(0, 40)}...'`,
      });
      return;
    }
    if (blueprintId !== GLOBAL_DEFAULT_BLUEPRINT_ID) {
      if (!VALID_BLUEPRINT_ID.test(blueprintId)) {
        res.status(400).json({ error: `Invalid blueprint id: '${blueprintId}'` });
        return;
      }
      if (!blueprints.some((b) => b.id === blueprintId)) {
        res.status(400).json({ error: `Blueprint '${blueprintId}' not found` });
        return;
      }
    }
  }

  try {
    const configPath = path.join(project.repoPath, ".roubo", "roubo.yaml");
    let config: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = (YAML.parse(raw) as Record<string, unknown>) ?? {};
    } catch {
      // config file doesn't exist yet — start from empty
    }

    if (Object.keys(mappings).length === 0) {
      const blueprintsSection = config.blueprints as Record<string, unknown> | undefined;
      if (blueprintsSection) {
        delete blueprintsSection.issueTypeMappings;
        if (Object.keys(blueprintsSection).length === 0) {
          delete config.blueprints;
        }
      }
    } else {
      config.blueprints = {
        ...((config.blueprints as Record<string, unknown>) ?? {}),
        issueTypeMappings: mappings,
      };
    }

    const dir = path.join(project.repoPath, ".roubo");
    fs.mkdirSync(dir, { recursive: true });
    const yamlContent = YAML.stringify(config, { indent: 2, lineWidth: 0 });
    atomicWrite(configPath, yamlContent);

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

router.get("/:projectId/blueprints/:blueprintId", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!VALID_BLUEPRINT_ID.test(req.params.blueprintId)) {
    res.status(400).json({ error: "Invalid blueprint id" });
    return;
  }
  const blueprint = blueprintManager.getBlueprint(req.params.projectId, req.params.blueprintId);
  if (!blueprint) {
    res.status(404).json({ error: "Blueprint not found" });
    return;
  }
  res.json(blueprint);
});

router.post("/:projectId/blueprints", (req, res) => {
  try {
    const created = blueprintManager.createProjectBlueprint(
      req.params.projectId,
      req.body as BlueprintCreateRequest,
    );
    res.status(201).json(created);
  } catch (err) {
    handleBlueprintError(res, err);
  }
});

router.put("/:projectId/blueprints/:blueprintId", (req, res) => {
  if (!VALID_BLUEPRINT_ID.test(req.params.blueprintId)) {
    res.status(400).json({ error: "Invalid blueprint id" });
    return;
  }
  try {
    const updated = blueprintManager.updateProjectBlueprint(
      req.params.projectId,
      req.params.blueprintId,
      req.body as BlueprintUpdateRequest,
    );
    res.json(updated);
  } catch (err) {
    handleBlueprintError(res, err);
  }
});

router.delete("/:projectId/blueprints/:blueprintId", (req, res) => {
  if (!VALID_BLUEPRINT_ID.test(req.params.blueprintId)) {
    res.status(400).json({ error: "Invalid blueprint id" });
    return;
  }
  try {
    blueprintManager.deleteProjectBlueprint(req.params.projectId, req.params.blueprintId);
    res.status(204).send();
  } catch (err) {
    handleBlueprintError(res, err);
  }
});

router.post("/:projectId/benches/:benchId/inject-blueprint", async (req, res) => {
  let benchId: number;
  try {
    benchId = parseIntParam(req.params.benchId, "bench id");
  } catch {
    res.status(400).json({ error: "Invalid bench id" });
    return;
  }

  const projectId = req.params.projectId;
  const { blueprintId, sessionId } = req.body as InjectBlueprintRequest;

  if (!blueprintId || typeof blueprintId !== "string") {
    res.status(400).json({ error: "blueprintId is required" });
    return;
  }
  if (!VALID_BLUEPRINT_ID.test(blueprintId)) {
    res.status(400).json({ error: "Invalid blueprint id" });
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

  const blueprint = blueprintManager.getBlueprint(projectId, blueprintId);
  if (!blueprint) {
    res.status(404).json({ error: "Blueprint not found" });
    return;
  }

  const templateCtx = buildTemplateContext(project.config, benchId, bench.workspacePath);
  applyContainerOverrides(templateCtx, bench.assignedContainers);

  let issueCtx: Partial<IssueContext> = {};

  if (bench.assignedIssue && project.config.project.repo) {
    try {
      issueCtx = await fetchIssueContext(project.config.project.repo, bench.assignedIssue.number);
    } catch (err) {
      console.warn(
        `[blueprints] Failed to fetch issue #${bench.assignedIssue.number} for blueprint injection, using minimal data: ${(err as Error).message}`,
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
  const autoExecute = settings.blueprints?.autoExecute ?? true;
  const textToWrite = autoExecute ? resolved + "\r" : resolved;

  const written = terminalService.writeToSession(claudeSession.id, textToWrite);
  if (!written) {
    res.status(500).json({ error: "Failed to write to terminal session" });
    return;
  }

  res.json({ success: true, resolvedLength: resolved.length });
});

export default router;
