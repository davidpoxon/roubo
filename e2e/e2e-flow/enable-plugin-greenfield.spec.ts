import { expect, test } from "@playwright/test";
import { loadAppShell, registerFixtureProject, resetWithScenario } from "./_support/scenario.js";

// TC-171 (US-016/017, FR-059/060/061/077/078/080, NFR-022): the
// greenfield-then-Enable path of the project-load Enable-plugin prompt
// modal. The reset writes every bundled plugin id as "disabled" (mirroring
// what migrate.run() does on a fresh install) so the modal fires the first
// time the user opens a project whose integration references that plugin.
//
// The bundled-overlays in `e2e/fixtures/bundled-overlays/` re-export the
// canonical e2e-stub runtime under the `github-com` manifest id; the
// scenario pinned here keeps the stub healthy so the Enable click succeeds
// end-to-end.

const SCENARIO = "greenfield-and-enable-prompt";
const NOW = "2026-05-27T09:00:00.000Z";
const PROJECT_ID = "enable-prompt-greenfield";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW, { bundledPluginsDisabled: true });
  await registerFixtureProject(request, { projectId: PROJECT_ID, plugin: "github-com" });
});

test("greenfield → Enable lands the project loaded and flips github-com to enabled", async ({
  page,
  request,
}) => {
  await loadAppShell(page);

  // Open the fixture project from the sidebar so the BenchDashboard mounts
  // and renders the Enable-plugin prompt modal against its disabled
  // integration. The sidebar row carries `data-project-id` so we don't have
  // to assume the display name.
  await page.locator(`[data-project-id="${PROJECT_ID}"] >> role=button`).first().click();

  const modal = page.getByTestId("enable-plugin-modal");
  await expect(modal).toBeVisible();

  // FR-059 / FR-060: title and button labels surface the plugin name.
  await expect(modal).toContainText("Enable GitHub.com to load this project?");
  const cancel = page.getByTestId("enable-plugin-cancel");
  const confirm = page.getByTestId("enable-plugin-confirm");
  await expect(cancel).toBeVisible();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Enable and load project");

  // NFR-022: focus lands on Confirm via React Aria's `autoFocus`, and Tab
  // cycles within the modal (React Aria's ModalOverlay traps focus).
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();

  // NFR-022: Enter triggers the focused Confirm button (FR-078 path).
  await page.keyboard.press("Enter");

  await expect(modal).toBeHidden();

  // FR-080: the plugin is now enabled; the in-memory record (sourced from
  // plugins-state.json) reflects status === "enabled".
  const pluginsRes = await request.get("/api/plugins");
  expect(pluginsRes.status()).toBe(200);
  const { plugins } = (await pluginsRes.json()) as {
    plugins: Array<{ id: string; status: string }>;
  };
  const githubCom = plugins.find((p) => p.id === "github-com");
  expect(githubCom?.status).toBe("enabled");
});
