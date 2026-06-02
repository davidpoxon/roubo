import * as projectRegistry from "./project-registry.js";
import { resolveActivePlugin } from "./active-plugin.js";
import { validateConfigObject } from "./config-parser.js";
import { writeRouboConfig } from "./write-roubo-config.js";
import type { IntegrationFields, IntegrationFieldsUpdate, RouboConfig } from "@roubo/shared";

/**
 * Plugins that own the three Identity-resident fields (FR-070). The GitHub
 * family (github-com, ghe) derives its sources from the repo field on save, so
 * both own these controls; Jira will join this list as its WU lands.
 */
const PLUGINS_OWNING_FIELDS = new Set(["github-com", "ghe"]);

export class IntegrationFieldsError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PROJECT_NOT_FOUND"
      | "CONFIG_INVALID"
      | "NO_ACTIVE_PLUGIN"
      | "PLUGIN_NOT_SUPPORTED"
      | "INVALID_FIELD"
      | "WRITE_FAILED",
  ) {
    super(message);
    this.name = "IntegrationFieldsError";
  }
}

export function getIntegrationFields(projectId: string): IntegrationFields {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new IntegrationFieldsError("Project not found", "PROJECT_NOT_FOUND");
  if (!project.config) throw new IntegrationFieldsError("Project config invalid", "CONFIG_INVALID");

  const config = project.config;
  const fields: IntegrationFields = { layoutType: config.layout.type };
  if (config.project.repo) fields.repo = config.project.repo;
  if (config.project.github?.project !== undefined)
    fields.githubProject = config.project.github.project;
  if (config.layout.submodules && Object.keys(config.layout.submodules).length > 0) {
    fields.submodules = { ...config.layout.submodules };
  }
  return fields;
}

export function setIntegrationFields(
  projectId: string,
  update: IntegrationFieldsUpdate,
): IntegrationFields {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new IntegrationFieldsError("Project not found", "PROJECT_NOT_FOUND");
  if (!project.config) throw new IntegrationFieldsError("Project config invalid", "CONFIG_INVALID");

  const active = resolveActivePlugin(projectId);
  if (!active) {
    throw new IntegrationFieldsError(
      "No active integration plugin configured for this project",
      "NO_ACTIVE_PLUGIN",
    );
  }
  if (!PLUGINS_OWNING_FIELDS.has(active.pluginId)) {
    throw new IntegrationFieldsError(
      `Plugin '${active.pluginId}' does not own these fields yet`,
      "PLUGIN_NOT_SUPPORTED",
    );
  }

  validateUpdateShape(update);

  const next: RouboConfig = structuredClone(project.config);

  if (update.repo !== undefined) {
    if (update.repo === null) delete next.project.repo;
    else next.project.repo = update.repo;
  }
  if (update.githubProject !== undefined) {
    if (update.githubProject === null) delete next.project.github;
    else next.project.github = { project: update.githubProject };
  }
  if (update.submodules !== undefined) {
    if (update.submodules === null || Object.keys(update.submodules).length === 0) {
      delete next.layout.submodules;
    } else {
      next.layout.submodules = { ...update.submodules };
    }
  }

  const parseResult = validateConfigObject(next);
  if (!parseResult.valid) {
    throw new IntegrationFieldsError(
      parseResult.fieldErrors?.[0]?.message ?? "Updated config failed validation",
      "INVALID_FIELD",
    );
  }

  try {
    writeRouboConfig(project.repoPath, next);
  } catch (err) {
    throw new IntegrationFieldsError(
      `Failed to write config: ${(err as Error).message}`,
      "WRITE_FAILED",
    );
  }

  try {
    projectRegistry.reloadConfig(projectId);
  } catch {
    // Reload failure is non-fatal: the on-disk write succeeded.
  }

  // Return the just-written values directly rather than re-reading through
  // getIntegrationFields. Reload may be mocked or otherwise skipped (the
  // registry is an in-memory cache), and the caller wants the new shape, not
  // whatever the registry happens to still hold.
  const fields: IntegrationFields = { layoutType: next.layout.type };
  if (next.project.repo) fields.repo = next.project.repo;
  if (next.project.github?.project !== undefined)
    fields.githubProject = next.project.github.project;
  if (next.layout.submodules && Object.keys(next.layout.submodules).length > 0) {
    fields.submodules = { ...next.layout.submodules };
  }
  return fields;
}

function validateUpdateShape(update: IntegrationFieldsUpdate): void {
  if (update.repo !== undefined && update.repo !== null) {
    if (typeof update.repo !== "string" || update.repo.trim().length === 0) {
      throw new IntegrationFieldsError("repo must be a non-empty string", "INVALID_FIELD");
    }
  }
  if (update.githubProject !== undefined && update.githubProject !== null) {
    if (!Number.isInteger(update.githubProject) || update.githubProject <= 0) {
      throw new IntegrationFieldsError("githubProject must be a positive integer", "INVALID_FIELD");
    }
  }
  if (update.submodules !== undefined && update.submodules !== null) {
    if (typeof update.submodules !== "object" || Array.isArray(update.submodules)) {
      throw new IntegrationFieldsError(
        "submodules must be an object of alias→directory",
        "INVALID_FIELD",
      );
    }
    for (const [alias, dir] of Object.entries(update.submodules)) {
      if (
        typeof alias !== "string" ||
        alias.length === 0 ||
        typeof dir !== "string" ||
        dir.length === 0
      ) {
        throw new IntegrationFieldsError(
          "submodule alias and directory must both be non-empty strings",
          "INVALID_FIELD",
        );
      }
    }
  }
}

/**
 * True when an arbitrary parsed config touches a field that lives in the
 * integration block. The legacy `PUT /config/raw` route uses this to decide
 * whether the deprecated-shim path applies.
 */
export function touchesIntegrationFields(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  const project = (p.project ?? {}) as Record<string, unknown>;
  const layout = (p.layout ?? {}) as Record<string, unknown>;
  return (
    "repo" in project ||
    "github" in project ||
    ("submodules" in layout && layout.submodules !== undefined)
  );
}
