import { expect, test } from "@playwright/test";
import {
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
} from "../e2e-flow/_support/scenario.js";

// TC-167 (US-013, FR-047/077/078/080, NFR-018): the Test connection per-category
// result strip surfaces alert-feed errors distinctly from issues. The spec
// drives a github.com source whose stored OAuth token lacks `security_events`,
// clicks Test connection, and asserts the per-category strip shows Issues OK +
// Dependabot scope-missing.
//
// #279: PR #278 removed the per-source SecurityAlertsDisclosure (and the inline
// Re-consent chip it hosted) in favour of server-side source auto-derivation.
// The result strip itself (CategoryRow) is presentation-only and unchanged, so
// this spec asserts that surface plus the read-only derived-sources preview,
// and drops the chip -> OAuth re-consent -> re-test flow that no longer has a
// UI surface (its OAuth contract is covered by unit tests).
//
// Scenario: `alerts-test-connection-scope-missing` declares a
// `probeAlertCategoriesSequence` (scope-missing -> ok); this spec only consumes
// step 0 (scope-missing), since the re-consent path that advanced the sequence
// is gone.

const SCENARIO = "alerts-test-connection-scope-missing";
const NOW = "2026-05-27T10:00:00.000Z";
const PROJECT_ID = "test-connection-per-category";
const SOURCE_EXTERNAL_ID = "acme/widgets";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);

  // Register a fixture project pinned to the github-com bundled-overlay slot,
  // with one repo source whose Dependabot toggle is on. github-com is the
  // plugin id the host's `runCategoryProbes` gates on (only the GitHub family
  // triggers `probeAlertCategories`), so the strip will surface a per-category
  // Dependabot row on the first Test connection click. `projectRepo` seeds
  // `project.repo` so the Configure modal's derived-sources preview resolves to
  // its success state.
  await registerFixtureProject(request, {
    projectId: PROJECT_ID,
    plugin: "github-com",
    projectRepo: SOURCE_EXTERNAL_ID,
    integrationConfig: {
      // The roubo.yaml `sources` map is keyed by source-candidate category id;
      // the scenario's `sourceCandidates` puts `acme/widgets` under the
      // `Repository` category, so the configured source slots in there.
      sources: {
        Repository: [
          {
            externalId: SOURCE_EXTERNAL_ID,
            includeDependabotAlerts: true,
          },
        ],
      },
    },
  });
});

test("Test connection per-category: Issues OK + Dependabot scope-missing", async ({ page }) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}/settings`);

  // Open the Configure dialog. The Issue Source tile's primary action is
  // labelled by the plugin's connection state; the pinned scenario is
  // `connected`, so the button reads "Configure".
  await page.getByRole("button", { name: "Configure" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The github-com integration-fields section renders the read-only
  // derived-sources preview (sources are auto-derived from project.repo, which
  // the fixture seeded to acme/widgets).
  const preview = dialog.getByTestId("derived-sources-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(SOURCE_EXTERNAL_ID);

  // Test connection: validateConfig + getCurrentUser succeed, and the host's
  // `runCategoryProbes` invokes the stub's `probeAlertCategories` which returns
  // step 0 of the sequence (Dependabot scope-missing). The per-category strip
  // surfaces Issues OK alongside the scope-missing Dependabot row.
  await dialog.getByTestId("test-connection").click();
  await expect(dialog.getByTestId("test-result-success")).toBeVisible();
  await expect(dialog.getByTestId("test-result-category-issues-ok")).toBeVisible();
  await expect(dialog.getByTestId("test-result-category-dependabot-scope-missing")).toBeVisible();
});
