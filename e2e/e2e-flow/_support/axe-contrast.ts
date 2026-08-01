import { createRequire } from "node:module";
import { expect, type Locator, type Page } from "@playwright/test";

// Shared real-rendering WCAG AA color-contrast helpers, extracted from
// spec-picker-contrast.spec.ts (#493) when a second surface needed the same
// technique (#703). jsdom has no layout/paint engine, so axe silently reports
// zero color-contrast violations there even when text fails AA; the only way to
// decide the rule is to run it in a real browser against the BUILT app. The
// subtleties encoded below (frozen transitions, the two-frame settle after a
// theme flip, treating `incomplete` as not-a-failure) are exactly what rots when
// duplicated, so they live here once and every contrast spec imports them.

// The bundled axe-core dist (axe-core/axe.js). Injected verbatim into the page so
// `window.axe` is available; @axe-core/playwright is not a dependency, so we wire
// the injection + scoped run by hand.
const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core");

export type Theme = "light" | "dark";

/**
 * Toggle the app's dark-mode class on `<html>`, matching what
 * `useSettings.applyTheme` does (the class-based `dark` variant, see
 * client/src/globals.css). The settings query has staleTime Infinity and never
 * refetches mid-test, so nothing re-runs applyTheme to clobber this. Transitions
 * are frozen (see {@link injectAxe}), so the new theme's colours resolve
 * instantly; wait two animation frames for the style recalc + paint to settle
 * before the caller runs axe, otherwise a mid-flip intermediate colour would be
 * measured instead of the settled one.
 */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate(async (t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, theme);
}

/**
 * Run axe's color-contrast rule scoped to the given subtree and assert zero
 * violations. Scoping to one element (not the whole page) keeps the check on the
 * surface under test; `violations` holds only definite AA failures (axe puts
 * can't-determine-background cases in `incomplete`, which we intentionally
 * ignore). Each node's `html` is captured so a failure names the exact offending
 * element.
 */
export async function expectNoContrastViolations(
  page: Page,
  scope: Locator,
  label: string,
): Promise<void> {
  const handle = await scope.elementHandle();
  expect(handle, `${label}: scope element resolved`).not.toBeNull();
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

/**
 * Scan a subtree in both themes and assert zero color-contrast violations in
 * each, then restore the light default. axe must already be injected on the page.
 */
export async function scanBothThemes(page: Page, scope: Locator, state: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await expectNoContrastViolations(page, scope, `${state} (${theme})`);
  }
  await setTheme(page, "light");
}

/** Inject axe-core into the page and freeze CSS transitions so a scan is deterministic. */
export async function injectAxe(page: Page): Promise<void> {
  await page.addScriptTag({ path: AXE_PATH });
  await page.waitForFunction(() => "axe" in window);
  // Freeze CSS transitions/animations. Many elements carry `transition-colors`,
  // so a live theme flip animates each one from its dark to its light colour
  // over ~150ms; an axe run fired mid-flip would measure a transient
  // intermediate colour (a false-positive contrast failure), not the settled
  // AA-compliant value. Killing transition/animation durations makes the theme
  // change instantaneous and the measurement deterministic.
  await page.addStyleTag({
    content:
      "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }",
  });
}
