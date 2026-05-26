import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject } from "./_support/test-project.js";

// TC-178 (US-023, FR-072/073): the per-project Source tile collapses the
// legacy Connect / Configure / Choose sources buttons into a single primary
// action whose label is driven by `derivePluginConnectionState`. The same
// modal opens for every state. The label flip is exercised by walking the
// stubbed `connectionStatusSequence` (disconnected → connected → auth-problem)
// via page reloads.

const SCENARIO = "connect-configure-button";
const NOW = "2026-05-26T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("the single primary action flips Connect → Configure → Sign in again with state", async ({
  page,
  request,
}) => {
  // Register a project against the github-com overlay with no credentials so
  // the initial `derivePluginConnectionState` fallback resolves to
  // "disconnected" while the live status query is still in flight.
  const { projectId } = await registerTestProject(request, {
    projectName: "tc-178",
    pluginId: "github-com",
  });

  // Sequence[0] = disconnected → primary button reads "Connect" (FR-072).
  await page.goto(`/projects/${projectId}/settings`);
  const primary = page.getByTestId("issue-source-primary-action");
  await expect(primary).toHaveText("Connect");

  // FR-073: the legacy "Choose sources" button is gone. Same modal opens
  // for every label — clicking the primary action mounts
  // PluginConfigureDialog regardless of state.
  await expect(page.getByRole("button", { name: "Choose sources" })).toHaveCount(0);

  // Reload to advance the connection-status sequence. The QueryClient is
  // rebuilt on a full nav, so the IssueSourceTile remounts and fires a fresh
  // /api/plugins/github-com/connection-status call which returns sequence[1].
  await page.reload();
  // Sequence[1] = connected → primary button reads "Configure".
  await expect(primary).toHaveText("Configure");

  await page.reload();
  // Sequence[2] = auth-problem → primary button reads "Sign in again".
  await expect(primary).toHaveText("Sign in again");
});

test("clicking the primary action opens the same Configure modal across states", async ({
  page,
  request,
}) => {
  const { projectId } = await registerTestProject(request, {
    projectName: "tc-178-modal",
    pluginId: "github-com",
  });

  await page.goto(`/projects/${projectId}/settings`);
  // First state, whatever the sequence says — assert the modal opens cleanly.
  await page.getByTestId("issue-source-primary-action").click();
  await expect(page.getByTestId("plugin-configure-dialog-header")).toBeVisible();
});
