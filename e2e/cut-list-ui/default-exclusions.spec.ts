import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject, unregisterTestProject } from "./_support/project.js";

// TC-173 (US-018/US-019, FR-062/063/064): the root-level `excludedStatuses`
// (here "Closed" + "In review", set by the fixture project's roubo.yaml)
// resolves through the three-layer merge and flows back through the
// integration endpoint. Rewriting it via PUT /config/raw re-flows the new
// effective list.
//
// NOTE (#354 / WU-005): status exclusion is no longer applied client-side. It
// moved into the query (FR-009), so there is no "Include hidden statuses"
// toggle and the cut-list UI no longer hides issues on its own. The
// server-side cut-list exclusion UI journeys (closed issues never appear,
// editing the excluded categories) are covered by WU-009 (#358). The config
// resolution that this file still asserts remains valid and unchanged.

const SCENARIO = "cut-list-exclusions";
const NOW = "2026-05-26T09:00:00.000Z";

const ORIGINAL_YAML = `project:
  name: e2e-cut-list-project
  displayName: E2E Cut-List Project
  type: web
  repo: acme/widgets
layout:
  type: single-repo
components:
  app:
    plugin:
      id: process
    config:
      command: "echo noop"
ports:
  app:
    base: 4910
benches:
  max: 1
integration:
  plugin: e2e-stub
  sources:
    Repository:
      - "acme/widgets"
  excludedStatuses:
    - "Closed"
    - "In review"
`;

const WIDENED_YAML = `project:
  name: e2e-cut-list-project
  displayName: E2E Cut-List Project
  type: web
  repo: acme/widgets
layout:
  type: single-repo
components:
  app:
    plugin:
      id: process
    config:
      command: "echo noop"
ports:
  app:
    base: 4910
benches:
  max: 1
integration:
  plugin: e2e-stub
  sources:
    Repository:
      - "acme/widgets"
  excludedStatuses:
    - "Closed"
`;

test.describe("TC-173: cut-list default exclusions + override", () => {
  let projectId: string;

  test.beforeEach(async ({ request }) => {
    await resetWithScenario(request, SCENARIO, NOW);
    projectId = await registerTestProject(request);
  });

  test.afterEach(async ({ request }) => {
    // Restore the on-disk yaml so consecutive runs see the same baseline. The
    // unregister itself doesn't roll back file edits.
    await request.put(`/api/projects/${projectId}/config/raw`, {
      data: { yaml: ORIGINAL_YAML },
    });
    await unregisterTestProject(request);
  });

  test("default excludedStatuses are merged through the integration endpoint", async ({
    request,
  }) => {
    const res = await request.get(`/api/projects/${projectId}/integration`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { effective: { excludedStatuses?: string[] } };
    expect(body.effective.excludedStatuses).toEqual(["Closed", "In review"]);
  });

  test("rewriting the root excludedStatuses re-flows through the merge", async ({ request }) => {
    const putRes = await request.put(`/api/projects/${projectId}/config/raw`, {
      data: { yaml: WIDENED_YAML },
    });
    expect(putRes.status()).toBe(200);

    const res = await request.get(`/api/projects/${projectId}/integration`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { effective: { excludedStatuses?: string[] } };
    expect(body.effective.excludedStatuses).toEqual(["Closed"]);
  });
});
