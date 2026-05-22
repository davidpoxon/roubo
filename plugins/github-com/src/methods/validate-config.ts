import type { ValidateConfigResult } from "@roubo/plugin-sdk";
import { parseConfig, setActiveConfig } from "../active-config.js";
import { fetchCurrentUser, fetchProjects, fetchRepoSummary } from "../github-fetchers.js";

/**
 * Validates the host-provided config and, on success, caches it as the
 * plugin's active configuration for subsequent source-scoped methods.
 *
 * Validation steps:
 *   1. Shape-check the config record into PluginConfig.
 *   2. Probe `/user` so an invalid / missing token surfaces a single clear error.
 *   3. For each configured source, probe the corresponding GitHub resource.
 *
 * Errors are accumulated per source so the host can surface a complete picture
 * (rather than failing on the first bad entry).
 */
export async function validateConfig(params: {
  config: Record<string, unknown>;
}): Promise<ValidateConfigResult> {
  const { config, errors: shapeErrors } = parseConfig(params.config);
  if (!config) {
    return { ok: false, errors: shapeErrors };
  }

  const errors: Array<{ field?: string; message: string }> = [];

  try {
    await fetchCurrentUser();
  } catch (err) {
    errors.push({ message: `Failed to authenticate with GitHub: ${(err as Error).message}` });
    return { ok: false, errors };
  }

  for (let i = 0; i < config.sources.length; i++) {
    const source = config.sources[i];
    try {
      if (source.kind === "repo") {
        await fetchRepoSummary(source.externalId);
      } else {
        const hashIdx = source.externalId.lastIndexOf("#");
        if (hashIdx === -1) {
          errors.push({
            field: `sources[${i}].externalId`,
            message: `Project externalId "${source.externalId}" missing "#<number>"`,
          });
          continue;
        }
        const owner = source.externalId.slice(0, hashIdx).replace(/\/$/, "");
        const projectNumber = Number(source.externalId.slice(hashIdx + 1));
        if (!owner || !Number.isInteger(projectNumber) || projectNumber <= 0) {
          errors.push({
            field: `sources[${i}].externalId`,
            message: `Project externalId "${source.externalId}" not in "owner/#<positive-int>" form`,
          });
          continue;
        }
        const projects = await fetchProjects(owner);
        if (!projects.find((p) => p.number === projectNumber)) {
          errors.push({
            field: `sources[${i}].externalId`,
            message: `Project #${projectNumber} not found for ${owner}`,
          });
        }
      }
    } catch (err) {
      errors.push({
        field: `sources[${i}].externalId`,
        message: `Failed to resolve ${source.kind} "${source.externalId}": ${(err as Error).message}`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  setActiveConfig(config);
  return { ok: true };
}
