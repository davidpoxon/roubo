import { createRequire } from "node:module";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
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

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";

// The bundled axe-core dist (axe-core/axe.js). Injected verbatim into the page so
// `window.axe` is available; @axe-core/playwright is not a dependency, so we wire
// the injection + scoped run by hand.
const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core");

type Theme = "light" | "dark";

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

// Toggle the app's dark-mode class on <html>, matching what useSettings.applyTheme
// does (the class-based `dark` variant, see client/src/globals.css). The settings
// query has staleTime Infinity and never refetches mid-test, so nothing re-runs
// applyTheme to clobber this. Transitions are frozen (see injectAxe), so the new
// theme's colours resolve instantly; wait two animation frames for the style recalc
// + paint to settle before the caller runs axe, otherwise a mid-flip intermediate
// colour would be measured instead of the settled one.
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate(async (t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, theme);
}

// Run axe's color-contrast rule scoped to the given dialog subtree and assert zero
// violations. Scoping to the dialog element (not the whole page) keeps the check on
// the picker itself; `violations` holds only definite AA failures (axe puts
// can't-determine-background cases in `incomplete`, which we intentionally ignore).
// Each node's `html` is captured so a failure names the exact offending element.
async function expectNoContrastViolations(
  page: Page,
  dialog: Locator,
  label: string,
): Promise<void> {
  const handle = await dialog.elementHandle();
  expect(handle, `${label}: dialog element resolved`).not.toBeNull();
  const violations = await page.evaluate(async (el) => {
    const globalAxe = (
      window as unknown as { axe: { run: (...args: unknown[]) => Promise<unknown> } }
    ).axe;
    const results = (await globalAxe.run(el as Element, {
      runOnly: { type: "rule", values: ["color-contrast"] },
    })) as {
      violations: Array<{
        id: string;
        nodes: Array<{ target: unknown[]; html?: string; failureSummary?: string }>;
      }>;
    };
    return results.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, html: n.html, summary: n.failureSummary })),
    }));
  }, handle);
  expect(violations, `${label}: axe color-contrast violations`).toEqual([]);
}

// Scan a dialog in both themes and assert zero color-contrast violations in each,
// then restore the light default. axe must already be injected on the page.
async function scanBothThemes(page: Page, dialog: Locator, state: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await expectNoContrastViolations(page, dialog, `${state} (${theme})`);
  }
  await setTheme(page, "light");
}

async function injectAxe(page: Page): Promise<void> {
  await page.addScriptTag({ path: AXE_PATH });
  await page.waitForFunction(() => "axe" in window);
  // Freeze CSS transitions/animations. Many picker elements carry
  // `transition-colors`, so a live theme flip animates each one from its dark to
  // its light colour over ~150ms; an axe run fired mid-flip would measure a
  // transient intermediate colour (a false-positive contrast failure), not the
  // settled AA-compliant value. Killing transition/animation durations makes the
  // theme change instantaneous and the measurement deterministic.
  await page.addStyleTag({
    content:
      "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }",
  });
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
