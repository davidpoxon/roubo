import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "../e2e-flow/_support/scenario.js";

// TC-165 (US-011, US-025, FR-040, FR-041, FR-043, FR-045, FR-077, FR-078,
// FR-080, NFR-018): user toggles `includeCodeQLAlerts` on for a github.com
// source whose OAuth token lacks `security_events`. The save persists the
// flag and invalidates the integration-warnings query; the inline
// `alert-chip-oauth-recoverable` chip surfaces from the stub's missing-scope
// 401 warning and drives the OAuth re-consent dialog through a synthetic
// deep-link callback. After success, the cut list interleaves a CodeQL row
// (`security-code-scanning`) with the regular Bug, with `allowedTransitions:
// []` and `assignees: []` so DraggableIssueCard renders the read-only CodeQL
// chip and suppresses the transition / assign affordances.
//
// Pinning: the spec drives the `alerts-codeql-enable` stub scenario via
// /test/__reset with `--scenario` and `--now`. The stub's
// `listIssuesSequence` keeps the missing-scope 401 warning visible across
// every pre-OAuth listIssues pull (BenchDashboard mounts IssuePickerModal
// with `useIssues` unconditionally, the Configure dialog adds
// `useIssueListWarnings` on top, and the post-save invalidation refetches
// both) and then transitions on the post-reconsent refetch to "CodeQL row
// interleaved, no warning." All subsequent calls — including the spec's
// final `GET /api/projects/:id/issues` — clamp at the final step.
//
// Why this spec exercises the toggle that TC-180 skipped: TC-180 pre-pinned
// `includeDependabotAlerts: true` in its fixture because the path it
// asserts is chip → OAuth → cut list, not the toggle. The CodeQL user
// story (US-011) literally starts at "the user toggles CodeQL on," so this
// spec drives the checkbox + Save flow. The chip is visible from the first
// dialog open (the stub's missing-scope warning is present from step 1 so
// the test stays robust against unconditional pre-toggle listIssues
// consumers — see scenario fixture for the rationale).

const SCENARIO = "alerts-codeql-enable";
const NOW = "2026-05-26T10:00:00.000Z";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// TC-165 uses its own fixture rather than `alerts-test-project` because the
// CodeQL spec needs a different project id (`codeql-e2e`), a fresh port range,
// and a sources block where no alert flags are pre-pinned (the spec is
// responsible for toggling `includeCodeQLAlerts: true` on through the UI).
// Sharing the Dependabot fixture would collide on project id and would also
// hide the toggle action behind a pre-pinned flag.
const FIXTURE_PROJECT_PATH = path.resolve(__dirname, "..", "fixtures", "codeql-test-project");
const PROJECT_ID = "codeql-e2e";

test.beforeEach(async ({ request, page }) => {
  await resetWithScenario(request, SCENARIO, NOW);

  // Stub the Electron preload surface so the client can mount without the
  // host process. Mirrors `e2e/alerts/dependabot-e2e.spec.ts` — see that file
  // for the rationale. `onDeepLink` captures handlers so the spec can fire a
  // synthetic OAuth callback, and `window.open` is a no-op that records URLs
  // so the assertion below can verify the `security_events` scope without
  // navigating Chromium away from the dialog.
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

  const register = await request.post("/api/projects", {
    data: { repoPath: FIXTURE_PROJECT_PATH },
  });
  expect(register.status()).toBe(201);

  // Seed the override so saveMutation has a writable override file targeting
  // the e2e-stub plugin (the dialog's save path refuses to write a config
  // update when no override sets the active plugin — see
  // server/routes/integration.ts:346-351).
  const overrideRes = await request.put(`/api/projects/${PROJECT_ID}/integration/override`, {
    data: { plugin: "e2e-stub" },
  });
  expect(overrideRes.status()).toBe(200);
});

// Skipped pending #279. PR #278 removed the SourcePicker tile (which owned
// `sources-section` and the per-source security-alerts disclosure) in favour
// of server-side sources auto-derivation, so the toggle-on / disclosure flow
// this spec drives no longer has a UI surface. Re-author against the new
// derived-sources preview once the design lands.
test.skip("CodeQL alerts: toggle on -> warning chip -> OAuth re-consent -> cut list interleaves", async ({
  page,
  request,
}) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}/settings`);

  // Open Configure. Test connection unlocks the sources section; the stub's
  // validateConfig + getCurrentUser pair always succeeds against the pinned
  // scenario, and category probes are skipped for non-github-family plugin
  // ids so the click does not consume a listIssuesSequence step.
  await page.getByRole("button", { name: "Configure" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("test-connection").click();
  await expect(dialog.getByTestId("test-result-success")).toBeVisible();
  await expect(dialog.getByTestId("sources-section")).toBeVisible();

  const disclosure = dialog.locator('[data-testid="security-alerts-disclosure-acme/widgets"]');
  await expect(disclosure).toBeVisible();
  await disclosure.getByRole("button").first().click();

  // The CodeQL checkbox starts unchecked (the fixture roubo.yaml does not
  // pre-pin `includeCodeQLAlerts`). The user toggles it on; `Save` then
  // commits the source selection and `useSaveProjectSources.onSettled`
  // invalidates the integration-warnings query so the chip rendering stays
  // in sync after the persisted flag is in place.
  const codeqlCheckbox = dialog.getByTestId("alert-checkbox-includeCodeQLAlerts");
  await expect(codeqlCheckbox).toBeVisible();
  await expect(codeqlCheckbox).not.toBeChecked();
  await codeqlCheckbox.click();
  await expect(codeqlCheckbox).toBeChecked();
  await dialog.getByTestId("save-config").click();
  await expect(dialog).toBeHidden({ timeout: 5_000 });

  // Reopen Configure so the user can see the persisted state and act on the
  // inline OAuth re-consent affordance. Test connection again to unlock the
  // sources section (the dialog gates it on a successful test per session).
  await page.getByRole("button", { name: "Configure" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("test-connection").click();
  await expect(dialog.getByTestId("test-result-success")).toBeVisible();
  await expect(dialog.getByTestId("sources-section")).toBeVisible();
  const reopenedDisclosure = dialog.locator(
    '[data-testid="security-alerts-disclosure-acme/widgets"]',
  );
  await reopenedDisclosure.getByRole("button").first().click();

  // The CodeQL checkbox now reflects the persisted flag, and the inline
  // OAuth re-consent chip is visible alongside it.
  const reopenedCheckbox = dialog.getByTestId("alert-checkbox-includeCodeQLAlerts");
  await expect(reopenedCheckbox).toBeChecked();
  const chip = dialog.getByTestId("alert-chip-oauth-recoverable");
  await expect(chip).toBeVisible();

  // Click the chip → OAuth re-consent dialog opens.
  await chip.click();
  const oauthDialog = page.getByTestId("oauth-reconsent-dialog");
  await expect(oauthDialog).toBeVisible();

  // Continue to GitHub. `window.open` is shimmed so Chromium does not
  // navigate; the URL it would have opened is captured for the scope
  // assertion below.
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
  // TC-165-specific assertion: the authorize URL requests `security_events`,
  // the scope that unlocks the CodeQL alert category.
  expect(openedUrls[0]).toContain("security_events");

  // Drive the synthetic deep-link the dialog is waiting on. This advances
  // the dialog to `success` and invalidates the issue + integration-warnings
  // queries. The next listIssues lands on the stub's final sequence step
  // (CodeQL row, no warning); all subsequent calls clamp at that step.
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

  // Verify the host-side contract the cut-list view keys off: the
  // post-reconsent pull returns the CodeQL row interleaved with the regular
  // Bug, with no warnings, `allowedTransitions: []`, and `assignees: []`.
  // DraggableIssueCard's unit tests cover the chip + suppressed-actions
  // rendering against the same upstream contract; asserting the contract
  // here keeps this spec focused on the OAuth + interleave happy path
  // without duplicating cut-list rendering.
  const issuesRes = await request.get(`/api/projects/${PROJECT_ID}/issues`);
  expect(issuesRes.status()).toBe(200);
  const issuesBody = (await issuesRes.json()) as {
    items: Array<{
      externalId: string;
      issueType: string | null;
      allowedTransitions: string[];
      assignees: Array<unknown>;
    }>;
    warnings?: unknown[];
  };
  expect(issuesBody.warnings ?? []).toHaveLength(0);
  const codeqlRow = issuesBody.items.find((it) => it.issueType === "security-code-scanning");
  expect(codeqlRow).toBeDefined();
  expect(codeqlRow?.externalId).toBe("acme/widgets:code-scanning:7");
  // FR-077 / FR-080: CodeQL rows are read-only — no host-mediated state
  // transitions and no assignees.
  expect(codeqlRow?.allowedTransitions).toEqual([]);
  expect(codeqlRow?.assignees).toEqual([]);
  // FR-043: alerts are interleaved with regular issues, not segregated.
  const bugRow = issuesBody.items.find((it) => it.issueType === "Bug");
  expect(bugRow).toBeDefined();
});
