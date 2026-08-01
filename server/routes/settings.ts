import { Router } from "express";
import { hasLegacyAgentSettings, loadSettings, saveSettings } from "../services/state.js";
import { getEnvFileKeys, getContextWindow } from "../services/env.js";
import { AGENT_TOOL_DEFAULT_AGENT, THEME_MODES } from "@roubo/shared";
import type { UserPreferences } from "@roubo/shared";
import { VALID_JIG_ID } from "./helpers.js";

/** Plugin-id shape, identical to the one the agent routes enforce. */
const VALID_PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

/** Agent tool preset id shape. Client-generated, so constrain it on the way in. */
const VALID_AGENT_TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const AGENT_TOOL_NAME_MAX = 100;

/**
 * Shape-check the app-level agent tool presets, returning an error message or
 * `undefined`. Every message names the offending preset by index so a client
 * posting a list gets a pointer, not a verdict on the whole array.
 */
function validateAgentTools(agentTools: unknown): string | undefined {
  if (!Array.isArray(agentTools)) return "Invalid agentTools: must be an array";
  const seen = new Set<string>();
  for (const [index, entry] of agentTools.entries()) {
    const at = `agentTools[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `Invalid ${at}: must be an object`;
    }
    const preset = entry as Record<string, unknown>;
    if (typeof preset.id !== "string" || !VALID_AGENT_TOOL_ID.test(preset.id)) {
      return `Invalid ${at}.id: must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`;
    }
    if (seen.has(preset.id)) return `Invalid ${at}.id: duplicate id '${preset.id}'`;
    seen.add(preset.id);
    if (
      typeof preset.name !== "string" ||
      preset.name.trim().length === 0 ||
      preset.name.trim().length > AGENT_TOOL_NAME_MAX
    ) {
      return `Invalid ${at}.name: must be 1 to ${AGENT_TOOL_NAME_MAX} characters`;
    }
    // `default` is the sentinel that follows whichever agent is the app-level
    // default; anything else must be a concrete plugin id.
    if (
      typeof preset.agent !== "string" ||
      (preset.agent !== AGENT_TOOL_DEFAULT_AGENT && !VALID_PLUGIN_ID.test(preset.agent))
    ) {
      return `Invalid ${at}.agent: must be '${AGENT_TOOL_DEFAULT_AGENT}' or a plugin id matching /^[a-z][a-z0-9-]*$/`;
    }
    if (preset.icon !== undefined && typeof preset.icon !== "string") {
      return `Invalid ${at}.icon: must be a string or absent`;
    }
    if (
      preset.params !== undefined &&
      (preset.params === null || typeof preset.params !== "object" || Array.isArray(preset.params))
    ) {
      return `Invalid ${at}.params: must be an object or absent`;
    }
    if (preset.jig !== undefined && typeof preset.jig !== "string") {
      return `Invalid ${at}.jig: must be a string or absent`;
    }
  }
  return undefined;
}

const router = Router();

router.get("/", (_req, res) => {
  res.json({
    ...loadSettings(),
    // Read from the RAW settings file, never from the defaults-merged result:
    // `loadSettings` fills in defaults, so a merged read would report every
    // install as an upgrade and show a fresh one the notice (AP-TC-110).
    legacyAgentSettingsPresent: hasLegacyAgentSettings(),
    contextWindow: getContextWindow(),
  });
});

router.put("/", (req, res) => {
  const body = req.body as UserPreferences;
  if (!body.theme || !(THEME_MODES as readonly string[]).includes(body.theme)) {
    res
      .status(400)
      .json({ error: `Invalid theme value. Must be one of: ${THEME_MODES.join(", ")}` });
    return;
  }
  if (body.jigs !== undefined) {
    const p = body.jigs;
    if (
      p === null ||
      typeof p.autoInject !== "boolean" ||
      typeof p.autoExecute !== "boolean" ||
      (p.defaultJigId != null &&
        (typeof p.defaultJigId !== "string" || !VALID_JIG_ID.test(p.defaultJigId)))
    ) {
      res.status(400).json({
        error:
          "Invalid jig settings: autoInject and autoExecute must be booleans, defaultJigId must be a string or absent",
      });
      return;
    }
    // The default agent (AP-FR-005). Absent means no default has been chosen,
    // which is why only a non-null value is shape-checked.
    if (
      p.defaultAgentPluginId != null &&
      (typeof p.defaultAgentPluginId !== "string" || !VALID_PLUGIN_ID.test(p.defaultAgentPluginId))
    ) {
      res.status(400).json({
        error:
          "Invalid jig settings: defaultAgentPluginId must be a plugin id matching /^[a-z][a-z0-9-]*$/ or absent",
      });
      return;
    }
  }
  // App-level agent tool presets (AP-FR-008, issue #516). Validated here rather
  // than at resolution time so a malformed preset never lands in settings.json
  // in the first place; resolution's own gates cover what only the live
  // registry can decide (an uninstalled agent, params a schema rejects).
  if (body.agentTools !== undefined) {
    const error = validateAgentTools(body.agentTools);
    if (error) {
      res.status(400).json({ error });
      return;
    }
  }
  if (body.benches !== undefined) {
    if (
      body.benches === null ||
      typeof body.benches.enforceIssueDependencies !== "boolean" ||
      typeof body.benches.autoStartComponents !== "boolean"
    ) {
      res.status(400).json({
        error:
          "Invalid bench settings: enforceIssueDependencies and autoStartComponents must be booleans",
      });
      return;
    }
    const mg = body.benches.maxGlobal;
    if (
      mg !== undefined &&
      mg !== null &&
      !(typeof mg === "number" && Number.isInteger(mg) && mg >= 1)
    ) {
      res.status(400).json({
        error:
          "Invalid bench settings: benches.maxGlobal must be a positive integer (>= 1) or null.",
      });
      return;
    }
  }
  if (body.testBench !== undefined) {
    const tb = body.testBench;
    if (tb === null || typeof tb.enabled !== "boolean") {
      res.status(400).json({
        error: "Invalid testBench settings: enabled must be a boolean",
      });
      return;
    }
  }
  if (body.github !== undefined) {
    const g = body.github;
    if (
      g === null ||
      !Number.isFinite(g.issueTypesCacheTtlSeconds) ||
      !Number.isInteger(g.issueTypesCacheTtlSeconds) ||
      g.issueTypesCacheTtlSeconds < 0
    ) {
      res.status(400).json({
        error: "Invalid github settings: issueTypesCacheTtlSeconds must be a non-negative integer",
      });
      return;
    }
  }
  try {
    const current = loadSettings();
    let jigs = body.jigs ?? current.jigs;
    if (jigs) {
      // Never persist an explicit null/undefined for either default: absence is
      // the "no default chosen" signal for both the jig and the agent.
      const { defaultJigId, defaultAgentPluginId, ...rest } = jigs;
      jigs = {
        ...rest,
        ...(defaultJigId != null && { defaultJigId }),
        ...(defaultAgentPluginId != null && { defaultAgentPluginId }),
      };
    }
    let benches = body.benches ?? current.benches;
    if (benches) {
      // Never persist an explicit null/undefined maxGlobal: absence is the unlimited signal.
      const { maxGlobal, ...rest } = benches;
      benches = maxGlobal != null ? { ...rest, maxGlobal } : rest;
    }
    const updated: UserPreferences = {
      theme: body.theme,
      jigs,
      agentTools: body.agentTools ?? current.agentTools,
      benches,
      testBench: body.testBench ?? current.testBench,
      github: body.github ?? current.github,
    };
    saveSettings(updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/env-keys", (_req, res) => {
  res.json({ keys: getEnvFileKeys() });
});

export default router;
