import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import * as YAML from "yaml";
import * as projectRegistry from "../services/project-registry.js";
import { ProjectRegistryError } from "../services/project-registry.js";
import { parseConfig, validateConfigObject } from "../services/config-parser.js";
import { scanRepo } from "../services/repo-scanner.js";
import * as githubService from "../services/github.js";
import * as pluginManager from "../services/plugin-manager.js";
import { resolveActivePlugin } from "../services/active-plugin.js";
import { ensurePluginActivated, resolveSources } from "../services/plugin-activation.js";
import { awaitPendingIntegrationSetup } from "../services/integration-migrations.js";
import { atomicWrite } from "../services/state.js";
import { resolveWithin, resolveWithinRoots, allowedRoots } from "../lib/safe-path.js";
import {
  getIntegrationFields,
  setIntegrationFields,
  touchesIntegrationFields,
  IntegrationFieldsError,
} from "../services/project-integration-fields.js";
import {
  deriveAndPersistGithubSources,
  deriveGithubSources,
} from "../services/derive-github-sources.js";
import { sendGitHubErrorResponse } from "./github-error-handler.js";
import { sendPluginRpcError } from "./plugin-rpc-error.js";
import type {
  RegisterProjectRequest,
  SaveConfigRequest,
  ValidateConfigRequest,
  CheckConfigRequest,
  ProjectIssueTypesV2Response,
  IntegrationFieldsUpdate,
} from "@roubo/shared";

const router = Router();

// Defence-in-depth rate limit on the repo-scan surface. Roubo runs as a
// localhost-only service, but this handler takes a user-supplied directory path
// and walks it from disk (fs.existsSync + scanRepo), so we cap requests per
// minute per IP to keep a runaway caller from hammering the filesystem. Applied
// per-route (not router-wide) because projects.ts shares the /api/projects mount
// with the bench, terminal, inspection and other routers. Mirrors the pattern in
// plugins-github-oauth.ts and satisfies CodeQL js/missing-rate-limiting (#40).
const scanRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

/**
 * Bundled github.com / GHE plugins emit alerts as NormalizedIssue with these
 * issueType strings (see plugins/_shared-github/src/mapper.ts). They are not
 * GitHub-native Issue Types, so they never appear in the plugin's
 * listIssueTypes response; we append them here so the blueprint-by-issue-type
 * mapping UI can target alert categories.
 */
const GITHUB_FAMILY_SECURITY_ISSUE_TYPES = [
  "security-code-scanning",
  "security-secret-scanning",
  "security-dependabot",
] as const;

const GITHUB_FAMILY_PLUGIN_IDS = new Set(["github-com", "ghe"]);

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
  if (!repoPath || typeof repoPath !== "string" || repoPath.includes("\0")) {
    res.status(400).json({ error: "repoPath is required" });
    return;
  }
  // /check-config and /scan accept an arbitrary local directory path by
  // design (project registration UI). We reject NUL bytes above; we do not
  // path.resolve here because doing so turns the tainted string into a new
  // path expression that CodeQL flags at every downstream fs call without
  // adding a real trust boundary.
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

router.post("/scan", scanRateLimiter, async (req, res) => {
  const { repoPath } = req.body as { repoPath?: string };
  if (!repoPath || typeof repoPath !== "string" || repoPath.includes("\0")) {
    res.status(400).json({ error: "repoPath is required" });
    return;
  }
  // Confine the user-supplied directory to the same roots the filesystem
  // browser restricts to (home + ROUBO_FILESYSTEM_ROOTS). resolveWithinRoots
  // returns the resolved path from inside its containment-guarded branch, the
  // shape CodeQL's js/path-injection suite recognises as a sanitizer, so the
  // value reaching existsSync / scanRepo is already laundered (CodeQL #53).
  const safePath = resolveWithinRoots(allowedRoots(), repoPath);
  if (safePath === null) {
    res.status(403).json({ error: "Path is outside the allowed roots" });
    return;
  }
  if (!fs.existsSync(safePath)) {
    res.status(404).json({ error: `Directory not found: ${safePath}` });
    return;
  }
  try {
    const result = await scanRepo(safePath);
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
  const active = resolveActivePlugin(req.params.projectId);
  if (!active) {
    const body: ProjectIssueTypesV2Response = {
      configured: false,
      reason: "not-connected",
      types: [],
    };
    res.json(body);
    return;
  }

  try {
    await ensurePluginActivated(req.params.projectId, active.pluginId);
    // The plugin contract returns IssueTypeOption[] ({id, name}); the existing
    // ProjectIssueTypesV2Response shape (and the IssueTypeMappingsSection
    // component that renders it) both use string names, so flatten on the way
    // out. Without this map the client renders `{id, name}` objects directly
    // as React children and crashes with React error #31.
    await awaitPendingIntegrationSetup(req.params.projectId);
    const rawTypes = await pluginManager.invoke<Array<{ id: string; name: string }>>(
      active.pluginId,
      "listIssueTypes",
      { sources: resolveSources(req.params.projectId) },
    );
    const types = rawTypes.map((t) => t.name);
    if (GITHUB_FAMILY_PLUGIN_IDS.has(active.pluginId)) {
      // Append alert-category issue types, dedupe (case-sensitive match against
      // whatever the GitHub-native catalog returned).
      const seen = new Set(types);
      for (const securityType of GITHUB_FAMILY_SECURITY_ISSUE_TYPES) {
        if (!seen.has(securityType)) {
          types.push(securityType);
          seen.add(securityType);
        }
      }
    }
    const body: ProjectIssueTypesV2Response = { configured: true, types };
    res.json(body);
  } catch (err) {
    sendPluginRpcError(res, err);
  }
});

router.post("/save-config", (req, res) => {
  const { repoPath, config } = req.body as SaveConfigRequest;
  if (!repoPath || typeof repoPath !== "string" || repoPath.includes("\0") || !config) {
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
    const dir = resolveWithin(repoPath, ".roubo");
    fs.mkdirSync(dir, { recursive: true });
    const configPath = resolveWithin(dir, "roubo.yaml");
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
    const force = req.query.force === "true" || req.query.force === "1";
    projectRegistry.unregisterProject(req.params.projectId, { force });
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
  const configPath = resolveWithin(project.repoPath, ".roubo", "roubo.yaml");
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    res.json({ yaml: content });
  } catch {
    res.status(404).json({ error: "Config file not found on disk" });
  }
});

router.get("/:projectId/integration/fields", (req, res) => {
  try {
    const fields = getIntegrationFields(req.params.projectId);
    res.json(fields);
  } catch (err) {
    if (err instanceof IntegrationFieldsError) {
      const status =
        err.code === "PROJECT_NOT_FOUND" ? 404 : err.code === "CONFIG_INVALID" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.put("/:projectId/integration/fields", async (req, res) => {
  const update = req.body as IntegrationFieldsUpdate;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    res.status(400).json({ error: "Request body must be an object" });
    return;
  }
  try {
    const fields = setIntegrationFields(req.params.projectId, update);
    // Best-effort sources derivation: writing fields succeeded, so the response
    // is shaped from `fields` regardless of whether derivation runs. Errors
    // inside deriveAndPersistGithubSources are already logged and swallowed.
    void deriveAndPersistGithubSources(req.params.projectId);
    res.json(fields);
  } catch (err) {
    if (err instanceof IntegrationFieldsError) {
      const status =
        err.code === "PROJECT_NOT_FOUND"
          ? 404
          : err.code === "NO_ACTIVE_PLUGIN" || err.code === "PLUGIN_NOT_SUPPORTED"
            ? 409
            : err.code === "INVALID_FIELD" || err.code === "CONFIG_INVALID"
              ? 400
              : 500;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.get("/:projectId/integration/derived-sources", async (req, res) => {
  try {
    const derived = await deriveGithubSources(req.params.projectId);
    res.json(derived.preview);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Defence-in-depth rate limit on the config-write surface. Roubo runs as a
// localhost-only service, but this handler validates and writes roubo.yaml to
// disk (fs.mkdirSync + atomicWrite), so we cap requests per minute per IP to
// prevent a runaway caller from saturating disk I/O. Applied per-route (not
// router-wide) because projects.ts shares the /api/projects mount with the
// bench, terminal, inspection and other routers. Mirrors the pattern in
// plugins-github-oauth.ts and satisfies CodeQL js/missing-rate-limiting (#43).
const configRawRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.put(
  "/:projectId/config/raw",
  configRawRateLimiter,
  (req: Request<{ projectId: string }>, res: Response) => {
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

    // WU-057 migration shim: PUT /config/raw still writes the full YAML, but
    // when it touches plugin-owned fields (repo, github.project, submodules)
    // we log a one-line deprecation so call-sites can be migrated to
    // /integration/fields. Both paths write to the same roubo.yaml, so the
    // two stores never disagree during the migration window.
    if (touchesIntegrationFields(parsed)) {
      console.warn(
        `[deprecated] PUT /projects/${req.params.projectId}/config/raw set plugin-owned fields ` +
          "(repo / github.project / submodules); prefer PUT /integration/fields.",
      );
    }

    try {
      const dir = resolveWithin(project.repoPath, ".roubo");
      fs.mkdirSync(dir, { recursive: true });
      const configPath = resolveWithin(dir, "roubo.yaml");
      atomicWrite(configPath, rawYaml);

      try {
        projectRegistry.reloadConfig(req.params.projectId);
      } catch {
        // reload failure is non-fatal: save succeeded
      }

      res.json({ path: configPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

export default router;
