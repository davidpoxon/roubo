import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { injectAxe, scanBothThemes } from "./_support/axe-contrast.js";
import { loadAppShell, registerFixtureProject, resetWithScenario } from "./_support/scenario.js";
import {
  TSPF_TC_010_ALL_PASSED_PLAN,
  TSPF_TC_010_ALL_PASSED_SLUG,
  TSPF_TC_010_NEEDS_ATTENTION_PLAN,
  TSPF_TC_010_NEEDS_ATTENTION_SLUG,
} from "./_support/testbench-plan.js";

// E2E (#493): the real-rendering WCAG AA color-contrast guard for the partitioned
// spec picker (SpecPickerModal), closing the coverage gap left by the jsdom
// vitest-axe suite. jsdom has no layout/paint engine, so axe silently reports zero
// color-contrast violations there even when text fails AA. This spec injects the
// bundled axe-core into Chromium against the BUILT app and runs ONLY the
// color-contrast rule over the rendered picker dialog, across BOTH themes (the app
// toggles a `.dark` class on <html>, see client/src/hooks/useSettings.ts), BOTH
// modes (create + re-point), and BOTH partition states (a mixed
// needs-attention/all-passed list, collapsed and with the de-emphasized all-passed
// disclosure expanded, plus the all-passed-only empty state). It reproduces
// TSPF-TC-015's S003 observations: before the #493 fix, dark-theme de-emphasized
// rows measured as low as 2.28:1; every scan below must now report zero violations.
//
// The injection, theme-flip and scan helpers live in _support/axe-contrast.ts,
// shared with the agent-surface contrast guard (#703).

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), "precondition: read settings").toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(res.status(), "precondition: PUT /api/settings testBench.enabled").toBe(200);
}

async function gotoBenchList(page: Page, projectId: string): Promise<void> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("#493: create-mode picker meets WCAG AA color-contrast in both themes across the mixed partition", async ({
  page,
  request,
}) => {
  await enableTestBench(request);
  const projectId = "tspf-contrast-create-mixed";
  await registerFixtureProject(request, {
    projectId,
    gitInit: true,
    seedSpecs: [
      {
        slug: TSPF_TC_010_NEEDS_ATTENTION_SLUG,
        testCases: TSPF_TC_010_NEEDS_ATTENTION_PLAN,
        seedResults: "partial",
      },
      {
        slug: TSPF_TC_010_ALL_PASSED_SLUG,
        testCases: TSPF_TC_010_ALL_PASSED_PLAN,
        seedResults: "all-passed",
      },
    ],
  });

  await loadAppShell(page);
  await gotoBenchList(page, projectId);
  await injectAxe(page);

  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });

  await test.step("open the create picker on the mixed partition", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio").first()).toBeVisible();
  });

  // Collapsed: needs-attention rows in the main space, the "All passed" disclosure
  // (with its dark-theme count text, one of the flagged nodes) collapsed.
  await test.step("collapsed disclosure: zero color-contrast violations in both themes", async () => {
    await scanBothThemes(page, dialog, "create/mixed/collapsed");
  });

  // Expanded: the de-emphasized all-passed rows (the worst offenders in dark, down
  // to 2.28:1 before the fix) are now mounted and scanned.
  await test.step("expanded disclosure: de-emphasized rows meet AA in both themes", async () => {
    await dialog.getByRole("button", { name: /All passed/ }).click();
    await expect(
      dialog.locator('[aria-label="All passed specs"]').getByRole("radio").first(),
    ).toBeVisible();
    await scanBothThemes(page, dialog, "create/mixed/expanded");
  });
});

test("#493: create-mode picker meets WCAG AA color-contrast in the all-passed-only empty state", async ({
  page,
  request,
}) => {
  await enableTestBench(request);
  const projectId = "tspf-contrast-create-allpassed";
  await registerFixtureProject(request, {
    projectId,
    gitInit: true,
    seedSpecs: [
      {
        slug: TSPF_TC_010_ALL_PASSED_SLUG,
        testCases: TSPF_TC_010_ALL_PASSED_PLAN,
        seedResults: "all-passed",
      },
    ],
  });

  await loadAppShell(page);
  await gotoBenchList(page, projectId);
  await injectAxe(page);

  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });

  await test.step("open the create picker on the all-passed-only empty state", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Every discovered spec has all test cases passed")).toBeVisible();
  });

  await test.step("empty state: zero color-contrast violations in both themes", async () => {
    await scanBothThemes(page, dialog, "create/all-passed-only/collapsed");
  });

  await test.step("empty state with the disclosure expanded: both themes", async () => {
    await dialog.getByRole("button", { name: /All passed/ }).click();
    await expect(
      dialog.locator('[aria-label="All passed specs"]').getByRole("radio").first(),
    ).toBeVisible();
    await scanBothThemes(page, dialog, "create/all-passed-only/expanded");
  });
});

test("#493: re-point-mode picker meets WCAG AA color-contrast in both themes across the mixed partition", async ({
  page,
  request,
}) => {
  await enableTestBench(request);
  const projectId = "tspf-contrast-repoint-mixed";
  await registerFixtureProject(request, {
    projectId,
    gitInit: true,
    seedSpecs: [
      {
        slug: TSPF_TC_010_NEEDS_ATTENTION_SLUG,
        testCases: TSPF_TC_010_NEEDS_ATTENTION_PLAN,
        seedResults: "partial",
      },
      {
        slug: TSPF_TC_010_ALL_PASSED_SLUG,
        testCases: TSPF_TC_010_ALL_PASSED_PLAN,
        seedResults: "all-passed",
      },
    ],
  });

  await loadAppShell(page);
  await gotoBenchList(page, projectId);

  // Precondition: create a TestBench bound to the needs-attention spec so the
  // re-point picker ("Change focused spec") has a bench to open from.
  const createDialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await test.step("precondition: create a TestBench to re-point", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(createDialog).toBeVisible();
    await createDialog
      .getByRole("radio", { name: new RegExp(`^${TSPF_TC_010_NEEDS_ATTENTION_SLUG}`) })
      .click();
    const createButton = createDialog.getByRole("button", { name: "Create TestBench" });
    await expect(createButton).toBeEnabled();
    await createButton.click();
    await expect(createDialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/benches/\\d+$`));
  });

  // The picker is re-injected after the create navigation (a fresh document).
  await injectAxe(page);

  const repointDialog = page.getByRole("dialog", { name: "Change focused spec" });
  await test.step("open the re-point picker on the mixed partition", async () => {
    await page.getByRole("tab", { name: /^TestBench/ }).click();
    await page.getByRole("button", { name: "Change focused spec" }).click();
    await expect(repointDialog).toBeVisible();
    await expect(repointDialog.getByRole("radio").first()).toBeVisible();
  });

  await test.step("collapsed disclosure: zero color-contrast violations in both themes", async () => {
    await scanBothThemes(page, repointDialog, "repoint/mixed/collapsed");
  });

  await test.step("expanded disclosure: de-emphasized rows meet AA in both themes", async () => {
    await repointDialog.getByRole("button", { name: /All passed/ }).click();
    await expect(
      repointDialog.locator('[aria-label="All passed specs"]').getByRole("radio").first(),
    ).toBeVisible();
    await scanBothThemes(page, repointDialog, "repoint/mixed/expanded");
  });
});
