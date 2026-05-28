import { expect, test } from "@playwright/test";
import { resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject } from "./_support/test-project.js";

// Regression for the "Choose integration" crash. Two React Query hooks
// (usePlugins, useInstalledPlugins) previously shared the cache key
// ["plugins"] but returned different shapes (object vs array). Any surface
// that called usePlugins first primed the cache with the object; opening the
// SwitchIntegrationDialog (which consumes useInstalledPlugins) then read the
// object back and crashed in `(plugins ?? []).filter(isUsable)` with
// "(r ?? []).filter is not a function".
//
// TC-164 (issue-source-tile-configure.spec.ts) missed this because it
// navigates straight to project settings without first hitting any surface
// that mounts usePlugins. This spec exercises the real-world ordering:
// visit Settings > Plugins (mounts PluginsTab -> usePlugins -> primes
// ["plugins"]) before opening Choose integration on the project.

const SCENARIO = "issue-source-tile-configure";
const NOW = "2026-05-27T09:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("Choose integration dialog opens after the global Plugins tab primes the cache", async ({
  page,
  request,
}) => {
  await registerTestProject(request, { projectName: "tc-cache-collision" });

  // Prime the ["plugins"] cache via the global Plugins tab. PluginsTab calls
  // usePlugins, whose queryFn returns { hostApiVersion, plugins: [...] } --
  // the object shape. This is the only initial navigation (page.goto resets
  // the React Query cache); everything afterwards is SPA navigation so the
  // cache survives.
  const pluginsResponse = page.waitForResponse(
    (res) => res.url().endsWith("/api/plugins") && res.status() === 200,
  );
  await page.goto("/settings#plugins");
  await pluginsResponse;
  await expect(page.getByTestId("install-plugin")).toBeVisible();

  // SPA-navigate into the project (sidebar uses navigate(), not page reloads)
  // and then to its Settings tab. The React Query cache primed above persists
  // across these in-app transitions. Before the queryKey fix, the next click
  // (Choose integration) would read the object back through useInstalledPlugins
  // and crash inside SwitchIntegrationDialog's useMemo with
  // "(r ?? []).filter is not a function".
  await page.getByRole("button", { name: "Roubo E2E Fixture" }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("issue-source-tile")).toBeVisible();
  await page.getByTestId("issue-source-choose-integration").click();

  // Assert the dialog actually rendered and the React Router error boundary
  // did NOT mount. `body` text catches the unstyled error overlay even if
  // the dialog itself fails to mount.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Choose integration" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Unexpected Application Error");

  // And the radio list rendered from the array shape: the github-com overlay
  // surfaces as "GitHub.com" (mirrors TC-164).
  await expect(dialog.getByRole("radio", { name: /GitHub\.com/ })).toBeVisible();
});
