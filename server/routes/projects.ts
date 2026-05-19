import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import * as projectRegistry from "../services/project-registry.js";
import { ProjectRegistryError } from "../services/project-registry.js";
import { parseConfig, validateConfigObject } from "../services/config-parser.js";
import { scanRepo } from "../services/repo-scanner.js";
import * as githubService from "../services/github.js";
import { atomicWrite } from "../services/state.js";
import { sendGitHubErrorResponse } from "./github-error-handler.js";
import type {
  RegisterProjectRequest,
  SaveConfigRequest,
  ValidateConfigRequest,
  CheckConfigRequest,
  ProjectIssueTypesResponse,
} from "@roubo/shared";

const router = Router();

router.get("/", (_req, res) => {
  const projects = projectRegistry.getProjects();
  res.json(projects);
});

router.post("/", (req, res) => {
  const { repoPath } = req.body as RegisterProjectRequest;

  if (!repoPath || typeof repoPath !== "string") {
    res.status(400).json({ error: "repoPath is required" });
    return;
  }

  try {
    const project = projectRegistry.registerProject(repoPath);
    res.status(201).json(project);
  } catch (err) {
    if (err instanceof ProjectRegistryError) {
      const status = err.code === "DUPLICATE" ? 409 : err.code === "PORT_CONFLICT" ? 409 : 400;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.post("/check-config", (req, res) => {
  const { repoPath } = req.body as CheckConfigRequest;
  if (!repoPath || typeof repoPath !== "string") {
    res.status(400).json({ error: "repoPath is required" });
    return;
  }
  if (!fs.existsSync(repoPath)) {
    res.json({
      hasConfig: false,
      configValid: false,
      alreadyRegistered: false,
      error: "Directory not found",
    });
    return;
  }

  const result = parseConfig(repoPath);
  if (!result.valid || !result.config) {
    const isNotFound = result.errors?.some((e) => e.includes("not found"));
    const existingProject = projectRegistry.getProjects().find((p) => p.repoPath === repoPath);
    res.json({
      hasConfig: !isNotFound,
      configValid: false,
      alreadyRegistered: !!existingProject,
      project: existingProject ?? undefined,
      error: isNotFound ? undefined : result.errors?.join("; "),
    });
    return;
  }

  const projectName = result.config.project.name;
  const existing = projectRegistry.getProject(projectName);
  const preview = {
    name: projectName,
    displayName: result.config.project.displayName,
    type: result.config.project.type,
    ports: Object.entries(result.config.ports ?? {}).map(([name, p]) => ({
      name,
      base: p.base,
    })),
    benchCap: result.config.benches.max,
  };
  res.json({
    hasConfig: true,
    configValid: true,
    projectName,
    displayName: result.config.project.displayName,
    alreadyRegistered: !!existing,
    project: existing ?? undefined,
    preview,
  });
});

router.post("/scan", async (req, res) => {
  const { repoPath } = req.body as { repoPath?: string };
  if (!repoPath || typeof repoPath !== "string") {
    res.status(400).json({ error: "repoPath is required" });
    return;
  }
  if (!fs.existsSync(repoPath)) {
    res.status(404).json({ error: `Directory not found: ${repoPath}` });
    return;
  }
  try {
    const result = await scanRepo(repoPath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/validate-config", (req, res) => {
  const { config, currentProjectId } = req.body as ValidateConfigRequest;
  if (!config) {
    res.status(400).json({ error: "config is required" });
    return;
  }

  const parseResult = validateConfigObject(config);
  const errors = parseResult.valid ? [] : (parseResult.fieldErrors ?? []);

  const portConflicts = parseResult.valid
    ? projectRegistry.checkPortConflictsForConfig(config, currentProjectId)
    : [];

  res.json({
    valid: parseResult.valid && portConflicts.length === 0,
    errors,
    portConflicts,
  });
});

router.get("/github-projects", async (req, res) => {
  const repo = req.query.repo as string | undefined;
  if (!repo || typeof repo !== "string") {
    res.status(400).json({ error: "repo query parameter is required" });
    return;
  }
  try {
    const projects = await githubService.fetchProjects(repo);
    res.json(projects);
  } catch (err) {
    sendGitHubErrorResponse(res, err);
  }
});

router.get("/:projectId/projects", async (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project?.config?.project?.repo) {
    res.status(404).json({ error: "Project not found or has no repo configured" });
    return;
  }
  try {
    const projects = await githubService.fetchProjects(project.config.project.repo);
    res.json(projects);
  } catch (err) {
    sendGitHubErrorResponse(res, err);
  }
});

router.get("/:projectId/issue-types", async (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project?.config?.project?.repo) {
    res.status(404).json({ error: "Project not found or has no repo configured" });
    return;
  }
  if (!githubService.getGithubToken()) {
    const body: ProjectIssueTypesResponse = {
      configured: false,
      reason: "not-connected",
      types: [],
    };
    res.json(body);
    return;
  }
  try {
    const data = await githubService.fetchIssueTypes(project.config.project.repo);
    res.json(data);
  } catch (err) {
    sendGitHubErrorResponse(res, err);
  }
});

router.post("/save-config", (req, res) => {
  const { repoPath, config } = req.body as SaveConfigRequest;
  if (!repoPath || !config) {
    res.status(400).json({ error: "repoPath and config are required" });
    return;
  }

  const parseResult = validateConfigObject(config);
  if (!parseResult.valid) {
    res.status(400).json({
      error: "Invalid config",
      errors: parseResult.fieldErrors ?? [],
      details: parseResult.errors ?? [],
    });
    return;
  }

  try {
    const dir = path.join(repoPath, ".roubo");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "roubo.yaml");
    const yamlContent = YAML.stringify(config, {
      indent: 2,
      lineWidth: 0,
      defaultStringType: "QUOTE_DOUBLE",
      defaultKeyType: "PLAIN",
    });
    atomicWrite(configPath, yamlContent);

    try {
      const projectId = config.project.name;
      if (projectRegistry.getProject(projectId)) {
        projectRegistry.reloadConfig(projectId);
      }
    } catch {
      // reload failed but save succeeded — not a fatal error
    }

    res.json({ path: configPath, config });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/:projectId/reload-config", (req, res) => {
  try {
    const project = projectRegistry.reloadConfig(req.params.projectId);
    res.json(project);
  } catch (err) {
    if (err instanceof ProjectRegistryError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.delete("/:projectId", (req, res) => {
  try {
    projectRegistry.unregisterProject(req.params.projectId);
    res.status(204).send();
  } catch (err) {
    if (err instanceof ProjectRegistryError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "HAS_BENCHES" ? 409 : 400;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.get("/:projectId/config", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!project.configValid) {
    res.status(400).json({ error: project.configError, configValid: false });
    return;
  }
  res.json({ config: project.config, configValid: true });
});

router.get("/:projectId/config/raw", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const configPath = path.join(project.repoPath, ".roubo", "roubo.yaml");
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    res.json({ yaml: content });
  } catch {
    res.status(404).json({ error: "Config file not found on disk" });
  }
});

router.put("/:projectId/config/raw", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { yaml: rawYaml } = req.body as { yaml: unknown };
  if (typeof rawYaml !== "string") {
    res.status(400).json({ error: "yaml must be a string" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(rawYaml);
  } catch (err) {
    const yamlErr = err as {
      linePos?: [{ line: number; col: number }, { line: number; col: number }];
      message: string;
    };
    res.status(400).json({
      yamlError: {
        line: yamlErr.linePos?.[0].line ?? 1,
        column: yamlErr.linePos?.[0].col ?? 1,
        message: yamlErr.message,
      },
    });
    return;
  }

  const parseResult = validateConfigObject(parsed);
  if (!parseResult.valid) {
    res.status(400).json({
      error: "Invalid config",
      errors: parseResult.fieldErrors ?? [],
      details: parseResult.errors ?? [],
    });
    return;
  }

  try {
    const dir = path.join(project.repoPath, ".roubo");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "roubo.yaml");
    atomicWrite(configPath, rawYaml);

    try {
      projectRegistry.reloadConfig(req.params.projectId);
    } catch {
      // reload failure is non-fatal — save succeeded
    }

    res.json({ path: configPath });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
