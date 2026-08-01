import { Router } from "express";
import { z } from "zod";
import type {
  AgentPluginState,
  AgentPluginsResponse,
  AgentPresetsResponse,
  PluginManifest,
} from "@roubo/shared";
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
import { buildCompatibilityState, warmAgentVersion } from "../services/agent-version-probe.js";
import { listAgentPresets } from "../services/agent-presets.js";

// App-level agent configuration API (AP-FR-002, AP-FR-003, issue #508).
//
// Backs the Settings > AI Agents screen: the inventory of installed agent
// plugins with each one's declared configSchema and saved defaults, plus the
// per-plugin read/write of those defaults. Every plugin is addressed by id, so
// the routes are as isolated as the files behind them (AP-TC-003, AP-TC-009).
//
// It also serves the app-scoped resolved-preset list the Settings agent tools
// listing reads (issue #672), which belongs here rather than under a project
// because app settings has no project in scope.

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
  // Manifest-declared window plus the probe. The READ is cache-only, because this
  // route is polled and probing inline would spawn an agent CLI on every refresh
  // of the AI Agents screen. When nothing is cached yet, a warm is kicked off in
  // the background instead: AP-TC-113 and AP-TC-114 expect a detected version on
  // a screen the user merely opened, so waiting for a launch would leave the card
  // reading "not detected yet" indefinitely.
  //
  // Gated on the agent actually resolving: an incompatible, errored or disabled
  // plugin is one the host refuses to run, so it must not get a manifest-declared
  // command spawned on its behalf either. Its card still renders the declared
  // window, just without a detected version.
  if (!isAgentNotAvailable(resolved)) {
    warmAgentVersion(manifest.id, manifest.agentCompatibility, manifest.agentInstallLocations);
  }
  const compatibility = buildCompatibilityState(manifest.id, manifest.agentCompatibility);
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
    ...(compatibility !== undefined && { compatibility }),
  };
}

// Zero installed agent plugins is a clean empty result, never an error: the
// screen renders its empty state from it (AP-TC-012).
router.get("/", (_req, res) => {
  const body: AgentPluginsResponse = { agents: listAgents().map(toState) };
  res.json(body);
});

// The app-scoped sibling of GET /api/projects/:projectId/agent-presets (issue
// #672). Same service, same envelope, minus the project layer: built-ins and
// app-level presets only, which is exactly the pair Settings lists. It exists so
// the app-level listing can read the server's advisory `degraded` field instead
// of re-deriving the drop client-side, which would fork preset resolution into a
// second implementation.
//
// No path conflict with `/:id/config`: that one is two segments, this is one.
router.get("/presets", (_req, res) => {
  const body: AgentPresetsResponse = { presets: listAgentPresets() };
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
