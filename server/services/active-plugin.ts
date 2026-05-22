import * as projectRegistry from "./project-registry.js";
import {
  getEffectiveIntegrationConfig,
  loadOverride,
  IntegrationOverrideError,
} from "./integration-overrides.js";

/** Default `listIssues` page size when neither the committed config nor the per-user override specifies one (FR-022, NFR-005). */
export const DEFAULT_PAGE_SIZE = 50;

export interface ActivePlugin {
  pluginId: string;
  integrationId: string;
  pageSize: number;
}

/**
 * Resolve the active integration plugin for a project by merging the
 * committed `roubo.yaml` integration config with the per-user override
 * file at `~/.roubo/integrations/<projectId>.yaml` (WU-004).
 *
 * Returns `null` when the project is unknown, has no parsed config, or
 * has no `integration.plugin` set after the merge. Callers should map
 * `null` to a 503 "no-active-integration" response.
 */
export function resolveActivePlugin(projectId: string): ActivePlugin | null {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return null;

  let override: ReturnType<typeof loadOverride> = null;
  try {
    override = loadOverride(projectId);
  } catch (err) {
    if (!(err instanceof IntegrationOverrideError)) throw err;
    // A malformed override file shouldn't crash the read path; fall back
    // to the committed config. Surface the schema error elsewhere (the
    // settings UI is responsible for repairing the file).
  }

  const effective = getEffectiveIntegrationConfig(project.config.integration, override);
  if (!effective.plugin) return null;

  return {
    pluginId: effective.plugin,
    integrationId: effective.plugin,
    pageSize: effective.pageSize ?? DEFAULT_PAGE_SIZE,
  };
}
