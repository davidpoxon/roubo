import { expect, type APIRequestContext } from "@playwright/test";

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
 * shape (`projectName`, `pluginId`, optional `integrationConfig`) is migrated
 * to main's `{ projectId, plugin }` contract. The `integrationConfig` field
 * the older callers passed is no longer applied — the canonical fixture
 * route only writes `{ plugin }`, which is sufficient for the IssueSourceTile
 * to render the configured variant against the stubbed plugin scenario data.
 */
export async function registerTestProject(
  request: APIRequestContext,
  opts: RegisterTestProjectOptions,
): Promise<RegisterTestProjectResult> {
  const projectId = opts.projectId ?? opts.projectName;
  const plugin = opts.plugin ?? opts.pluginId;
  if (!projectId || !plugin) {
    throw new Error("registerTestProject requires projectId (or projectName) and plugin (or pluginId)");
  }
  return await registerFixtureProject(request, { projectId, plugin });
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
