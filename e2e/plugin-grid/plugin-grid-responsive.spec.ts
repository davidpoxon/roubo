import { expect, test } from "@playwright/test";
import {
  expectStubConnectionStatus,
  loadAppShell,
  resetWithScenario,
} from "../e2e-flow/_support/scenario.js";

// TC-170 (US-025, FR-056/057/058, NFR-018): the Settings > Plugins grid uses
// CSS Grid `auto-fit minmax(360px, 1fr)` so tiles wrap based on available
// width with no JS-driven breakpoints, and the Settings page wrapper fills
// the available container at every viewport width.
//
// The third-party plugins grid drives this spec because it carries five
// deterministic cards under the `plugin-grid-responsive` scenario: the
// canonical e2e-stub plus four sibling fixtures (e2e-stub-2..e2e-stub-5)
// discovered alongside it under `ROUBO_USER_PLUGINS_DIR`. Bundled plugins
// always render in their own grid, but their count is fixed by the repo's
// shipped plugins and not tunable per spec, so the responsive assertions
// here target the third-party grid only.

const SCENARIO = "plugin-grid-responsive";
const NOW = "2026-05-21T12:00:00.000Z";

const STUB_PLUGIN_IDS = ["e2e-stub", "e2e-stub-2", "e2e-stub-3", "e2e-stub-4", "e2e-stub-5"];

interface PluginListEntry {
  id: string;
  status: string;
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("plugin-grid-responsive scenario surfaces via the host connection-status endpoint", async ({
  request,
  page,
}) => {
  await expectStubConnectionStatus(request, { detail: "stubbed", checkedAt: NOW });
  await loadAppShell(page);
});

test("the five stub plugins are discovered and enabled under this scenario", async ({
  request,
}) => {
  const res = await request.get("/api/plugins");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { plugins: PluginListEntry[] };
  for (const id of STUB_PLUGIN_IDS) {
    const entry = body.plugins.find((p) => p.id === id);
    expect(entry, `expected plugin "${id}" to be discovered`).toBeDefined();
    expect(entry?.status).toBe("enabled");
  }
});

// Viewport widths chosen to walk the grid through 1/2/3/4-column wrap once
// the 240px sidebar and the Settings wrapper's `p-8` padding (32px each side)
// are subtracted from the viewport. With `minmax(360px, 1fr)` and a 16px gap,
// the breakpoints land around viewport widths of 360+304 (1 col), 736+304
// (2 col), 1112+304 (3 col), and 1488+304 (4 col); the values below sit
// comfortably inside each band. TC-170's literal 600/1200/1700 widths predate
// the sidebar layout and would land on 1/2/3 columns today, which would only
// exercise three of the four wrap states the issue's acceptance criteria
// call for.
const VIEWPORT_CASES = [
  { width: 600, expectedCols: 1 },
  { width: 1100, expectedCols: 2 },
  { width: 1500, expectedCols: 3 },
  { width: 1900, expectedCols: 4 },
] as const;

test("third-party plugins grid wraps through 1/2/3/4 columns and Settings wrapper stays unconstrained", async ({
  page,
}) => {
  await loadAppShell(page);
  // The built server's SPA fallback does not currently rewrite deep links like
  // /settings to index.html (it 404s on direct GET), so client-side navigate
  // from the already-loaded shell instead of a fresh page.goto.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/settings#plugins");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  const grid = page.locator('section[aria-label="Third-party plugins"] > div.grid').first();
  await expect(grid).toBeVisible();
  // Anchor on the rendered card count so we only assert layout once the five
  // stub cards have hydrated; otherwise an empty grid at 600px would still
  // report a single column for the wrong reason. Scope the anchor to the five
  // stub cards by `data-plugin-id` rather than the raw child count: other
  // user-dir fixtures discovered under ROUBO_USER_PLUGINS_DIR (e.g. the
  // CP-TC-028 `clasp-deploy-stub` component plugin) also render in this grid,
  // so counting `> *` would over-count. The CSS-Grid wrap math below reads the
  // computed `grid-template-columns` and is independent of the card count.
  const stubCards = grid.locator(
    STUB_PLUGIN_IDS.map((id) => `[data-plugin-id="${id}"]`).join(", "),
  );
  await expect(stubCards).toHaveCount(STUB_PLUGIN_IDS.length);

  const settingsWrapper = page.locator("main > div.p-8.w-full").first();
  await expect(settingsWrapper).toBeVisible();

  for (const { width, expectedCols } of VIEWPORT_CASES) {
    await page.setViewportSize({ width, height: 900 });

    const trackCount = await grid.evaluate(
      (el) => getComputedStyle(el as HTMLElement).gridTemplateColumns.split(/\s+/).length,
    );
    expect(
      trackCount,
      `expected ${expectedCols} columns at ${width}px viewport, computed grid had ${trackCount}`,
    ).toBe(expectedCols);

    // FR-058: the Settings wrapper has no max-width constraint and fills the
    // width of its <main> container at every viewport.
    const wrapperMaxWidth = await settingsWrapper.evaluate(
      (el) => getComputedStyle(el as HTMLElement).maxWidth,
    );
    expect(wrapperMaxWidth).toBe("none");

    const wrapperWidth = await settingsWrapper.evaluate((el) => el.getBoundingClientRect().width);
    const mainWidth = await page
      .locator("main")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(
      Math.abs(wrapperWidth - mainWidth),
      `Settings wrapper width (${wrapperWidth}) should match <main> width (${mainWidth}) at ${width}px viewport`,
    ).toBeLessThanOrEqual(1);
  }
});
