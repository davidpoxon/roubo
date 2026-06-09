import type { Response } from "express";
import type { NormalizedComment } from "@roubo/shared";
import { resolveActivePlugin, type ActivePlugin } from "../services/active-plugin.js";
import { ensurePluginActivated } from "../services/plugin-activation.js";
import * as pluginManager from "../services/plugin-manager.js";
import { isAlertExternalId } from "../services/alert-external-id.js";

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

/**
 * Resolve and activate the project's active plugin without writing any HTTP
 * response. Returns null when there is no active plugin or activation fails.
 * For best-effort, non-blocking enrichment paths (e.g. bench-detail blocking
 * info) where absence should be silent rather than a 503/502.
 */
export async function resolveActivePluginQuiet(projectId: string): Promise<ActivePlugin | null> {
  const active = resolveActivePlugin(projectId);
  if (!active) return null;
  try {
    await ensurePluginActivated(projectId, active.pluginId);
  } catch {
    return null;
  }
  return active;
}

/**
 * Best-effort fetch of an issue's comments via the active plugin, normalized to
 * the `{ user, body }` shape the create/assign flows inject into the bench's
 * first session. Alerts have no comments. Never throws: a comment-fetch failure
 * must not block bench assignment, so it resolves to an empty array.
 */
export async function fetchPluginComments(
  pluginId: string,
  externalId: string,
): Promise<Array<{ user: string; body: string }>> {
  if (isAlertExternalId(externalId)) return [];
  try {
    const raw = await pluginManager.invoke<NormalizedComment[]>(pluginId, "getComments", {
      externalId,
    });
    return raw.map((c) => ({ user: c.author.displayName, body: c.body }));
  } catch {
    return [];
  }
}
