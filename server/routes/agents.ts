import { Router } from "express";
import { z } from "zod";
import type { AgentPluginState, AgentPluginsResponse, PluginManifest } from "@roubo/shared";
import {
  describeAgentNotAvailable,
  isAgentNotAvailable,
  listAgents,
  resolveAgent,
} from "../services/agent-plugin-registry.js";
import {
  AgentOverrideError,
  getEffectiveAgentConfig,
  saveAgentConfig,
} from "../services/agent-overrides.js";
import { validateAgentConfig } from "../services/agent-config-validator.js";

// App-level agent configuration API (AP-FR-002, AP-FR-003, issue #508).
//
// Backs the Settings > AI Agents screen: the inventory of installed agent
// plugins with each one's declared configSchema and saved defaults, plus the
// per-plugin read/write of those defaults. Every plugin is addressed by id, so
// the routes are as isolated as the files behind them (AP-TC-003, AP-TC-009).

const router = Router();

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;

function badId(id: string): boolean {
  return !PLUGIN_ID_RE.test(id);
}

const SaveConfigBodySchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

function findAgentManifest(pluginId: string): PluginManifest | undefined {
  return listAgents().find((m) => m.id === pluginId);
}

function toState(manifest: PluginManifest): AgentPluginState {
  const resolved = resolveAgent(manifest.id);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    configSchema: manifest.configSchema,
    // Read per plugin id, so an unreadable file for one agent degrades to an
    // empty form for that agent alone and never breaks the whole list.
    config: getEffectiveAgentConfig(manifest.id),
    unavailable: isAgentNotAvailable(resolved)
      ? { reason: resolved.reason, message: describeAgentNotAvailable(resolved) }
      : null,
  };
}

// Zero installed agent plugins is a clean empty result, never an error: the
// screen renders its empty state from it (AP-TC-012).
router.get("/", (_req, res) => {
  const body: AgentPluginsResponse = { agents: listAgents().map(toState) };
  res.json(body);
});

router.get("/:id/config", (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!findAgentManifest(id)) {
    res.status(404).json({ error: `Unknown agent plugin: ${id}` });
    return;
  }
  res.json({ pluginId: id, config: getEffectiveAgentConfig(id) });
});

router.put("/:id/config", (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  const manifest = findAgentManifest(id);
  if (!manifest) {
    res.status(404).json({ error: `Unknown agent plugin: ${id}` });
    return;
  }

  const parsed = SaveConfigBodySchema.safeParse(req.body);
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

  // Server-side schema rejection is the primary gate (AP-TC-011). The form's
  // enum selects are the second line, not the enforcement.
  const fieldErrors = validateAgentConfig(manifest, parsed.data.config);
  if (fieldErrors.length > 0) {
    res.status(400).json({ error: "Invalid agent configuration", fieldErrors });
    return;
  }

  try {
    const saved = saveAgentConfig(id, parsed.data.config);
    res.json({ pluginId: id, config: saved.config });
  } catch (err) {
    if (err instanceof AgentOverrideError) {
      res.status(500).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
