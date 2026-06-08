import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { openConfigureDialog, save } from "./_support/picker.js";
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

// The committed fixture config (e2e/fixtures/cut-list-flow-project/roubo.yaml):
// e2e-stub plugin, one repository source, and no root exclusion of its own, so
// the stub manifest's default (`["Done"]`) is what "leave Done-category
// exclusion at its default" resolves to. TC-025 edits the excluded set through
// the Configure dialog, which writes a per-user integration override; the
// `beforeEach` reset (`/test/__reset`) wipes that override so reruns are clean.
async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register cut-list fixture project").toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(PROJECT_ID);

  // Pin the plugin in a per-user override so the Configure dialog's Save
  // (PUT /integration/config) is accepted: that route refuses to write config
  // for a project with no active integration in its override (it 409s on a
  // committed-only project). The override carries only the plugin, so the
  // committed sources and the manifest's default `["Done"]` exclusion still
  // resolve through the merge (TC-024's baseline of 3 filtered is unchanged).
  const override = await request.put(`/api/projects/${PROJECT_ID}/integration/override`, {
    data: { plugin: "e2e-stub" },
  });
  expect(override.status(), "pin e2e-stub override").toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
  await registerProject(request);
});

test.afterEach(async ({ request }) => {
  // Unregister the fixture project. The exclusion edits live in a per-user
  // integration override (not roubo.yaml), and `beforeEach`'s reset wipes that
  // override, so no baseline restore is needed.
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

test("TC-025: a developer edits which status categories are excluded", async ({ page }) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  // Baseline (default Done exclusion): the in-progress issue is present.
  await expect(page.getByText("#102", { exact: true })).toBeVisible();

  // Step 1 - add the In Progress category to the excluded set through the
  // Configure dialog's status-exclusion toggle (no PUT /config/raw, AC1). Save
  // runs Verify implicitly; the scenario's connected pill lets it close. The
  // exclusion lands in the per-user override, so a full navigation re-resolves
  // the cut list (Done stays excluded too: In Progress + Done).
  const open1 = await openConfigureDialog(page, PROJECT_ID, { waitForPicker: false });
  await expect(open1.dialog.getByTestId("status-exclusion-section")).toBeVisible();
  // force: React Aria renders the checkbox as a visually-hidden input wrapped
  // in a label, so the role element isn't hit-testable; the native click still
  // fires its onChange (same pattern as the picker switch/radio specs).
  await open1.dialog.getByRole("checkbox", { name: "In Progress" }).click({ force: true });
  await save(open1.dialog);

  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByText("#101", { exact: true })).toBeVisible();
  await expect(page.getByText("#102", { exact: true })).toHaveCount(0);
  await expect(page.getByText("#103", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("excluded-count-note")).toHaveText("4 filtered out by status");

  // Step 2 - untoggle Done (include it again) through the dialog: only In
  // Progress stays excluded, so Done issues reappear while in-progress stays
  // gone. The reopened dialog seeds from the saved override, so Done reads
  // checked.
  const open2 = await openConfigureDialog(page, PROJECT_ID, { waitForPicker: false });
  await open2.dialog.getByRole("checkbox", { name: "Done" }).click({ force: true });
  await save(open2.dialog);

  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByText("#103", { exact: true })).toBeVisible();
  await expect(page.getByText("#104", { exact: true })).toBeVisible();
  await expect(page.getByText("#102", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("excluded-count-note")).toHaveText("1 filtered out by status");
});
