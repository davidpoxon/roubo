import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "../e2e-flow/_support/scenario.js";

// TC-180 (US-024, FR-074/075/076, NFR-018): the github.com source toggle for
// Dependabot alerts surfaces an OAuth re-consent affordance when the token
// lacks `security_events`, the inline re-consent completes deterministically,
// and the cut list interleaves a Dependabot row whose row has no transition
// or assign affordances.
//
// Pinning: the spec drives the `alerts-dependabot-e2e` stub scenario via
// /test/__reset with `--scenario` and `--now`. The stub's
// `listIssuesSequence` keeps the missing-scope 401 warning visible across the
// pre-reconsent pulls (BenchDashboard always mounts IssuePickerModal +
// useIssues, so the warnings query is never the very first listIssues call
// against the project) and then transitions to "no warning, Dependabot row
// interleaved" after the OAuth dialog invalidates the issue + warnings
// queries on success. The UI flow between is the chip → dialog → success
// path.
//
// OAuth round-trip: the production dialog opens a system browser and waits on
// an Electron deep-link callback. The Playwright run uses plain Chromium, so
// the spec installs a `window.roubo.onDeepLink` shim (and stubs `window.open`)
// before navigation; clicking "Continue to GitHub" is followed by a synthetic
// deep-link via `page.evaluate`, which advances the dialog to `success` and
// invalidates the issue + warnings queries.

const SCENARIO = "alerts-dependabot-e2e";
const NOW = "2026-05-26T10:00:00.000Z";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// WU-069 uses its own fixture rather than the shared `test-project` (WU-067)
// because the alerts spec needs a different project id (`alerts-e2e`), a
// distinct sources block (`includeDependabotAlerts: true`), and a fresh port
// range. Sharing the cut-list fixture would collide on project id and force
// the alerts spec to mutate cut-list defaults that other specs assert.
const FIXTURE_PROJECT_PATH = path.resolve(__dirname, "..", "fixtures", "alerts-test-project");
const PROJECT_ID = "alerts-e2e";

test.beforeEach(async ({ request, page }) => {
  await resetWithScenario(request, SCENARIO, NOW);

  // Stub the Electron preload surface the client expects. Once `window.roubo`
  // is defined, optional-chained callers (`window.roubo?.setBadgeCount(...)`,
  // useNotificationStream, useMenuNav, etc.) stop short-circuiting and try to
  // invoke the methods — so the shim has to be complete, not just the
  // OAuthReconsentDialog hooks we actually drive. `onDeepLink` captures the
  // handler so the spec can trigger the callback synthetically; everything
  // else is a no-op that mirrors the Electron preload's shape. `window.open`
  // is also no-op'd so clicking "Continue to GitHub" never navigates Chromium
  // off the dialog (OAuthReconsentDialog.tsx:145).
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

  // Register the fixture project so the host has a valid projectId to hang
  // the e2e-stub integration off. The fixture's roubo.yaml pre-pins the
  // active plugin and a Dependabot-enabled source so no UI dance is needed
  // to reach the "warning chip surfaces" state. /test/__reset wipes the
  // persisted project + override files between specs.
  const register = await request.post("/api/projects", {
    data: { repoPath: FIXTURE_PROJECT_PATH },
  });
  expect(register.status()).toBe(201);

  // Seed the override so the dialog's "Test connection" success path can
  // commit instance/advanced into a writable file (the save endpoint refuses
  // to write a config update when no override sets the active plugin —
  // server/routes/integration.ts:346-351). The committed roubo.yaml already
  // names e2e-stub; the override here only ensures the override file exists
  // with the same plugin so the dialog's saveMutation can land.
  const overrideRes = await request.put(`/api/projects/${PROJECT_ID}/integration/override`, {
    data: { plugin: "e2e-stub" },
  });
  expect(overrideRes.status()).toBe(200);
});

test("Dependabot alerts: warning chip → OAuth re-consent → cut list updates", async ({
  page,
  request,
}) => {
  // Load the app shell, then go straight to the project settings tab — the
  // Issue Source tile (which hosts the Configure button + the SourcePicker
  // the warning chip surfaces in) lives there. Skipping the Benches tab
  // avoids firing the cut-list's listIssues query early and consuming a
  // listIssuesSequence step before the Configure dialog has mounted.
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}/settings`);

  // Open the Configure dialog. The Issue Source tile's primary action is
  // labelled by the plugin's connection state; for the e2e-stub `connected`
  // scenario this resolves to "Configure".
  await page.getByRole("button", { name: "Configure" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The Configure dialog gates the sources section behind a successful
  // "Test connection" run (PluginConfigureDialog.tsx:563-566). Click the
  // test button and wait for the success row — the stub's validateConfig +
  // getCurrentUser pair always succeeds against the pinned scenario, and
  // category probes are skipped for non-github-family plugin ids so this
  // does not consume the listIssuesSequence.
  await dialog.getByTestId("test-connection").click();
  await expect(dialog.getByTestId("test-result-success")).toBeVisible();
  await expect(dialog.getByTestId("sources-section")).toBeVisible();

  // Expand the security-alerts disclosure for the configured source so the
  // per-category checkboxes (and the warning chip surfacing on them) become
  // visible. `data-testid` values that contain "/" require the slash-safe
  // attribute selector form — `getByTestId` would interpret it as a value
  // but the underlying CSS selector is fine.
  const disclosure = dialog.locator('[data-testid="security-alerts-disclosure-acme/widgets"]');
  await expect(disclosure).toBeVisible();
  await disclosure.getByRole("button").first().click();

  // The Dependabot checkbox should already be selected because the fixture
  // roubo.yaml pre-pins `includeDependabotAlerts: true`, and the warning
  // chip should be visible next to it (the stub returned a 401 missing-scope
  // warning on the first listIssues pull).
  const dependabotCheckbox = dialog.getByTestId("alert-checkbox-includeDependabotAlerts");
  await expect(dependabotCheckbox).toBeVisible();
  const chip = dialog.getByTestId("alert-chip-oauth-recoverable");
  await expect(chip).toBeVisible();

  // Click the chip → OAuth re-consent dialog opens.
  await chip.click();
  const oauthDialog = page.getByTestId("oauth-reconsent-dialog");
  await expect(oauthDialog).toBeVisible();

  // Continue to GitHub. window.open is shimmed, so no real navigation
  // happens; the dialog advances to waiting-for-browser and the URL it
  // would have opened is captured for the assertion below.
  await page.getByTestId("oauth-reconsent-continue").click();
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

  // Drive the deep-link callback the dialog is waiting on. This is the same
  // shape an Electron build receives from the main process after GitHub
  // redirects to roubo://oauth/github/callback. The dialog reads the code
  // and state, advances to `success`, and invalidates the issue list +
  // integration-warnings queries.
  await page.evaluate(() => {
    const handlers = (
      window as unknown as { __rouboDeepLinkHandlers: Array<(url: string) => void> }
    ).__rouboDeepLinkHandlers;
    for (const handler of handlers) {
      handler("roubo://oauth/github/callback?code=e2e-fake-code&state=e2e-fake-state");
    }
  });

  // The dialog auto-closes after SUCCESS_HOLD_MS (600ms in product code).
  await expect(oauthDialog).toBeHidden({ timeout: 5_000 });

  // The post-success refetch lands on the final listIssuesSequence step:
  // no warnings, Dependabot row interleaved. The warning chip in the open
  // SourcePicker should disappear once the warnings query resolves.
  await expect(chip).toBeHidden({ timeout: 5_000 });

  // Verify on the host side that the post-reconsent pull returned the
  // Dependabot row with the read-only fields the cut-list view keys off
  // (allowedTransitions: [] and assignees: []). DraggableIssueCard's unit
  // tests cover the chip + suppressed-actions rendering against the same
  // upstream contract; asserting the contract here keeps this spec focused
  // on the OAuth-flow happy path without duplicating cut-list rendering.
  const secondPage = await request.get(`/api/projects/${PROJECT_ID}/issues`);
  expect(secondPage.status()).toBe(200);
  const secondBody = (await secondPage.json()) as {
    items: Array<{
      externalId: string;
      issueType: string | null;
      allowedTransitions: string[];
      assignees: Array<unknown>;
    }>;
    warnings?: unknown[];
  };
  expect(secondBody.warnings ?? []).toHaveLength(0);
  const dependabotRow = secondBody.items.find((it) => it.issueType === "security-dependabot");
  expect(dependabotRow).toBeDefined();
  expect(dependabotRow?.externalId).toBe("acme/widgets:dependabot:42");
  // FR-075: alert rows are read-only — no host-mediated state transitions
  // and no assignees, which is what the cut-list view uses to suppress the
  // transition / assign affordances on the row.
  expect(dependabotRow?.allowedTransitions).toEqual([]);
  expect(dependabotRow?.assignees).toEqual([]);
});
