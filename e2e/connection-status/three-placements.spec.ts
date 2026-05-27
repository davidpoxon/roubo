import { expect, test } from "@playwright/test";
import {
  expectConnectionStatePillState,
  registerFixtureProject,
  resetWithScenario,
} from "../e2e-flow/_support/scenario.js";

// TC-168 (US-014, FR-051..FR-055): the connection-status chip surfaces in
// every placement that hosts plugin context, without the user having to
// click "Test connection". Three placements are in scope:
//   1. Settings > Plugins tile (rendered by PluginCard).
//   2. The Configure modal header (rendered by PluginConfigureDialog).
//   3. The project Issue Source tile header (rendered by IssueSourceTile).

const SCENARIO = "status-surfacing-three-placements";
const NOW = "2026-05-22T09:00:00.000Z";
const FIXTURE_PROJECT_ID = "e2e-stub-fixture";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("connected chip surfaces on the plugin card and the Configure modal header", async ({
  page,
}) => {
  // Deep-link to the Plugins tab. The default tab is "benches", and only a
  // matching hash flips the initial selection (ProjectSettings.tsx:507).
  await page.goto("/settings#plugins");

  const stubCard = page.locator('[data-testid="plugin-card"][data-plugin-id="e2e-stub"]');
  await expect(stubCard).toBeVisible();
  await expectConnectionStatePillState(stubCard, "connected");

  // Placement 2: open the Configure modal and assert the same chip in the
  // dialog header. The primary button is labelled by `primaryActionLabelFor`
  // (Configure for `connected`, Sign in again for `auth-problem`, etc.), so
  // the selector targets the button by its connected-state label.
  await stubCard.getByRole("button", { name: "Configure" }).click();
  const header = page.getByTestId("plugin-configure-dialog-header");
  await expect(header).toBeVisible();
  await expectConnectionStatePillState(header, "connected");
});

test("connected chip surfaces on the project Issue Source tile header", async ({
  page,
  request,
}) => {
  // Placement 3 needs a registered project whose active integration is the
  // e2e-stub plugin so `IssueSourceTile` renders its `configured` variant
  // (IssueSourceTile.tsx:198-203). The fixture (#232) registers the project
  // and pins the override; /test/__reset in `beforeEach` tears it down.
  const { projectId } = await registerFixtureProject(request, {
    projectId: FIXTURE_PROJECT_ID,
    plugin: "e2e-stub",
  });

  await page.goto(`/projects/${projectId}/settings`);

  const tile = page.getByTestId("issue-source-tile");
  await expect(tile).toBeVisible();
  await expectConnectionStatePillState(tile, "connected");
});
