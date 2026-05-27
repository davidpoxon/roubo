import { expect, test } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "../e2e-flow/_support/scenario.js";
import { registerTestProject } from "../project-settings/_support/test-project.js";

// TC-166 (US-013, US-025, FR-046/077/078/080, NFR-018): a GHE PAT user enables
// `includeSecretScanningAlerts`, sees the GHE PAT-regeneration warning chip
// (WU-040), simulates a PAT regen by re-entering the token in the Configure
// dialog and re-testing the connection, and lands in a state where the chip
// has cleared and the cut list interleaves a `security-secret-scanning` row
// (WU-042) with no host-mediated transitions and no assignees (FR-075).
//
// Pinning: the spec drives the `alerts-ghe-secret-scanning-enable` stub
// scenario via /test/__reset with `--scenario` and `--now`. The stub's
// `listIssuesSequence` keeps the missing-scope 401 warning visible across the
// pre-PAT-regen pulls (the settings page and the Configure dialog each
// trigger their own listIssues call), then transitions to "no warning, secret
// scanning alert row interleaved" after Save invalidates the issue +
// warnings queries on success.
//
// Unlike the github.com / Dependabot OAuth flow (TC-180), the GHE PAT branch
// has no in-app reconnect dialog. The chip is a plain external link to the
// instance's /settings/tokens page; the user regenerates the PAT there and
// pastes the new value back into the Configure dialog's existing token
// field. The spec stubs `window.open` so the link click does not navigate
// the test browser, but does not click the chip — asserting `href` and
// `target` is the verifiable surface and avoids a flaky new-tab race.

const SCENARIO = "alerts-ghe-secret-scanning-enable";
const NOW = "2026-05-27T10:00:00.000Z";
const PROJECT_ID = "alerts-ghe-e2e";
const INSTANCE = "https://ghe.example.com";

test.beforeEach(async ({ request, page }) => {
  await resetWithScenario(request, SCENARIO, NOW);

  // Shim `window.open` so clicking the chip (or any other link target) does
  // not navigate Chromium off the dialog. The spec asserts on `href` and
  // `target` rather than driving a click, but other surfaces in the app may
  // still try to open windows during the flow (e.g. the GitHub OAuth
  // section's "Connect" button is rendered as a no-op for ghe but the shim
  // keeps the contract uniform with the dependabot spec).
  await page.addInitScript(() => {
    const openedUrls: string[] = [];
    (window as unknown as { __rouboOpenedUrls: string[] }).__rouboOpenedUrls = openedUrls;
    window.open = (url?: string | URL) => {
      if (typeof url === "string") openedUrls.push(url);
      else if (url instanceof URL) openedUrls.push(url.toString());
      return null;
    };
  });

  // Register a throwaway project pinned to the ghe overlay. The override
  // carries everything the Configure dialog and SourcePicker key off:
  // `instance` flows into chipContext.gheInstanceUrl (which gates the GHE
  // chip variant), `sources` pre-pins `includeSecretScanningAlerts: true`
  // so the disclosure surfaces the chip on first render (AC #1 reads "the
  // toggle is on"), and `capturedUserId` lets the stub's getCurrentUser
  // resolve without an OAuth dance.
  await registerTestProject(request, {
    projectId: PROJECT_ID,
    plugin: "ghe",
    integrationConfig: {
      instance: INSTANCE,
      sources: {
        // The CATEGORY_TO_KIND map in
        // server/services/plugin-source-translation.ts keys per-project
        // source selection by the candidate category id ("Repository"),
        // not the plugin-internal kind ("repo"). Using "repo" here logs a
        // "ignoring unknown source category" warning and drops the source,
        // which prevents the security-alerts disclosure from rendering.
        Repository: [
          {
            externalId: "acme/widgets",
            includeSecretScanningAlerts: true,
          },
        ],
      },
      capturedUserId: { externalId: "alice", displayName: "Alice Stub" },
    },
  });
});

test("GHE PAT user: missing-scope chip → simulated PAT regen → cut list updates", async ({
  page,
  request,
}) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}/settings`);

  // Open the Configure dialog. The Issue Source tile's primary action is the
  // single CTA across plugins; the ghe-consolidation-parity precedent
  // (TC-179) uses the same test-id, so prefer it over a name-based lookup.
  await page.getByTestId("issue-source-primary-action").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("plugin-configure-dialog-header")).toBeVisible();

  // The Configure dialog gates the sources section behind a successful
  // "Test connection" run (PluginConfigureDialog.tsx:606). For the e2e-stub
  // delegate behind the ghe overlay, validateConfig + getCurrentUser always
  // succeed against the pinned scenario, so this does not consume a
  // listIssuesSequence step.
  await dialog.getByTestId("test-connection").click();
  await expect(dialog.getByTestId("test-result-success")).toBeVisible();
  await expect(dialog.getByTestId("sources-section")).toBeVisible();

  // Expand the security-alerts disclosure for the configured source so the
  // per-category checkboxes (and the warning chip surfacing on them) become
  // visible. `data-testid` values that contain "/" force the CSS attribute
  // selector form — `getByTestId` would interpret the slash as a value.
  const disclosure = dialog.locator('[data-testid="security-alerts-disclosure-acme/widgets"]');
  await expect(disclosure).toBeVisible();
  await disclosure.getByRole("button").first().click();

  // AC #1: the Secret scanning checkbox is on (pre-pinned by the override
  // above). AC #2: the GHE PAT-regeneration chip is visible alongside it
  // because the stub's first listIssues pull returned the missing-scope
  // 401 warning.
  const secretCheckbox = dialog.getByTestId("alert-checkbox-includeSecretScanningAlerts");
  await expect(secretCheckbox).toBeVisible();
  const chip = dialog.getByTestId("alert-chip-missing-scope-ghe");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("href", `${INSTANCE}/settings/tokens`);
  await expect(chip).toHaveAttribute("target", "_blank");

  // Simulate the PAT regeneration: the user has hit the GHE settings page,
  // generated a new PAT with `security_events`, and pasted it back into
  // the Configure dialog's token field. The stub does not consult the
  // token value, so any non-empty string is fine.
  const tokenField = dialog.getByTestId("config-field-token");
  await tokenField.locator("input").fill("ghp_e2e_new_pat_value");

  // Re-running Test connection invalidates the connection query and (on
  // Save) the issue + warnings queries. The stub still succeeds; this is
  // the "scope-verification succeeds" beat of AC #3.
  //
  // The default 5s timeout is tight here on a loaded CI runner: this is the
  // second test-connection in the flow, so `runTest` chains testMutation,
  // setTestResult, then an in-flight saveMutation that invalidates the
  // project-integration query (PluginConfigureDialog.tsx:496-510). Local
  // runs finish well inside 5s, but CI parallelism around this spec pushed
  // the success-strip render past the default and produced a flake. Bumping
  // to 15s keeps the contract (the strip must surface to gate Save) while
  // absorbing the slow-CI latency without weakening the assertion.
  await dialog.getByTestId("test-connection").click();
  await expect(dialog.getByTestId("test-result-success")).toBeVisible({ timeout: 15_000 });

  // Commit the new PAT. Save invalidates the issue and warnings queries;
  // the next listIssues lands on the final sequence step (no warnings,
  // secret-scanning row interleaved).
  await dialog.getByTestId("save-config").click();
  await expect(dialog).toBeHidden({ timeout: 5_000 });

  // FR-077/078: the post-save refetch returns no warnings on the new pull.
  // FR-075 (read-only alert rows): the cut-list entry has empty
  // allowedTransitions and assignees, which is what DraggableIssueCard
  // keys off to suppress transition and assign affordances.
  const issues = await request.get(`/api/projects/${PROJECT_ID}/issues`);
  expect(issues.status()).toBe(200);
  const body = (await issues.json()) as {
    items: Array<{
      externalId: string;
      issueType: string | null;
      allowedTransitions: string[];
      assignees: Array<unknown>;
    }>;
    warnings?: unknown[];
  };
  expect(body.warnings ?? []).toHaveLength(0);
  const secretRow = body.items.find((it) => it.issueType === "security-secret-scanning");
  expect(secretRow).toBeDefined();
  expect(secretRow?.externalId).toBe("acme/widgets:secret-scanning:7");
  expect(secretRow?.allowedTransitions).toEqual([]);
  expect(secretRow?.assignees).toEqual([]);
});
