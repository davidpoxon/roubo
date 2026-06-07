import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";

// WU-009 (#358): the cut-list-area end-to-end journeys for category-first status
// exclusion. This mirrors the two `e2e_flow` cases in the `cut-list` area of
// `.specifications/jira-sources-scale/test-cases.json`:
//
//   TC-024 closed issues never appear in the cut list
//   TC-025 a developer edits which status categories are excluded
//
// It shares the e2e-flow harness (`_support/scenario.ts`) with the picker- and
// source-search-area journeys, so the whole suite runs under one `npx playwright
// test` (the `e2e-flow` Playwright project), satisfying AC3.
//
// Scenario `jira-sources-scale-cut-list` configures issues spanning the To Do /
// In Progress / Done status categories (including a Done-category issue whose
// status name is "Closed" and one named "Resolved", to prove exclusion is by
// category, not by status name). Exclusion is real end to end: the host resolves
// the effective excluded set from the three-layer merge and passes it into the
// stub's `listIssues`, which drops the excluded issues in-query and reports how
// many it filtered out (the count the preview banner renders).

const SCENARIO = "jira-sources-scale-cut-list";
const NOW = "2026-05-21T13:00:00.000Z";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(__dirname, "..", "fixtures", "cut-list-flow-project");
const PROJECT_ID = "e2e-cut-list-flow";

// The committed fixture config: e2e-stub plugin, one repository source, and no
// root exclusion of its own, so the stub manifest's default (`["Done"]`) is what
// "leave Done-category exclusion at its default" resolves to. TC-025 rewrites
// this via PUT /config/raw and `afterEach` restores it so reruns are clean.
const BASE_YAML = `project:
  name: e2e-cut-list-flow
  displayName: E2E Cut-List Flow
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
    base: 4920
benches:
  max: 1
integration:
  plugin: e2e-stub
  sources:
    Repository:
      - "acme/widgets"
`;

// roubo.yaml with the given excludedStatusCategories spliced into the integration
// block, used to drive TC-025's "edit which categories are excluded" steps.
function yamlWithExcluded(categories: string[]): string {
  const lines = categories.map((c) => `    - "${c}"`).join("\n");
  return `${BASE_YAML}  excludedStatusCategories:\n${lines}\n`;
}

async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register cut-list fixture project").toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(PROJECT_ID);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
  await registerProject(request);
});

test.afterEach(async ({ request }) => {
  // Restore the committed baseline so a mutated roubo.yaml doesn't leak into the
  // next run (the dev server is reused locally), then unregister.
  await request.put(`/api/projects/${PROJECT_ID}/config/raw`, { data: { yaml: BASE_YAML } });
  await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
});

test("TC-024: closed issues never appear in the cut list", async ({ page }) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  // Step 1 - leave Done-category exclusion at its default and resolve the cut
  // list. The open To Do / In Progress issues resolve; assert them first so the
  // absence checks below run against a fully loaded list, not a mid-fetch one.
  await expect(page.getByText("#101", { exact: true })).toBeVisible();
  await expect(page.getByText("#102", { exact: true })).toBeVisible();

  // No Closed/Done/Resolved issue appears: every Done-category issue is dropped
  // in-query, including the one whose status name is "Closed" and the
  // "Resolved" one (proving the filter is category-based, FR-009/FR-010).
  await expect(page.getByText("#103", { exact: true })).toHaveCount(0);
  await expect(page.getByText("#104", { exact: true })).toHaveCount(0);
  await expect(page.getByText("#105", { exact: true })).toHaveCount(0);

  // Step 2 - confirm via the preview banner: the count of issues filtered out in
  // the query is shown (three Done-category issues).
  await expect(page.getByTestId("excluded-count-note")).toHaveText("3 filtered out by status");
});

test("TC-025: a developer edits which status categories are excluded", async ({
  page,
  request,
}) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  // Baseline (default Done exclusion): the in-progress issue is present.
  await expect(page.getByText("#102", { exact: true })).toBeVisible();

  // Step 1 - toggle the In Progress category into the excluded set. The cut list
  // drops in-progress issues (Done stays excluded too). Driven through the
  // existing config-edit path; a full navigation re-resolves the cut list.
  const put1 = await request.put(`/api/projects/${PROJECT_ID}/config/raw`, {
    data: { yaml: yamlWithExcluded(["Done", "In Progress"]) },
  });
  expect(put1.status()).toBe(200);
  await page.goto(`/projects/${PROJECT_ID}`);

  await expect(page.getByText("#101", { exact: true })).toBeVisible();
  await expect(page.getByText("#102", { exact: true })).toHaveCount(0);
  await expect(page.getByText("#103", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("excluded-count-note")).toHaveText("4 filtered out by status");

  // Step 2 - toggle Done back on (include it): only In Progress stays excluded,
  // so Done issues reappear in the cut list while in-progress stays gone.
  const put2 = await request.put(`/api/projects/${PROJECT_ID}/config/raw`, {
    data: { yaml: yamlWithExcluded(["In Progress"]) },
  });
  expect(put2.status()).toBe(200);
  await page.goto(`/projects/${PROJECT_ID}`);

  await expect(page.getByText("#103", { exact: true })).toBeVisible();
  await expect(page.getByText("#104", { exact: true })).toBeVisible();
  await expect(page.getByText("#102", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("excluded-count-note")).toHaveText("1 filtered out by status");
});
