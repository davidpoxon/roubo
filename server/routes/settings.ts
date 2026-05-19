import { Router } from "express";
import { loadSettings, saveSettings } from "../services/state.js";
import { getEnvFileKeys, getContextWindow } from "../services/env.js";
import {
  getClaudeAutoModeInfo,
  detectClaudeAutoMode,
  resetCache,
  type ClaudeCodeVersionInfo,
} from "../services/claude-version.js";
import { THEME_MODES } from "@roubo/shared";
import type { UserPreferences } from "@roubo/shared";
import { VALID_BLUEPRINT_ID } from "./helpers.js";

const router = Router();

router.get("/", async (_req, res) => {
  let autoModeInfo: ClaudeCodeVersionInfo;
  try {
    autoModeInfo = await getClaudeAutoModeInfo();
  } catch {
    autoModeInfo = { available: false, reason: "Version check failed" };
  }
  res.json({
    ...loadSettings(),
    claudeCodeAutoModeAvailable: autoModeInfo.available,
    ...(autoModeInfo.reason !== undefined && { claudeCodeAutoModeReason: autoModeInfo.reason }),
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
  if (body.blueprints !== undefined) {
    const p = body.blueprints;
    if (
      p === null ||
      typeof p.autoInject !== "boolean" ||
      typeof p.autoExecute !== "boolean" ||
      (p.defaultBlueprintId != null &&
        (typeof p.defaultBlueprintId !== "string" ||
          !VALID_BLUEPRINT_ID.test(p.defaultBlueprintId)))
    ) {
      res.status(400).json({
        error:
          "Invalid blueprint settings: autoInject and autoExecute must be booleans, defaultBlueprintId must be a string or absent",
      });
      return;
    }
  }
  if (body.benches !== undefined) {
    if (
      body.benches === null ||
      typeof body.benches.autoClear !== "boolean" ||
      typeof body.benches.enforceIssueDependencies !== "boolean" ||
      typeof body.benches.workUnitAutoClear !== "boolean" ||
      typeof body.benches.autoStartComponents !== "boolean"
    ) {
      res.status(400).json({
        error:
          "Invalid bench settings: autoClear, enforceIssueDependencies, workUnitAutoClear, and autoStartComponents must be booleans",
      });
      return;
    }
  }
  if (body.claudeCode !== undefined) {
    const cc = body.claudeCode;
    if (
      cc === null ||
      typeof cc.enableAutoMode !== "boolean" ||
      typeof cc.startInPlanMode !== "boolean"
    ) {
      res.status(400).json({
        error: "Invalid claudeCode settings: enableAutoMode and startInPlanMode must be booleans",
      });
      return;
    }
    if (cc.startInPlanMode && !cc.enableAutoMode) {
      res
        .status(400)
        .json({ error: "Invalid claudeCode settings: startInPlanMode requires enableAutoMode" });
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
    let blueprints = body.blueprints ?? current.blueprints;
    if (blueprints) {
      const { defaultBlueprintId, ...rest } = blueprints;
      blueprints = defaultBlueprintId != null ? { ...rest, defaultBlueprintId } : rest;
    }
    const updated: UserPreferences = {
      theme: body.theme,
      blueprints,
      benches: body.benches ?? current.benches,
      claudeCode: body.claudeCode ?? current.claudeCode,
      github: body.github ?? current.github,
    };
    saveSettings(updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/claude-code/recheck", async (_req, res) => {
  resetCache();
  let autoModeInfo: ClaudeCodeVersionInfo;
  try {
    autoModeInfo = await detectClaudeAutoMode();
  } catch {
    autoModeInfo = { available: false, reason: "Version check failed" };
  }
  res.json({
    claudeCodeAutoModeAvailable: autoModeInfo.available,
    ...(autoModeInfo.reason !== undefined && { claudeCodeAutoModeReason: autoModeInfo.reason }),
  });
});

router.get("/env-keys", (_req, res) => {
  res.json({ keys: getEnvFileKeys() });
});

export default router;
