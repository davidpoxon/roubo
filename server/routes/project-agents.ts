import { Router } from "express";
import { z } from "zod";
import type {
  PluginManifest,
  ProjectAgentConfigResponse,
  ProjectAgentState,
  ProjectAgentsResponse,
} from "@roubo/shared";
import * as projectRegistry from "../services/project-registry.js";
import {
  describeAgentNotAvailable,
  isAgentNotAvailable,
  listAgents,
  resolveAgent,
} from "../services/agent-plugin-registry.js";
import {
  AgentProjectOverrideError,
  mergeAgentConfig,
  resolveProjectAgentConfigs,
  saveProjectAgentOverride,
} from "../services/agent-project-overrides.js";
import { getEffectiveAgentConfig } from "../services/agent-overrides.js";
import { validateAgentConfig } from "../services/agent-config-validator.js";

// Project-level agent configuration API (AP-FR-004, issue #509).
//
// Backs the Agent overrides section of project settings: for each installed
// agent plugin, its app-level defaults, this project's override subset, and the
// per-field overlay of the two. The PUT body carries the override SUBSET, not a
// whole config: a key present means the project overrides that field, and an
// empty object clears every override for that plugin.

const router = Router();

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;

const SaveOverrideBodySchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

function findAgentManifest(pluginId: string): PluginManifest | undefined {
  return listAgents().find((m) => m.id === pluginId);
}

router.get("/:projectId/agents", (req, res) => {
  const projectId = req.params.projectId;
  if (!projectRegistry.getProject(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const manifests = listAgents();
  let resolution: ReturnType<typeof resolveProjectAgentConfigs>;
  try {
    resolution = resolveProjectAgentConfigs(projectId, manifests);
  } catch (err) {
    if (err instanceof AgentProjectOverrideError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  const byId = new Map(resolution.resolved.map((entry) => [entry.pluginId, entry]));
  const agents: ProjectAgentState[] = manifests.map((manifest) => {
    const entry = byId.get(manifest.id);
    const resolved = resolveAgent(manifest.id);
    const effective = entry?.effective ?? {};
    // AP-TC-038: the launch surfaces need "installed AND configured", and only
    // the host can answer the second half (validation is Ajv against the
    // manifest). Deriving it here gives every surface one answer instead of
    // each re-implementing the check, and keeps Ajv out of the client bundle.
    // A plugin declaring no `configSchema` accepts anything, so it always reads
    // as configured, matching `agent-config-validator.ts`.
    const configErrors = validateAgentConfig(manifest, effective);
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      configSchema: manifest.configSchema,
      appDefaults: entry?.appDefaults ?? {},
      overrides: entry?.overrides ?? {},
      effective,
      unavailable: isAgentNotAvailable(resolved)
        ? { reason: resolved.reason, message: describeAgentNotAvailable(resolved) }
        : null,
      misconfigured:
        configErrors.length > 0
          ? {
              message: configErrors
                .map((err) => `${err.path || "config"}: ${err.message}`)
                .join("; "),
            }
          : null,
    };
  });

  // An orphaned override rides alongside the installed agents rather than
  // becoming one of them: no effective config is synthesised for a plugin that
  // is not installed (AP-TC-008).
  const body: ProjectAgentsResponse = { agents, orphanedOverrides: resolution.orphaned };
  res.json(body);
});

router.put("/:projectId/agents/:pluginId/config", (req, res) => {
  const projectId = req.params.projectId;
  const pluginId = req.params.pluginId;

  if (!projectRegistry.getProject(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!PLUGIN_ID_RE.test(pluginId)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  const manifest = findAgentManifest(pluginId);
  if (!manifest) {
    res.status(404).json({ error: `Unknown agent plugin: ${pluginId}` });
    return;
  }

  const parsed = SaveOverrideBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid body: { config: object } required",
      fieldErrors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  // An override value is schema-rejected host-side exactly like an app-level
  // save. The override subset is validated against the app defaults it overlays
  // rather than on its own, so a schema that marks a field required does not
  // reject a project that overrides only one other field.
  const appDefaults = getEffectiveAgentConfig(pluginId);
  const fieldErrors = validateAgentConfig(
    manifest,
    mergeAgentConfig(appDefaults, parsed.data.config),
  );
  if (fieldErrors.length > 0) {
    res.status(400).json({ error: "Invalid agent configuration", fieldErrors });
    return;
  }

  try {
    const saved = saveProjectAgentOverride(projectId, pluginId, parsed.data.config);
    const body: ProjectAgentConfigResponse = {
      projectId,
      pluginId,
      overrides: saved.config,
      effective: mergeAgentConfig(appDefaults, saved.config),
    };
    res.json(body);
  } catch (err) {
    if (err instanceof AgentProjectOverrideError) {
      const status =
        err.code === "INVALID_PROJECT_ID" || err.code === "INVALID_PLUGIN_ID" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
