import { expect, type APIRequestContext } from "@playwright/test";

import type { IntegrationConfig } from "@roubo/shared";

import { registerFixtureProject } from "../../e2e-flow/_support/scenario.js";

export interface RegisterTestProjectOptions {
  // Kebab-case id forwarded as both the project name and the integration override
  // filename. Mirrors what main's `/test/__register-fixture-project` route
  // expects on `projectId`. Older WU-068 callers passed this as `projectName`;
  // both spellings are accepted for compatibility while specs migrate over.
  projectName?: string;
  projectId?: string;
  // Plugin id to pin as the active integration. Older WU-068 callers passed
  // this as `pluginId`; both spellings are accepted.
  pluginId?: string;
  plugin?: string;
  // Optional extra integration fields (instance, sources, capturedUserId,
  // etc.) merged into the saved override after `plugin`. WU-068 specs use
  // this to drive surfaces (e.g. the Source tile instance line, the
  // configured-sources list) that only render when the override carries the
  // matching value. The route rejects a nested `plugin` here; pass it via
  // the top-level `plugin` / `pluginId` field instead.
  integrationConfig?: Omit<Partial<IntegrationConfig>, "plugin">;
  // TC-164/167/177: optional `project.repo` for the generated fixture
  // roubo.yaml. Drives the github-com Configure modal's derived-sources
  // preview to its success state (sources are derived from `project.repo`).
  projectRepo?: string;
  // CLI-TC-062 (#573): optional port base for the generated fixture roubo.yaml.
  // Required when a spec registers two fixture projects at once so their port
  // ranges do not overlap (the allocator rejects overlaps).
  portBase?: number;
}

export interface RegisterTestProjectResult {
  projectId: string;
  repoPath: string;
}

/**
 * Thin wrapper around the canonical `registerFixtureProject` helper from
 * `e2e-flow/_support/scenario.ts` (which posts to
 * `/test/__register-fixture-project`, see #232). Kept here so the WU-068
 * project-settings specs can use a stable import path while the older API
 * shape (`projectName`, `pluginId`) is migrated to main's
 * `{ projectId, plugin }` contract. The `integrationConfig` field is
 * forwarded to the route, which merges it into the persisted override
 * alongside `plugin` so specs can pin `instance`, `sources`, and other
 * Source-tile-driven fields.
 */
export async function registerTestProject(
  request: APIRequestContext,
  opts: RegisterTestProjectOptions,
): Promise<RegisterTestProjectResult> {
  const projectId = opts.projectId ?? opts.projectName;
  const plugin = opts.plugin ?? opts.pluginId;
  if (!projectId) {
    throw new Error("registerTestProject requires projectId (or projectName)");
  }
  // TC-164: `plugin` is optional. When omitted, the fixture project is
  // registered without an integration override so the IssueSourceTile renders
  // its UnconfiguredBody variant.
  return await registerFixtureProject(request, {
    projectId,
    plugin,
    integrationConfig: opts.integrationConfig as Record<string, unknown> | undefined,
    projectRepo: opts.projectRepo,
    portBase: opts.portBase,
  });
}

/**
 * Switch the active integration plugin on a registered test-project, mimicking
 * the SwitchIntegrationDialog flow without driving the UI. Returns when the
 * server has acknowledged the new override; specs typically follow this with a
 * `page.reload()` so the React Query cache picks up the change.
 */
export async function setIntegrationPlugin(
  request: APIRequestContext,
  projectId: string,
  pluginId: string,
): Promise<void> {
  const res = await request.put(`/api/projects/${projectId}/integration/override`, {
    data: { plugin: pluginId },
  });
  expect(res.status()).toBe(200);
}
