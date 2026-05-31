import { expect, test } from "@playwright/test";
import { resetWithScenario } from "./_support/scenario.js";
import { registerTestProject } from "../project-settings/_support/test-project.js";

// TC-157 (US-002, FR-019): the self-hosted Jira flow exercises the
// categorized-multi-list source-picker shape. A fixture project pinned to the
// stub (routed via the jira-self-hosted-categorized scenario) renders the
// IssueSourceTile in its configured variant; opening Configure surfaces the
// host-rendered declarative picker with one tab per category, and selecting a
// source persists through the dedicated PUT /integration/sources endpoint.

const SCENARIO = "jira-self-hosted-categorized";
const NOW = "2026-05-21T13:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("Configure surfaces the categorized source picker and persists a selection", async ({
  page,
  request,
}) => {
  // Pin the fixture project to the stub plugin with an instance so the tile
  // renders its configured variant and the connection pill resolves to the
  // scenario's "connected" state.
  const { projectId } = await registerTestProject(request, {
    projectId: "tc-157",
    plugin: "e2e-stub",
    integrationConfig: { instance: "https://jira.stub.example" },
  });

  await page.goto(`/projects/${projectId}/settings`);

  const tile = page.getByTestId("issue-source-tile");
  await expect(tile).toBeVisible();

  // Open the Configure modal via the configured-variant primary action.
  const primary = page.getByTestId("issue-source-primary-action");
  await expect(primary).toBeVisible();
  await primary.click();

  // Scope to the Configure modal by its accessible name: the MultiSelect
  // popover also carries role="dialog", so a bare getByRole("dialog") is
  // ambiguous once the picker is opened.
  const dialog = page.getByRole("dialog", { name: /Configure Self-hosted Jira|Roubo E2E Stub/ });
  await expect(dialog.getByTestId("plugin-configure-dialog-header")).toBeVisible();

  // FR-019: the declarative picker renders one tab per category returned by
  // the stub's listSourceCandidates (Projects / Filters in this scenario).
  const picker = dialog.getByTestId("source-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("tab", { name: /Projects/ })).toBeVisible();
  await expect(picker.getByRole("tab", { name: /Filters/ })).toBeVisible();

  // Select a project from the first tab, then toggle the multi-select popover
  // shut (it stays open on selection and its overlay would otherwise intercept
  // the Save click).
  const projectsTrigger = picker.getByRole("button", { name: /select projects/i });
  await projectsTrigger.click();
  await page.getByRole("option", { name: /Alpha/ }).click();
  await projectsTrigger.click({ force: true });

  // Save persists the config and the source selection; the dialog closes.
  await dialog.getByTestId("save-config").click();
  await expect(dialog).toBeHidden();

  // The saved selection is readable back through the host endpoint.
  const res = await request.get(`/api/projects/${projectId}/integration`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    effective?: { sources?: Record<string, unknown[]> };
  };
  expect(body.effective?.sources?.projects).toContain("PROJ-A");
});
