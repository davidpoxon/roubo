import fs from "node:fs";
import * as YAML from "yaml";
import { Router } from "express";
import * as projectRegistry from "../services/project-registry.js";
import { atomicWrite } from "../services/state.js";
import { resolveWithin } from "../lib/safe-path.js";

const router = Router();

const BENCH_OVERRIDE_KEYS = ["autoClear", "enforceIssueDependencies", "workUnitAutoClear"] as const;

router.get("/:projectId/benches/overrides", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const benches = project.config?.benches;
  res.json({
    autoClear: benches?.autoClear ?? null,
    enforceIssueDependencies: benches?.enforceIssueDependencies ?? null,
    workUnitAutoClear: benches?.workUnitAutoClear ?? null,
  });
});

router.put("/:projectId/benches/overrides", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;

  // Validate each supplied key
  for (const key of BENCH_OVERRIDE_KEYS) {
    if (!(key in body)) continue;
    const val = body[key];
    if (val !== null && typeof val !== "boolean") {
      res.status(400).json({ error: `${key} must be a boolean or null` });
      return;
    }
  }

  try {
    const configPath = resolveWithin(project.repoPath, ".roubo", "roubo.yaml");
    let config: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = YAML.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // config file doesn't exist yet — start from empty
    }

    const existingBenches = (config.benches ?? {}) as Record<string, unknown>;
    const keysToRemove = new Set<string>();
    const updates: Record<string, boolean> = {};

    for (const key of BENCH_OVERRIDE_KEYS) {
      if (!(key in body)) continue;
      const val = body[key] as boolean | null;
      if (val === null) {
        keysToRemove.add(key);
      } else {
        updates[key] = val;
      }
    }

    if (keysToRemove.size === 0 && Object.keys(updates).length === 0) {
      const benches = project.config?.benches;
      res.json({
        autoClear: benches?.autoClear ?? null,
        enforceIssueDependencies: benches?.enforceIssueDependencies ?? null,
        workUnitAutoClear: benches?.workUnitAutoClear ?? null,
      });
      return;
    }

    const benchesSection: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(existingBenches).filter(([k]) => !keysToRemove.has(k))),
      ...updates,
    };

    // If the result would be an empty benches object and there was nothing to
    // begin with, the nulled keys never existed — skip the write to avoid
    // writing a bare `benches: {}` that would fail schema validation (max is required).
    if (Object.keys(benchesSection).length === 0 && Object.keys(existingBenches).length === 0) {
      res.json({
        autoClear: null,
        enforceIssueDependencies: null,
        workUnitAutoClear: null,
      });
      return;
    }

    config.benches = benchesSection;

    const dir = resolveWithin(project.repoPath, ".roubo");
    fs.mkdirSync(dir, { recursive: true });
    const yamlContent = YAML.stringify(config, { indent: 2, lineWidth: 0 });
    atomicWrite(configPath, yamlContent);

    try {
      projectRegistry.reloadConfig(req.params.projectId);
    } catch {
      // reload failure is non-fatal — save succeeded
    }

    res.json({
      autoClear: (benchesSection.autoClear as boolean | undefined) ?? null,
      enforceIssueDependencies:
        (benchesSection.enforceIssueDependencies as boolean | undefined) ?? null,
      workUnitAutoClear: (benchesSection.workUnitAutoClear as boolean | undefined) ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
