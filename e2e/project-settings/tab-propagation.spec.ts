import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject, setIntegrationPlugin } from "./_support/test-project.js";

// TC-182 (US-014/022, FR-053/FR-069): the plugin-driven name flows to three
// surfaces: the Source section title on the per-project Settings page, the
// project sidebar entry, and the page breadcrumb. Switching the active plugin
// updates all three in lockstep on the next render.

const SCENARIO = "tab-propagation";
const NOW = "2026-05-26T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("plugin name surfaces in section title, sidebar entry, and breadcrumb in lockstep", async ({
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
  // Project-scoped sidebar selector so leftover projects from other benches'
  // e2e runs don't fool the lookup; the breadcrumb is page-singular so its
  // testid alone is sufficient.
  const sidebarEntry = page.locator(
    `[data-project-id="${projectId}"] [data-testid="project-sidebar-integration-name"]`,
  );
  const breadcrumb = page.getByTestId("breadcrumb-integration-name");

  // Initial state: configured against the github-com overlay.
  await expect(sectionTitle).toHaveText("GitHub.com");
  await expect(sidebarEntry).toHaveText("GitHub.com");
  await expect(breadcrumb).toHaveText("GitHub.com");

  // Switching the active plugin via the integration override endpoint mirrors
  // what the SwitchIntegrationDialog does on submit. A reload picks up the
  // new override through the existing React Query cache key.
  await setIntegrationPlugin(request, projectId, "jira-self-hosted");
  await page.reload();

  await expect(sectionTitle).toHaveText("Self-hosted Jira");
  await expect(sidebarEntry).toHaveText("Self-hosted Jira");
  await expect(breadcrumb).toHaveText("Self-hosted Jira");
});
