import { Router } from "express";
import { getProjectPermissions, setProjectPermissions } from "../services/state.js";
import { injectPermissions } from "../services/claude-settings-local.js";
import { getBenches } from "../services/bench-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import type { ProjectPermissions } from "@roubo/shared";

const router = Router();

router.get("/:projectId/permissions", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const permissions = getProjectPermissions(req.params.projectId);
  res.json(permissions);
});

router.put("/:projectId/permissions", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const body = req.body as Partial<ProjectPermissions>;
  const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) &&
    v.length <= 100 &&
    v.every((item) => typeof item === "string" && item.length <= 512);
  // allow, deny, and ask are optional; omitted fields default to [].
  if (
    (body?.allow !== undefined && !isStringArray(body.allow)) ||
    (body?.deny !== undefined && !isStringArray(body.deny)) ||
    (body?.ask !== undefined && !isStringArray(body.ask))
  ) {
    res.status(400).json({
      error:
        "Invalid body: allow, deny, and ask must be arrays of strings (max 100 items, 512 chars each)",
    });
    return;
  }

  const permissions: ProjectPermissions = {
    allow: body?.allow ?? [],
    deny: body?.deny ?? [],
    ask: body?.ask ?? [],
  };
  try {
    setProjectPermissions(req.params.projectId, permissions);
    res.json(permissions);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/:projectId/permissions/resync", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const permissions = getProjectPermissions(req.params.projectId);
  const benches = getBenches(req.params.projectId);

  let resynced = 0;
  let skipped = 0;
  const errors: { benchId: number; message: string }[] = [];

  for (const bench of benches) {
    if (!bench.workspacePath || bench.status === "clearing") {
      skipped++;
      continue;
    }
    try {
      injectPermissions(bench.workspacePath, permissions);
      resynced++;
    } catch (err) {
      errors.push({ benchId: bench.id, message: (err as Error).message });
    }
  }

  res.json({ resynced, skipped, errors });
});

export default router;
