import { Router } from "express";
import * as projectRegistry from "../services/project-registry.js";
import { resolveDefaultBranch } from "../services/git-helpers.js";
import type { ProjectSettings, ProjectSettingsResponse } from "@roubo/shared";

const router = Router();

function validateProjectSettings(body: unknown): ProjectSettings | string {
  // body === null is only reachable when express.json() is not in strict mode;
  // in strict mode (the default) the middleware rejects null before we get here.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "Invalid body: must be an object";
  }
  const ALLOWED_TOP = new Set(["worktreeSource"]);
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP.has(key)) return `Unknown field: ${key}`;
  }
  const ws = (body as Record<string, unknown>).worktreeSource;
  if (ws === null || typeof ws !== "object" || Array.isArray(ws)) {
    return "Invalid worktreeSource: must be an object";
  }
  const ALLOWED_WS = new Set(["branchFromDefault", "pullLatest"]);
  for (const key of Object.keys(ws)) {
    if (!ALLOWED_WS.has(key)) return `Unknown field: worktreeSource.${key}`;
  }
  const wsObj = ws as Record<string, unknown>;
  if (typeof wsObj.branchFromDefault !== "boolean") {
    return "Invalid worktreeSource.branchFromDefault: must be a boolean";
  }
  if (typeof wsObj.pullLatest !== "boolean") {
    return "Invalid worktreeSource.pullLatest: must be a boolean";
  }
  return {
    worktreeSource: {
      branchFromDefault: wsObj.branchFromDefault,
      pullLatest: wsObj.pullLatest,
    },
  };
}

router.get("/:projectId/settings", async (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const response: ProjectSettingsResponse = { ...project.settings };
  try {
    response.defaultBranch = await resolveDefaultBranch(project.repoPath);
  } catch (err) {
    response.defaultBranchError = err instanceof Error ? err.message : String(err);
  }
  res.json(response);
});

router.put("/:projectId/settings", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const result = validateProjectSettings(req.body);
  if (typeof result === "string") {
    res.status(400).json({ error: result });
    return;
  }

  try {
    projectRegistry.updateProjectSettings(req.params.projectId, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
