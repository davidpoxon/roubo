import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject } from "./_support/test-project.js";

// TC-164 (US-010/US-025, FR-018/023/069/077/078, NFR-018): a project registered
// without an integration override renders the IssueSourceTile in its
// UnconfiguredBody variant. The user clicks "Choose integration", picks
// github-com via the SwitchIntegrationDialog, opens the now-visible Configure
// modal, tests the connection, picks a source from the SourcePicker, and
// saves. The tile flips to the configured variant with the connection chip in
// the connected state and the chosen source rendered in the sources list.
//
// All plugin-side data is driven by the `issue-source-tile-configure` stub
// scenario pinned via /test/__reset; the github-com overlay swap routes
// `github-com` plugin calls to the same stub runtime so the manifest name
// "GitHub.com" appears as the radio label in the SwitchIntegrationDialog.

const SCENARIO = "issue-source-tile-configure";
const NOW = "2026-05-27T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("unconfigured tile -> choose integration -> configure -> pick source -> connected", async ({
  page,
  request,
}) => {
  // Register the fixture project with no plugin so the tile starts in its
  // UnconfiguredBody variant. The new optional-`plugin` contract on
  // /test/__register-fixture-project (TC-164) is what lets the project be
  // registered without an integration override.
  const { projectId } = await registerTestProject(request, { projectName: "tc-164" });

  await page.goto(`/projects/${projectId}/settings`);

  // Unconfigured variant invariants. The choose-integration CTA is present;
  // the configured-variant primary action is not.
  const tile = page.getByTestId("issue-source-tile");
  await expect(tile).toBeVisible();
  await expect(page.getByTestId("issue-source-choose-integration")).toBeVisible();
  await expect(page.getByTestId("issue-source-primary-action")).toHaveCount(0);

  // Open the SwitchIntegrationDialog (currentPluginId=null branch shows the
  // "Choose integration" title + submit label).
  await page.getByTestId("issue-source-choose-integration").click();
  const switchDialog = page.getByRole("dialog");
  await expect(switchDialog).toBeVisible();

  // Pick github-com via its manifest name. The bundled-overlays swap keeps
  // the plugin id `github-com` but the visible name is "GitHub.com" (the
  // manifest name TC-177 pins on at github-tab-consolidation.spec.ts).
  // Click the wrapping <label> (the React Aria Radio renders a label whose
  // inner card div otherwise intercepts pointer events); switch-integration-
  // mid-flight.spec.ts uses the same pattern.
  await switchDialog.locator("label").filter({ hasText: "GitHub.com" }).click();
  await expect(switchDialog.getByRole("radio", { name: /GitHub\.com/ })).toBeChecked();
  await switchDialog.getByTestId("switch-integration-confirm").click();
  await expect(switchDialog).toBeHidden();

  // The tile re-renders into the configured variant. The primary action's
  // label depends on the live connection-status query (Connect before it
  // resolves, Configure once "connected" lands), so target by testid and
  // click regardless of label.
  const primary = page.getByTestId("issue-source-primary-action");
  await expect(primary).toBeVisible();
  await primary.click();

  // Run "Test connection" so the sources section mounts (gated on a
  // successful test in PluginConfigureDialog).
  const configureDialog = page.getByRole("dialog");
  await expect(configureDialog.getByTestId("plugin-configure-dialog-header")).toBeVisible();
  await configureDialog.getByTestId("test-connection").click();
  await expect(configureDialog.getByTestId("test-result-success")).toBeVisible();
  const sourcesSection = configureDialog.getByTestId("sources-section");
  await expect(sourcesSection).toBeVisible();

  // Pick the single scenario-provided source candidate. The ListBox item
  // renders as role="option" with the candidate label as its accessible name.
  await sourcesSection.getByRole("option", { name: "acme/widgets" }).click();

  // Save closes the dialog and persists the source selection.
  await configureDialog.getByTestId("save-config").click();
  await expect(configureDialog).toBeHidden();

  // Configured variant invariants. The connection-status pill carries the
  // scenario-pinned "connected" state and the source chip appears inside the
  // tile under the "Repo" group.
  await expect(tile.getByTestId("connection-status-pill")).toHaveAttribute(
    "data-state",
    "connected",
  );
  await expect(tile.getByText("acme/widgets")).toBeVisible();
});
