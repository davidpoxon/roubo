import { expect, test } from "@playwright/test";
import {
  fetchPluginEnableState,
  registerFixtureProject,
  resetWithScenario,
} from "./_support/scenario.js";

// TC-154 (#222, US-017, FR-061, NFR-024): the project-load Enable prompt's
// failure recovery path. When the plugin a project needs is disabled and its
// process refuses to start, clicking Enable must surface the failure inline,
// leave plugins-state.json in its previous disabled state, keep the project
// from loading, and let the user dismiss the modal or open Configure to
// investigate. The fixture under e2e/fixtures/bundled-overlays/broken-plugin
// has a valid manifest (so the modal gate `installed && status === "disabled"`
// fires) but its entry script exits non-zero on launch, forcing the host's
// spawn attempt to fail. The /test/__reset handler seeds this plugin as
// "disabled" so the modal renders.
//
// Companion coverage:
//  - EnablePluginPromptModal.test.tsx asserts inline-error rendering given a
//    rejected enable mutation (unit-level).
//  - plugin-manager.test.ts pins the NFR-024 invariant at the server level
//    (enable() throws on spawn failure and does not mutate plugins-state.json).
//  This spec is the end-to-end glue: real browser, real server, real fixture.

const SCENARIO = "broken-plugin-enable-failure";
const NOW = "2026-05-26T09:00:00.000Z";
const PROJECT_ID = "tc-154-broken";
const PLUGIN_ID = "broken-plugin";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("Enable click surfaces spawn failure inline and leaves plugins-state.json untouched", async ({
  page,
  request,
}) => {
  await registerFixtureProject(request, { projectId: PROJECT_ID, plugin: PLUGIN_ID });

  const baseline = await fetchPluginEnableState(request);
  expect(baseline[PLUGIN_ID]).toBe("disabled");

  await page.goto(`/projects/${PROJECT_ID}`);

  const modal = page.getByTestId("enable-plugin-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("enable-plugin-error")).toBeHidden();

  await page.getByTestId("enable-plugin-confirm").click();

  const errorBlock = page.getByTestId("enable-plugin-error");
  await expect(errorBlock).toBeVisible();
  await expect(errorBlock).toContainText(/failed to start|intentional TC-154|exited/i);

  // Screen 24: modal stays mounted with both actions enabled so the user can
  // retry or dismiss without reloading.
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("enable-plugin-confirm")).toBeEnabled();
  await expect(page.getByTestId("enable-plugin-cancel")).toBeEnabled();

  // NFR-024: the on-disk file must remain in its previous (disabled) state.
  const after = await fetchPluginEnableState(request);
  expect(after[PLUGIN_ID]).toBe("disabled");

  // The modal blocks the project view from rendering its bench area while it
  // is mounted; clicking Cancel closes the modal (user dismissal) and the
  // project still cannot load because the plugin remains disabled.
  await page.getByTestId("enable-plugin-cancel").click();
  await expect(modal).toBeHidden();
});
