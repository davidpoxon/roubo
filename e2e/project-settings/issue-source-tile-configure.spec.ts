import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject } from "./_support/test-project.js";

// TC-164 (US-010/US-025, FR-018/023/069/077/078, NFR-018): a project registered
// without an integration override renders the IssueSourceTile in its
// UnconfiguredBody variant. The user clicks "Choose integration", picks
// github-com via the SwitchIntegrationDialog, opens the now-visible Configure
// modal, and confirms the read-only derived-sources preview lists the project's
// registered repo. PR #278 replaced the manual SourcePicker with server-side
// auto-derivation, so the contract is now "the modal shows what Roubo will
// pull" rather than "pick a source from a list".
//
// All plugin-side data is driven by the `issue-source-tile-configure` stub
// scenario pinned via /test/__reset; the github-com overlay swap routes
// `github-com` plugin calls to the same stub runtime so the manifest name
// "GitHub.com" appears as the radio label in the SwitchIntegrationDialog. The
// fixture is registered with `projectRepo: acme/widgets` so the
// derived-sources endpoint (which reads `project.repo`) resolves to the single
// repo the scenario's `Repository` source-candidate category exposes.

const SCENARIO = "issue-source-tile-configure";
const NOW = "2026-05-27T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("unconfigured tile -> choose integration -> configure -> derived sources -> connected", async ({
  page,
  request,
}) => {
  // Register the fixture project with no plugin so the tile starts in its
  // UnconfiguredBody variant, and seed `project.repo` so the Configure modal's
  // derived-sources preview can reach its success state. The optional-`plugin`
  // contract on /test/__register-fixture-project (TC-164) is what lets the
  // project be registered without an integration override.
  const { projectId } = await registerTestProject(request, {
    projectName: "tc-164",
    projectRepo: "acme/widgets",
  });

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

  // The Configure modal opens. The github-com scenario pins a `connected`
  // connection status, so the form (and the github-com integration-fields
  // section that hosts the derived-sources preview) renders without a manual
  // Test connection step.
  const configureDialog = page.getByRole("dialog");
  await expect(configureDialog.getByTestId("plugin-configure-dialog-header")).toBeVisible();

  // Replaces the removed SourcePicker pick step: the read-only derived-sources
  // preview confirms Roubo will pull from the project's registered repo. The
  // preview query keys off the saved `project.repo` (seeded above) and narrows
  // against the scenario's `Repository` source candidates.
  const preview = configureDialog.getByTestId("derived-sources-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("acme/widgets");

  // Save closes the dialog and persists the integration config.
  await configureDialog.getByTestId("save-config").click();
  await expect(configureDialog).toBeHidden();

  // Configured variant invariant: the connection-status pill carries the
  // scenario-pinned "connected" state.
  await expect(tile.getByTestId("connection-status-pill")).toHaveAttribute(
    "data-state",
    "connected",
  );
});
