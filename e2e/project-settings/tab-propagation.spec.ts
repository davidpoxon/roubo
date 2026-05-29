import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject, setIntegrationPlugin } from "./_support/test-project.js";

// TC-182 (US-014/022, FR-069): the plugin-driven name surfaces in the Source
// section title on the per-project Settings page. The sidebar entry and page
// breadcrumb no longer carry the integration name. Switching the active plugin
// updates the section title on the next render.

const SCENARIO = "tab-propagation";
const NOW = "2026-05-26T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("plugin name surfaces in the Source section title and updates on plugin switch", async ({
  page,
  request,
}) => {
  const { projectId } = await registerTestProject(request, {
    projectName: "tc-182",
    pluginId: "github-com",
    integrationConfig: {
      sources: { repo: [{ externalId: "acme/widgets" }] },
      capturedUserId: { externalId: "alice", displayName: "Alice" },
    },
  });

  await page.goto(`/projects/${projectId}/settings`);

  const sectionTitle = page.getByTestId("project-settings-source-section-title");

  // Initial state: configured against the github-com overlay.
  await expect(sectionTitle).toHaveText("GitHub.com");

  // Switching the active plugin via the integration override endpoint mirrors
  // what the SwitchIntegrationDialog does on submit. A reload picks up the
  // new override through the existing React Query cache key.
  await setIntegrationPlugin(request, projectId, "jira-self-hosted");
  await page.reload();

  await expect(sectionTitle).toHaveText("Self-hosted Jira");
});
