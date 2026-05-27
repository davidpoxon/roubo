import { expect, test } from "@playwright/test";
import { loadAppShell, registerFixtureProject, resetWithScenario } from "./_support/scenario.js";

// TC-172 (US-016/017/025, FR-059/060/061, NFR-022): the edge paths of the
// project-load Enable-plugin prompt modal — Cancel (no state change) and
// plugin-refuses-to-start (inline error, plugin stays disabled). Both arms
// share the `enable-prompt-edges` scenario: the Cancel test never spawns
// the plugin, so the scenario's `failOnStart` flag only bites on the
// failure arm.
//
// Each test owns its own reset so the registered fixture project and the
// (greenfield-style) disabled plugin state are isolated between arms.

const SCENARIO = "enable-prompt-edges";
const NOW = "2026-05-27T09:30:00.000Z";
const PROJECT_ID = "enable-prompt-edges";

async function setupGreenfield(request: import("@playwright/test").APIRequestContext) {
  await resetWithScenario(request, SCENARIO, NOW, { bundledPluginsDisabled: true });
  await registerFixtureProject(request, { projectId: PROJECT_ID, plugin: "github-com" });
}

async function openProjectModal(page: import("@playwright/test").Page) {
  await loadAppShell(page);
  await page.locator(`[data-project-id="${PROJECT_ID}"] >> role=button`).first().click();
  const modal = page.getByTestId("enable-plugin-modal");
  await expect(modal).toBeVisible();
  return modal;
}

test.describe("EnablePluginPromptModal edges", () => {
  test("Cancel dismisses the modal and leaves the plugin disabled", async ({ page, request }) => {
    await setupGreenfield(request);
    const modal = await openProjectModal(page);

    const confirm = page.getByTestId("enable-plugin-confirm");
    await expect(confirm).toBeFocused();

    // NFR-022: Esc dismisses when the mutation is not pending. ModalOverlay
    // is configured with `isDismissable={!isPending}` and
    // `isKeyboardDismissDisabled={isPending}` so this exercises the same
    // path the click-Cancel button takes.
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();

    // The plugin is still disabled; the persisted state was never touched.
    const pluginsRes = await request.get("/api/plugins");
    expect(pluginsRes.status()).toBe(200);
    const { plugins } = (await pluginsRes.json()) as {
      plugins: Array<{ id: string; status: string }>;
    };
    const githubCom = plugins.find((p) => p.id === "github-com");
    expect(githubCom?.status).toBe("disabled");
  });

  test("plugin refuses to start: 409 surfaces inline; plugin stays disabled", async ({
    page,
    request,
  }) => {
    await setupGreenfield(request);
    const modal = await openProjectModal(page);

    // Watch the enable POST for the 409 the modal converts into the inline
    // error banner. The route returns 409 with { error: "..." } when
    // pluginManager.enable() throws — which it now does on synchronous
    // spawn-time failures (WU-066 / FR-061).
    const enablePromise = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/plugins/github-com/enable") && res.request().method() === "POST",
    );

    await page.getByTestId("enable-plugin-confirm").click();

    const enableRes = await enablePromise;
    expect(enableRes.status()).toBe(409);

    const error = page.getByTestId("enable-plugin-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    // Modal stays open so the user can read the message and retry / cancel.
    await expect(modal).toBeVisible();

    // FR-061: the plugin is not running. The in-memory record reports
    // "errored" (the host's view of the failed spawn) and enable() rolled
    // the persisted state back to "disabled" so a server restart won't keep
    // respawning it. Either way it is not "enabled".
    const pluginsRes = await request.get("/api/plugins");
    expect(pluginsRes.status()).toBe(200);
    const { plugins } = (await pluginsRes.json()) as {
      plugins: Array<{ id: string; status: string }>;
    };
    const githubCom = plugins.find((p) => p.id === "github-com");
    expect(githubCom?.status).not.toBe("enabled");
    expect(["disabled", "errored"]).toContain(githubCom?.status);
  });
});
