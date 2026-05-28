import * as projectRegistry from "./project-registry.js";
import { deriveAndPersistGithubSources } from "./derive-github-sources.js";
import {
  loadOverride,
  getEffectiveWithGlobal,
  IntegrationOverrideError,
} from "./integration-overrides.js";

const GITHUB_PLUGIN_ID = "github-com";

const pending = new Map<string, Promise<void>>();

/**
 * Subscribe plugin-specific backfills to the generic projectRegistry
 * config-loaded hook, and run a one-shot sweep over already-loaded projects.
 *
 * Call this AFTER both `projectRegistry.initialize()` and
 * `pluginManager.initialize()` have completed: the github-com backfill calls
 * `pluginManager.invoke("listSourceCandidates", ...)`, which needs a ready
 * plugin runtime.
 *
 * Today this covers a single case: projects whose active integration is
 * github-com but whose persisted config predates #278's auto-derived sources.
 * The Configure modal's Save path (`PUT /integration/fields`) already triggers
 * `deriveAndPersistGithubSources`; this hook covers everyone who has not
 * re-saved since the upgrade.
 */
export function initializeIntegrationMigrations(): void {
  projectRegistry.onProjectConfigLoaded((project) => {
    void runMigrationsFor(project.id);
  });
  for (const project of projectRegistry.getProjects()) {
    if (!project.configValid) continue;
    void runMigrationsFor(project.id);
  }
}

function runMigrationsFor(projectId: string): Promise<void> {
  const existing = pending.get(projectId);
  if (existing) return existing;

  const work = (async () => {
    try {
      const project = projectRegistry.getProject(projectId);
      if (!project?.config) return;

      let override = null;
      try {
        override = loadOverride(projectId);
      } catch (err) {
        if (!(err instanceof IntegrationOverrideError)) throw err;
      }

      const effective = getEffectiveWithGlobal(project.config.integration, override);

      if (effective.plugin === GITHUB_PLUGIN_ID && !hasAnySource(effective.sources)) {
        await deriveAndPersistGithubSources(projectId);
      }
    } catch (err) {
      // Migrations are best-effort backfills: log and move on so a single
      // failing project never produces an unhandled rejection at boot, and so
      // route handlers awaiting via `awaitPendingIntegrationSetup` proceed
      // with whatever sources they already have rather than surfacing a
      // migration-internal error to the client.
      console.warn("[integration-migrations] %s: %s", projectId, (err as Error).message);
    }
  })().finally(() => {
    pending.delete(projectId);
  });

  pending.set(projectId, work);
  return work;
}

/**
 * Source-bound route handlers call this before `resolveSources(...)` so a
 * cut-list request landing while a backfill is in flight waits for the
 * derived sources to be persisted rather than racing past with an empty set.
 */
export function awaitPendingIntegrationSetup(projectId: string): Promise<void> {
  return pending.get(projectId) ?? Promise.resolve();
}

function hasAnySource(sources: unknown): boolean {
  if (!sources || typeof sources !== "object") return false;
  for (const entries of Object.values(sources as Record<string, unknown>)) {
    if (Array.isArray(entries) && entries.length > 0) return true;
  }
  return false;
}
