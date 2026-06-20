import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { openConfigureDialog, save } from "./_support/picker.js";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";

// Issue #571 (CLI-TC-046): the only-To-Do-default end-to-end journey. This is
// the integration-level drift guard for the journey "only-To-Do default,
// re-include In Progress via config, persists per-project" (US-005 / US-007).
// It spans the two slices #558 (only-To-Do default) and #566 (per-project
// persistence) and asserts the integrated journey against the authoritative
// e2e_flow case CLI-TC-046, not whatever any single slice implemented.
//
// Both slices are merged, so the integrated behaviour already exists; this
// spec only adds the guarding test (no production source changes).
//
// It shares the e2e-flow harness (`_support/scenario.ts`) with the cut-list
// category-exclusion journeys (TC-024/TC-025 in cut-list-flow.spec.ts), so the
// whole suite runs under one `npx playwright test` (the `e2e-flow` project).
//
// Scenario `jira-sources-scale-cut-list` seeds five issues spanning the three
// canonical status categories: #101 (To Do), #102 (In Progress), and
// #103/#104/#105 (Done). The only-To-Do default does NOT come from the shared
// stub manifest (whose [Done] default TC-024/TC-025 rely on): it comes from a
// dedicated fixture project (e2e/fixtures/cut-list-only-todo-project) whose
// committed roubo.yaml sets a root `integration.excludedStatusCategories:
// ["In Progress", "Done"]`. With no per-user override of that key, the cut list
// resolves to "show To Do only".
//
// SPEC-VS-UI DIVERGENCE (documented for separate reconciliation): CLI-TC-046
// step S001-O01 expects a literal "Showing To Do only" summary, but that exact
// phrase does not exist in the shipped client. The integrated UI renders only
// the excluded-count-note banner ("N filtered out by status",
// client/src/components/IssueQueuePanel.tsx). As the drift guard, this spec
// asserts the only-To-Do state BEHAVIOURALLY (only the To Do issue visible, the
// In Progress / Done issues absent, and the excluded-count) against the real
// integrated system, rather than the literal phrase. Adding a "Showing To Do
// only" label would be slice implementation, which is out of scope for this
// e2e test-authoring unit.

const SCENARIO = "jira-sources-scale-cut-list";
const NOW = "2026-05-21T13:00:00.000Z";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(__dirname, "..", "fixtures", "cut-list-only-todo-project");
const PROJECT_ID = "e2e-cut-list-only-todo";

// Register the only-To-Do fixture project. Its committed roubo.yaml carries the
// root `excludedStatusCategories: ["In Progress", "Done"]`, which is the
// only-To-Do default the journey starts from. The Configure dialog edits write
// a per-user integration override, and `beforeEach`'s reset (`/test/__reset`)
// wipes that override so reruns start from the committed default again.
async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register only-To-Do fixture project").toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(PROJECT_ID);

  // Pin the plugin in a per-user override so the Configure dialog's Save
  // (PUT /integration/config) is accepted: that route refuses to write config
  // for a project with no active integration in its override. The override
  // carries ONLY the plugin, and the integration deep-merge replaces arrays
  // wholesale only when the override names the key, so the committed
  // `excludedStatusCategories` (the only-To-Do default) still resolves through
  // the merge until the dialog explicitly rewrites it.
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

test("CLI-TC-046: only-To-Do default, re-include In Progress via config, persists per-project", async ({
  page,
}) => {
  await loadAppShell(page);

  await test.step("S001: open cut list - only To Do is shown (only-To-Do default)", async () => {
    await page.goto(`/projects/${PROJECT_ID}`);

    // The only To Do issue resolves; assert it first so the absence checks run
    // against a fully loaded list, not a mid-fetch one. Owning slice: #558.
    await expect(
      page.getByText("#101", { exact: true }),
      "S001-O01 (#558): To Do issue #101 should be visible under the only-To-Do default",
    ).toBeVisible();

    // In Progress (#102) and every Done-category issue (#103/#104/#105) are
    // excluded in-query by the committed only-To-Do default, so none appear.
    await expect(
      page.getByText("#102", { exact: true }),
      "S001-O01 (#558): In Progress issue #102 should be hidden by the only-To-Do default",
    ).toHaveCount(0);
    await expect(page.getByText("#103", { exact: true })).toHaveCount(0);
    await expect(page.getByText("#104", { exact: true })).toHaveCount(0);
    await expect(page.getByText("#105", { exact: true })).toHaveCount(0);

    // See the SPEC-VS-UI DIVERGENCE note at the top: the shipped UI has no
    // "Showing To Do only" label, so the only-To-Do state is asserted
    // behaviourally via the excluded-count-note banner. 1 In Progress + 3 Done
    // = 4 filtered out.
    await expect(
      page.getByTestId("excluded-count-note"),
      "S001-O01 (#558): banner should report 4 (1 In Progress + 3 Done) filtered out",
    ).toHaveText("4 filtered out by status");
  });

  await test.step("S002: open the status dialog - In Progress/Done excluded, To Do locked", async () => {
    // waitForPicker: false - this journey drives the status-exclusion toggle,
    // not the source picker (same as TC-025, #452).
    const open = await openConfigureDialog(page, PROJECT_ID, { waitForPicker: false });
    await expect(
      open.dialog.getByTestId("status-exclusion-section"),
      "S002-O01 (#558): the status-exclusion section should be present",
    ).toBeVisible();

    // S002-O02: In Progress and Done read checked (excluded); To Do is the
    // actionable category, so its checkbox is disabled and never selected.
    await expect(
      open.dialog.getByRole("checkbox", { name: "In Progress" }),
      "S002-O02 (#558): In Progress should be checked (excluded) by default",
    ).toBeChecked();
    await expect(
      open.dialog.getByRole("checkbox", { name: "Done" }),
      "S002-O02 (#558): Done should be checked (excluded) by default",
    ).toBeChecked();
    await expect(
      open.dialog.getByRole("checkbox", { name: "To Do" }),
      "S002-O02 (#558): To Do should be disabled and cannot be excluded",
    ).toBeDisabled();

    // S003: uncheck In Progress (re-include it) and save. force: React Aria
    // renders the checkbox as a visually-hidden input wrapped in a label, so
    // the role element is not hit-testable; the native click still fires its
    // onChange (same pattern as the picker switch/radio specs).
    await open.dialog.getByRole("checkbox", { name: "In Progress" }).click({ force: true });
    await save(open.dialog);
  });

  await test.step("S003: re-included In Progress appears, hidden-by-status count drops", async () => {
    // The exclusion edit landed in the per-user override, so a full navigation
    // re-resolves the cut list (now only Done is excluded). Owning slice: #566.
    await page.goto(`/projects/${PROJECT_ID}`);

    await expect(
      page.getByText("#101", { exact: true }),
      "S003-O01 (#566): To Do issue #101 should remain visible",
    ).toBeVisible();
    await expect(
      page.getByText("#102", { exact: true }),
      "S003-O01 (#566): re-included In Progress issue #102 should now be visible",
    ).toBeVisible();

    // Done-category issues stay excluded.
    await expect(page.getByText("#103", { exact: true })).toHaveCount(0);
    await expect(page.getByText("#104", { exact: true })).toHaveCount(0);
    await expect(page.getByText("#105", { exact: true })).toHaveCount(0);

    // S003-O02: the hidden-by-status count drops from 4 to 3 (only the 3 Done
    // issues are excluded now).
    await expect(
      page.getByTestId("excluded-count-note"),
      "S003-O02 (#566): banner should drop to 3 (Done only) filtered out",
    ).toHaveText("3 filtered out by status");
  });

  await test.step("S004: close and reopen - In Progress remains visible (per-project persistence)", async () => {
    // Re-navigate away and back to model close/reopen. The re-inclusion was
    // persisted to the per-user override, so it survives the reload. Owning
    // slice: #566.
    await page.goto("/");
    await page.goto(`/projects/${PROJECT_ID}`);

    await expect(
      page.getByText("#102", { exact: true }),
      "S004-O01 (#566): In Progress issue #102 should persist after close/reopen",
    ).toBeVisible();
    await expect(
      page.getByTestId("excluded-count-note"),
      "S004-O01 (#566): the persisted exclusion should still report 3 filtered out",
    ).toHaveText("3 filtered out by status");
  });
});
