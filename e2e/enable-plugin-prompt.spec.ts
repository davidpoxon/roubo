import { expect, test } from "@playwright/test";

// Covers TC-152 at the browser level. The spec drives the real
// EnablePluginPromptModal (built on React Aria's ModalOverlay/Modal/Dialog)
// against a Vite-served dev fixture (`client/enable-plugin-prompt-fixture.html`)
// so it doesn't need a running server. The fixture exposes a trigger button
// (`open-enable-prompt`) and reflects modal lifecycle into a JSON-ish debug
// block (`phase-debug`). Pressing Enable would normally POST to
// /api/plugins/:id/enable; the spec stubs that route so the confirm path can
// run to completion against a synthetic 204.

const FIXTURE = "/enable-plugin-prompt-fixture.html";

test.describe("EnablePluginPromptModal — accessibility (TC-152)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/plugins/github-com/enable", (route) =>
      route.fulfill({ status: 204, body: "" }),
    );
  });

  test("opens with focus on the Enable confirm button (autoFocus)", async ({ page }) => {
    await page.goto(FIXTURE);

    await page.getByTestId("open-enable-prompt").click();

    const modal = page.getByTestId("enable-plugin-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("enable-plugin-confirm")).toBeFocused();
  });

  test("Tab and Shift+Tab cycle focus inside the modal only", async ({ page }) => {
    await page.goto(FIXTURE);

    const trigger = page.getByTestId("open-enable-prompt");
    await trigger.click();

    const confirm = page.getByTestId("enable-plugin-confirm");
    const cancel = page.getByTestId("enable-plugin-cancel");

    // Initial focus is on Confirm (autoFocus). Tab past the last focusable
    // wraps to Cancel; another Tab wraps back to Confirm.
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();

    // Shift+Tab walks the cycle backwards and must stay inside the modal.
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(confirm).toBeFocused();

    // Focus never escaped to the underlying page trigger.
    await expect(trigger).not.toBeFocused();
  });

  test("Esc cancels and restores focus to the triggering element", async ({ page }) => {
    await page.goto(FIXTURE);

    const trigger = page.getByTestId("open-enable-prompt");
    await trigger.click();
    await expect(page.getByTestId("enable-plugin-modal")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByTestId("enable-plugin-modal")).toHaveCount(0);
    await expect(page.getByTestId("phase-debug")).toHaveText("cancelled");
    await expect(trigger).toBeFocused();
  });

  test("Enter on the focused Enable button fires the enable action", async ({ page }) => {
    const enableRequest = page.waitForRequest(
      (req) => req.url().endsWith("/api/plugins/github-com/enable") && req.method() === "POST",
    );

    await page.goto(FIXTURE);

    await page.getByTestId("open-enable-prompt").click();
    await expect(page.getByTestId("enable-plugin-confirm")).toBeFocused();

    await page.keyboard.press("Enter");

    await enableRequest;
    await expect(page.getByTestId("enable-plugin-modal")).toHaveCount(0);
    await expect(page.getByTestId("phase-debug")).toHaveText("enabled");
  });
});
