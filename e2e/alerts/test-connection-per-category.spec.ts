import { expect, test } from "@playwright/test";
import {
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
} from "../e2e-flow/_support/scenario.js";

// TC-167 (US-013, FR-047/077/078/080, NFR-018): the Test connection per-category
// result strip surfaces alert-feed errors distinctly from issues. The spec
// drives a github.com source whose stored OAuth token lacks `security_events`,
// clicks Test connection (per-category strip shows Issues OK + Alerts: scope
// missing), clicks the inline Re-consent chip rendered next to the Dependabot
// checkbox, completes the stubbed OAuth round-trip, and re-runs Test connection
// (strip shows Issues OK + Alerts OK).
//
// Per-category placement: the result strip in `PluginConfigureDialog` is
// presentation-only (CategoryRow has no action). The Re-consent affordance
// lives inside `SecurityAlertsDisclosure` on the alerts checkbox row, which is
// part of the same Configure dialog and surfaces the same scope-missing
// condition (PluginConfigureDialog reads `useIssueListWarnings`, which fires
// on dialog mount). That matches the shipped UX (FR-045 / WU-039) and the
// dependabot-e2e.spec.ts precedent.
//
// Scenario: `alerts-test-connection-scope-missing` declares a
// `probeAlertCategoriesSequence` (scope-missing → ok) and a matching
// `listIssuesSequence` (missing-scope warning → no warning) so the strip and
// the chip both reflect the same state at each step. The OAuth success path
// invalidates the integration-warnings + issues queries (OAuthReconsentDialog
// and useDeepLink), which consumes step 1 of the listIssues sequence and
// makes the chip disappear; the next Test connection click consumes step 1 of
// the probe sequence and flips the Dependabot row to ok.

const SCENARIO = "alerts-test-connection-scope-missing";
const NOW = "2026-05-27T10:00:00.000Z";
const PROJECT_ID = "test-connection-per-category";
const SOURCE_EXTERNAL_ID = "acme/widgets";

test.beforeEach(async ({ request, page }) => {
  await resetWithScenario(request, SCENARIO, NOW);

  // Electron preload surface stub. Identical shape to the dependabot-e2e
  // spec: the dialog reads `window.roubo.onDeepLink` to receive the OAuth
  // callback, and the rest are no-op shims so optional-chained callers
  // elsewhere in the client do not short-circuit. `window.open` is stubbed so
  // the Continue-to-GitHub click never navigates Chromium off the dialog.
  await page.addInitScript(() => {
    const deepLinkHandlers: Array<(url: string) => void> = [];
    const openedUrls: string[] = [];
    (
      window as unknown as {
        roubo: {
          platform: string;
          onDeepLink: (h: (url: string) => void) => () => void;
          onNavigate: (h: (path: string) => void) => () => void;
          setBadgeCount: (n: number) => void;
          showNotification: (n: { title: string; body: string; routeTo?: string }) => void;
          setTitleBarOverlayTheme: (theme: "dark" | "light") => void;
          getAppVersion: () => Promise<string>;
        };
      }
    ).roubo = {
      platform: "darwin",
      onDeepLink: (handler) => {
        deepLinkHandlers.push(handler);
        return () => {
          const idx = deepLinkHandlers.indexOf(handler);
          if (idx >= 0) deepLinkHandlers.splice(idx, 1);
        };
      },
      onNavigate: () => () => {},
      setBadgeCount: () => {},
      showNotification: () => {},
      setTitleBarOverlayTheme: () => {},
      getAppVersion: () => Promise.resolve("0.0.0-e2e"),
    };
    (
      window as unknown as { __rouboDeepLinkHandlers: typeof deepLinkHandlers }
    ).__rouboDeepLinkHandlers = deepLinkHandlers;
    (window as unknown as { __rouboOpenedUrls: string[] }).__rouboOpenedUrls = openedUrls;
    window.open = (url?: string | URL) => {
      if (typeof url === "string") openedUrls.push(url);
      else if (url instanceof URL) openedUrls.push(url.toString());
      return null;
    };
  });

  // Register a fixture project pinned to the github-com bundled-overlay slot,
  // with one repo source whose Dependabot toggle is on. github-com is the
  // plugin id the host's `runCategoryProbes` gates on (only the GitHub family
  // triggers `probeAlertCategories`), so the strip will surface a per-category
  // Dependabot row on the first Test connection click.
  await registerFixtureProject(request, {
    projectId: PROJECT_ID,
    plugin: "github-com",
    integrationConfig: {
      // The roubo.yaml `sources` map is keyed by source-candidate category id;
      // the scenario's `sourceCandidates` puts `acme/widgets` under the
      // `Repository` category, so the configured source slots in there.
      // `translateSources` will map this to `{ kind: "repo", externalId }`
      // when the host invokes `probeAlertCategories`.
      sources: {
        Repository: [
          {
            externalId: SOURCE_EXTERNAL_ID,
            includeDependabotAlerts: true,
          },
        ],
      },
    },
  });
});

// Skipped pending #279. The Re-consent chip rendered inside the per-source
// security-alerts disclosure that PR #278 removed along with the SourcePicker.
// Re-author against the new derived-sources preview once the alerts surface
// is finalised.
test.skip("Test connection per-category: Alerts scope-missing -> Re-consent -> ok", async ({
  page,
}) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}/settings`);

  // Open the Configure dialog. The Issue Source tile's primary action is
  // labelled by the plugin's connection state; the pinned scenario is
  // `connected`, so the button reads "Configure".
  await page.getByRole("button", { name: "Configure" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // First Test connection click: validateConfig + getCurrentUser succeed, and
  // the host's `runCategoryProbes` invokes the stub's `probeAlertCategories`
  // which returns step 0 of the sequence (Dependabot scope-missing).
  await dialog.getByTestId("test-connection").click();
  await expect(dialog.getByTestId("test-result-success")).toBeVisible();
  await expect(dialog.getByTestId("test-result-category-issues-ok")).toBeVisible();
  await expect(dialog.getByTestId("test-result-category-dependabot-scope-missing")).toBeVisible();

  // Expand the security-alerts disclosure for the configured source so the
  // Dependabot checkbox row (and its inline Re-consent chip) becomes visible.
  // `data-testid` values that contain "/" require the attribute-selector form
  // because `getByTestId` treats the slash as a value separator.
  const disclosure = dialog.locator(
    `[data-testid="security-alerts-disclosure-${SOURCE_EXTERNAL_ID}"]`,
  );
  await expect(disclosure).toBeVisible();
  await disclosure.getByRole("button").first().click();

  // The chip surfaces because `useIssueListWarnings` fired on dialog mount and
  // the stub's `listIssuesSequence` step 0 returned a `missing-scope` warning
  // for the Dependabot category. pluginId === "github-com" selects the
  // `Reconnect GitHub` chip variant.
  const reconnectChip = dialog.getByTestId("alert-chip-missing-scope-github-com");
  await expect(reconnectChip).toBeVisible();

  // Click the chip → `chipContext.onReconnectOAuth` fires (this branch of
  // WarningChip routes through `startGithubPluginOauth` + `window.open` rather
  // than the OAuthReconsentDialog, because the chip lives on the source row
  // and the dialog handler is only wired for the `oauth-recoverable` variant
  // used by other plugins). `window.open` is shimmed, so the captured URL is
  // asserted below for parity with the dependabot-e2e spec.
  await reconnectChip.click();
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as unknown as { __rouboOpenedUrls: string[] }).__rouboOpenedUrls.length,
      ),
    )
    .toBeGreaterThan(0);
  const openedUrls = await page.evaluate(
    () => (window as unknown as { __rouboOpenedUrls: string[] }).__rouboOpenedUrls,
  );
  expect(openedUrls[0]).toContain("/login/oauth/authorize");

  // Drive the deep-link callback the app's `useDeepLink` hook subscribes to.
  // Mirrors the Electron main-process forward after GitHub redirects to
  // roubo://oauth/github/callback. The hook invalidates the `issues` and
  // `integration-warnings` queries (useDeepLink.ts:34-40), which refetches
  // `useIssueListWarnings` and consumes the final step of `listIssuesSequence`
  // (no warning) — the chip then disappears.
  await page.evaluate(() => {
    const handlers = (
      window as unknown as { __rouboDeepLinkHandlers: Array<(url: string) => void> }
    ).__rouboDeepLinkHandlers;
    for (const handler of handlers) {
      handler("roubo://oauth/github/callback?code=e2e-fake-code&state=e2e-fake-state");
    }
  });

  await expect(reconnectChip).toBeHidden({ timeout: 5_000 });

  // Second Test connection click: the host probes again and the stub returns
  // step 1 of `probeAlertCategoriesSequence` (Dependabot ok). The expanded
  // alerts disclosure makes the dialog tall enough that the test-connection
  // button sits outside the viewport, and the dialog's modal positioning
  // prevents Playwright from scrolling the page to bring it back. Dispatch
  // the press via React Aria's pointer event sequence on the button element
  // directly — same effect as a real click on the rendered handler, without
  // the viewport check.
  await dialog.getByTestId("test-connection").dispatchEvent("click");
  await expect(dialog.getByTestId("test-result-category-issues-ok")).toBeVisible();
  await expect(dialog.getByTestId("test-result-category-dependabot-ok")).toBeVisible();
  await expect(dialog.getByTestId("test-result-category-dependabot-scope-missing")).toBeHidden();
});
