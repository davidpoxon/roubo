import type { Response } from "express";
import { resolveActivePlugin, type ActivePlugin } from "../services/active-plugin.js";
import { ensurePluginActivated } from "../services/plugin-activation.js";

/**
 * Resolves the project's active integration plugin and ensures it is activated,
 * writing the appropriate error response and returning null when it cannot.
 * Shared by the issue and bench routes so both surface identical 503/502 shapes.
 */
export async function getActivePluginOrRespond(
  projectId: string,
  res: Response,
): Promise<ActivePlugin | null> {
  const active = resolveActivePlugin(projectId);
  if (!active) {
    res.status(503).json({
      error: "no-active-integration",
      message: "No integration plugin is configured for this project.",
    });
    return null;
  }
  try {
    await ensurePluginActivated(projectId, active.pluginId);
  } catch (err) {
    res.status(502).json({
      error: "plugin-activation-failed",
      message: (err as Error).message,
    });
    return null;
  }
  return active;
}
