import { expect, test } from "@playwright/test";
import {
  expectStubConnectionStatus,
  loadAppShell,
  resetWithScenario,
} from "../e2e-flow/_support/scenario.js";
import { registerTestProject } from "./_support/test-project.js";

// TC-177 (US-022, FR-069/070/071): on a project configured against the
// github.com plugin, the per-project Settings page surfaces the plugin's
// manifest name as the Source section title and propagates the same name to
// the sidebar entry + page breadcrumb. The Repository / Linked Project /
// Submodules editors now live inside the plugin Configure modal rather than
// alongside the project identity tile.

const SCENARIO = "github-tab-consolidation";
const NOW = "2026-05-26T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("scenario surfaces through the github-com overlay's connection-status endpoint", async ({
  request,
  page,
}) => {
  // Overlay swap: under ROUBO_BUNDLED_PLUGINS_DIR=e2e/fixtures/bundled-overlays/
  // the real github-com plugin is replaced by a thin stub that delegates to
  // e2e-stub. Hitting /api/plugins/github-com/connection-status proves the
  // pinning reached the spawned process via the github-com slot.
  const res = await request.get("/api/plugins/github-com/connection-status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { state: string; detail?: string; checkedAt?: string };
  expect(body.state).toBe("connected");
  expect(body.detail).toBe("github-tab-consolidation stub");
  expect(body.checkedAt).toBe(NOW);

  // The canonical e2e-stub still listens on its own slot so the harness-shape
  // assertion from WU-063 stays honest under the overlay setup.
  await expectStubConnectionStatus(request, {
    detail: "github-tab-consolidation stub",
    checkedAt: NOW,
  });
  await loadAppShell(page);
});

test("section title, sidebar, and breadcrumb all read the github-com manifest name", async ({
  page,
  request,
}) => {
  const { projectId } = await registerTestProject(request, {
    projectName: "tc-177",
    pluginId: "github-com",
    integrationConfig: {
      sources: { repo: [{ externalId: "acme/widgets" }] },
      capturedUserId: { externalId: "alice", displayName: "Alice" },
    },
  });

  await page.goto(`/projects/${projectId}/settings`);

  // FR-069: the Source section title is the plugin manifest name, not the
  // hard-coded "Source" default.
  const sectionTitle = page.getByTestId("project-settings-source-section-title");
  await expect(sectionTitle).toHaveText("GitHub.com");

  // FR-053/FR-069: the same plugin name propagates to the sidebar entry and
  // the page breadcrumb (TC-182 asserts the switch behaviour; TC-177 takes
  // the static read). Sidebar selector is project-scoped so unrelated
  // leftover projects from other benches' e2e runs don't fool .first().
  const sidebarEntry = page.locator(
    `[data-project-id="${projectId}"] [data-testid="project-sidebar-integration-name"]`,
  );
  await expect(sidebarEntry).toHaveText("GitHub.com");
  await expect(page.getByTestId("breadcrumb-integration-name")).toHaveText("GitHub.com");

  // The IssueSourceTile renders the configured variant (live connection pill,
  // single primary action). WU-058 collapsed the prior "Choose sources"
  // button into this same primary action.
  const tile = page.getByTestId("issue-source-tile");
  await expect(tile).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose sources" })).toHaveCount(0);
});

// #279: PR #278 dropped the standalone "GitHub project" picker field from
// integration-fields (sources are derived from the repo + submodules now) and
// replaced it with the read-only derived-sources preview. This test asserts the
// surviving Repository field plus that preview, and no longer expects a
// "GitHub project" label. The fixture seeds `project.repo` so the preview
// resolves to its success state against the scenario's `Repository` candidate.
test("the integration-fields section moves into the github-com Configure modal", async ({
  page,
  request,
}) => {
  const { projectId } = await registerTestProject(request, {
    projectName: "tc-177-modal",
    pluginId: "github-com",
    projectRepo: "acme/widgets",
    integrationConfig: {
      sources: { repo: [{ externalId: "acme/widgets" }] },
      capturedUserId: { externalId: "alice", displayName: "Alice" },
    },
  });

  await page.goto(`/projects/${projectId}/settings`);

  // FR-070: per-project Settings no longer hosts a separate "Identity" block
  // for repository / linked project / submodules. Opening the plugin
  // Configure modal is what surfaces those fields now.
  await page.getByTestId("issue-source-primary-action").click();
  const modalHeader = page.getByTestId("plugin-configure-dialog-header");
  await expect(modalHeader).toBeVisible();
  const integrationFields = page.getByTestId("integration-fields-section");
  await expect(integrationFields).toBeVisible();
  // The section still hosts the Repository field (the input has no stable id;
  // the label is the contract).
  await expect(integrationFields.getByText("Repository", { exact: true })).toBeVisible();
  // PR #278 replaced the standalone "GitHub project" field with the read-only
  // derived-sources preview, which lists what Roubo will pull from the repo.
  const preview = integrationFields.getByTestId("derived-sources-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("acme/widgets");
});
