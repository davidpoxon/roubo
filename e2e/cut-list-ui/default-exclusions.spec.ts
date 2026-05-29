import { expect, test } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject, unregisterTestProject } from "./_support/project.js";

// TC-173 (US-018/US-019, FR-062/063/064, NFR-018): the cut-list hides issues
// whose currentState is in the resolved root-level `excludedStatuses` (here
// "Closed" + "In review", set by the fixture project's roubo.yaml). Toggling
// "Include hidden statuses in this view" in the filter popover widens the in-
// session view. Rewriting the root-level list via PUT /config/raw exercises
// the three-layer merge wired up by WU-048: the new effective list flows back
// through the integration endpoint and the cut-list reflects it after a
// React Query refetch.

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
    type: process
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
    type: process
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

  test("cut-list hides excluded statuses by default and widens when toggled", async ({ page }) => {
    await loadAppShell(page);
    await page.goto(`/projects/${projectId}`);

    // The four scenario issues are #1 Open, #2 In progress, #3 In review, #4 Closed.
    // Default excludedStatuses hide #3 and #4; #1 and #2 remain visible.
    await expect(page.getByText("#1", { exact: true })).toBeVisible();
    await expect(page.getByText("#2", { exact: true })).toBeVisible();
    await expect(page.getByText("#3", { exact: true })).toHaveCount(0);
    await expect(page.getByText("#4", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: /^Filter cut list/ }).click();
    // Click the visible checkbox label (React Aria Checkbox renders the input
    // behind a styled <div> overlay; clicking the input directly is
    // intercepted by that overlay).
    await page.getByText("Include hidden statuses in this view").click();

    await expect(page.getByText("#1", { exact: true })).toBeVisible();
    await expect(page.getByText("#2", { exact: true })).toBeVisible();
    await expect(page.getByText("#3", { exact: true })).toBeVisible();
    await expect(page.getByText("#4", { exact: true })).toBeVisible();
  });
});
