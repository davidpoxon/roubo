import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject } from "./_support/test-project.js";

// TC-179 (US-023, FR-073): GHE follows the same Source-tile consolidation as
// github-com. Manifest name flows to the section title / sidebar / breadcrumb,
// the configured instance URL surfaces on the tile, and the single primary
// action drives the same Configure modal. The Repository / Linked Project /
// Submodules editors are gated on plugin.id === "github-com" today (FR-073
// follow-up), so this spec deliberately does not assert their presence on
// the GHE modal; see the WU-068 plan for the carve-out.

const SCENARIO = "ghe-consolidation-parity";
const NOW = "2026-05-26T09:00:00.000Z";
const INSTANCE = "https://ghe.example.com";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("scenario surfaces through the ghe overlay's connection-status endpoint", async ({
  request,
}) => {
  const res = await request.get("/api/plugins/ghe/connection-status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { state: string; detail?: string; checkedAt?: string };
  expect(body.state).toBe("connected");
  expect(body.detail).toBe("ghe-consolidation-parity stub");
  expect(body.checkedAt).toBe(NOW);
});

test("section title and instance URL reflect the GHE plugin manifest and effective config", async ({
  page,
  request,
}) => {
  const { projectId } = await registerTestProject(request, {
    projectName: "tc-179",
    pluginId: "ghe",
    integrationConfig: {
      instance: INSTANCE,
      sources: { repo: [{ externalId: "acme/widgets" }] },
      capturedUserId: { externalId: "alice", displayName: "Alice" },
    },
  });

  await page.goto(`/projects/${projectId}/settings`);

  // FR-069: GHE's manifest.name surfaces in the per-project label slots.
  // Sidebar selector is project-scoped so unrelated leftover projects from
  // other benches' e2e runs don't fool the lookup.
  await expect(page.getByTestId("project-settings-source-section-title")).toHaveText(
    "GitHub Enterprise",
  );
  await expect(
    page.locator(
      `[data-project-id="${projectId}"] [data-testid="project-sidebar-integration-name"]`,
    ),
  ).toHaveText("GitHub Enterprise");
  await expect(page.getByTestId("breadcrumb-integration-name")).toHaveText("GitHub Enterprise");

  // FR-073: the configured instance URL is rendered as a read-only line on
  // the Source tile header.
  await expect(page.getByTestId("issue-source-instance")).toHaveText(INSTANCE);

  // The single primary action and the absence of "Choose sources" are
  // identical to the github-com case (FR-072 parity).
  await expect(page.getByTestId("issue-source-primary-action")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose sources" })).toHaveCount(0);
});

test("clicking the primary action opens the GHE Configure modal", async ({ page, request }) => {
  const { projectId } = await registerTestProject(request, {
    projectName: "tc-179-modal",
    pluginId: "ghe",
    integrationConfig: {
      instance: INSTANCE,
      capturedUserId: { externalId: "alice", displayName: "Alice" },
    },
  });

  await page.goto(`/projects/${projectId}/settings`);
  await page.getByTestId("issue-source-primary-action").click();
  await expect(page.getByTestId("plugin-configure-dialog-header")).toBeVisible();
});
