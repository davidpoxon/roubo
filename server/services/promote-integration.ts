import type { RouboConfig } from "@roubo/shared";
import * as projectRegistry from "./project-registry.js";
import { getEffectiveWithGlobal, loadOverride } from "./integration-overrides.js";
import { validateConfigObject } from "./config-parser.js";
import { writeRouboConfig } from "./write-roubo-config.js";

export class PromoteIntegrationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PROJECT_NOT_FOUND"
      | "CONFIG_INVALID"
      | "NO_ACTIVE_PLUGIN"
      | "VALIDATION"
      | "WRITE_FAILED",
  ) {
    super(message);
    this.name = "PromoteIntegrationError";
  }
}

/**
 * Write the project's effective (override-resolved) integration plugin into
 * its committed `roubo.yaml` so teammates cloning the repo inherit the same
 * integration instead of a stale committed default.
 *
 * Promotes only the team-shareable bits: `plugin` and (when present)
 * `instance`. Tokens and other secrets are not part of the committed schema
 * and stay in the per-user override. Committed `sources` are cleared because
 * they are plugin-specific; the next source derivation repopulates them for
 * the active plugin (this mirrors the override switch, which also clears
 * sources).
 *
 * Throws `PromoteIntegrationError` for the actionable failure modes. A
 * malformed per-user override surfaces as the override loader's
 * `IntegrationOverrideError` (the caller maps it the same way the other
 * integration routes do).
 */
export function promoteIntegrationToCommitted(projectId: string): void {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new PromoteIntegrationError("Project not found", "PROJECT_NOT_FOUND");
  if (!project.config) {
    throw new PromoteIntegrationError("Project config invalid", "CONFIG_INVALID");
  }

  const effective = getEffectiveWithGlobal(project.config.integration, loadOverride(projectId));
  if (!effective.plugin) {
    throw new PromoteIntegrationError(
      "No active integration plugin to promote",
      "NO_ACTIVE_PLUGIN",
    );
  }

  const next: RouboConfig = structuredClone(project.config);
  const integration = { ...(next.integration ?? {}) };
  integration.plugin = effective.plugin;
  if (effective.instance) integration.instance = effective.instance;
  else delete integration.instance;
  delete integration.sources;
  next.integration = integration;

  const parseResult = validateConfigObject(next);
  if (!parseResult.valid) {
    throw new PromoteIntegrationError(
      parseResult.fieldErrors?.[0]?.message ?? "Promoted config failed validation",
      "VALIDATION",
    );
  }

  try {
    writeRouboConfig(project.repoPath, next);
  } catch (err) {
    throw new PromoteIntegrationError(
      `Failed to write config: ${(err as Error).message}`,
      "WRITE_FAILED",
    );
  }

  try {
    projectRegistry.reloadConfig(projectId);
  } catch {
    // Non-fatal: the on-disk write succeeded; the registry reloads on its
    // own cadence.
  }
}
