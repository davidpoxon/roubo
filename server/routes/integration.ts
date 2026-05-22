import { Router } from "express";
import type {
  IntegrationCaptionKey,
  IntegrationConfig,
  IntegrationOverride,
  ProjectIntegrationState,
} from "@roubo/shared";
import * as projectRegistry from "../services/project-registry.js";
import * as pluginManager from "../services/plugin-manager.js";
import {
  IntegrationOverrideError,
  getEffectiveIntegrationConfig,
  loadOverride,
  saveOverride,
} from "../services/integration-overrides.js";

const router = Router();

function isEmptyBlock(block: IntegrationConfig | null | undefined): boolean {
  if (!block) return true;
  return Object.keys(block).length === 0;
}

function deriveCaptionKey(
  committed: IntegrationConfig | null,
  override: IntegrationConfig | null,
): IntegrationCaptionKey {
  const hasCommitted = !isEmptyBlock(committed);
  const hasOverride = !isEmptyBlock(override);
  if (hasCommitted && hasOverride) return "yaml-and-override";
  if (hasCommitted) return "yaml-only";
  if (hasOverride) return "override-only";
  return "none";
}

function buildState(projectId: string): ProjectIntegrationState {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new ProjectNotFoundError();

  const committed: IntegrationConfig | null = project.config?.integration ?? null;
  const overrideEnvelope = loadOverride(projectId);
  const override: IntegrationConfig | null = overrideEnvelope?.integration ?? null;
  const effective = getEffectiveIntegrationConfig(committed ?? undefined, overrideEnvelope);

  let plugin: ProjectIntegrationState["plugin"] = null;
  if (effective.plugin) {
    const installed = pluginManager.listInstalled();
    const record = installed.find((r) => r.id === effective.plugin) ?? null;
    plugin = {
      id: effective.plugin,
      installed: record !== null,
      status: record?.status ?? null,
      manifest: record?.manifest ? { name: record.manifest.name } : null,
    };
  }

  return {
    effective,
    committed,
    override,
    plugin,
    captionKey: deriveCaptionKey(committed, override),
  };
}

class ProjectNotFoundError extends Error {
  constructor() {
    super("Project not found");
    this.name = "ProjectNotFoundError";
  }
}

router.get("/:projectId/integration", (req, res) => {
  try {
    res.json(buildState(req.params.projectId));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof IntegrationOverrideError) {
      res.status(500).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put("/:projectId/integration/override", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const body = req.body as { plugin?: unknown };
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.plugin !== "string" ||
    body.plugin.length === 0
  ) {
    res.status(400).json({ error: "Invalid body: { plugin: string } required" });
    return;
  }
  const plugin: string = body.plugin;

  try {
    // Switching the plugin clears sources (they are plugin-specific) but
    // preserves any user-set instance — the override schema lets every field
    // be independently optional.
    const existing = loadOverride(req.params.projectId);
    const next: IntegrationOverride = {
      schemaVersion: 1,
      integration: {
        ...(existing?.integration ?? {}),
        plugin,
      },
    };
    delete next.integration.sources;

    saveOverride(req.params.projectId, next);
    res.json(buildState(req.params.projectId));
  } catch (err) {
    if (err instanceof IntegrationOverrideError) {
      res.status(400).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
