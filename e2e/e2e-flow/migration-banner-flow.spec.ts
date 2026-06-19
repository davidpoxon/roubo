import { expect, test } from "@playwright/test";
import { loadAppShell, resetWithScenario, seedOnlyToDoNotice } from "./_support/scenario.js";

// E2E (#574): the upgrade migration-banner journey for the only-to-do default
// flip (US-008). This is the integration-level drift guard for the journey and
// mirrors the authoritative e2e_flow case CLI-TC-047
// (.specifications/cut-list-improvements/test-cases.json), driving its steps
// S001-S004. It spans slice #558 (the OnlyToDoNoticeBanner behaviour) and
// asserts the integrated journey, not whatever any single slice implemented.
//
// The banner (client/src/components/OnlyToDoNoticeBanner.tsx) only renders when
// GET /api/migration/status returns a real ISO timestamp (NOT the "seeded"
// fresh-install sentinel) for ONLY_TO_DO_NOTICE_MARKER in `notices`.
// `/test/__reset` truncates state.json, so the marker is absent after a reset;
// the ROUBO_E2E-gated `seedOnlyToDoNotice` helper stamps a real timestamp,
// modelling "an existing install booting for the first time after upgrade".
//
// KNOWN DIVERGENCE FROM TC-047 (literal labels / inline dialog), owned by slice
// #558, OUT OF SCOPE for #574 (do not edit the banner):
//   - TC-047 S001-O02 expects a link literally labelled "Adjust status filter".
//     The shipped banner renders the status-filter affordance as a link with
//     text "status filter". We assert the ACTUAL accessible name.
//   - TC-047 S002 expects "Adjust status filter" to open the Status filter
//     dialog INLINE (with the In Progress / Done exclusion set shown). The
//     shipped banner instead routes to the status-filter settings
//     (/settings#plugins), where the Configure / status-exclusion dialog lives.
//     We encode the journey INTENT (the affordance reaches the status filter)
//     and assert the route + Plugins tab selection, the real surfaced behaviour.
//   - TC-047 S001-O02 expects a "Dismiss" button. The shipped control is an
//     icon button with the accessible name "Dismiss cut list notice"; we assert
//     that name. The banner is anchored on role="status" throughout, which both
//     TC-047 and the implementation agree on.
//
// "Restart Roubo" (S004) is dismissal-persistence, which is client-side
// localStorage keyed on the marker timestamp. A true server restart is not
// reproducible in this harness, so we model it as a same-context page reload:
// the localStorage dismissal marker survives, which is exactly what the
// persistence contract relies on.
//
// FR-020 failure-output contract: each assertion carries a message naming the
// diverging TC-047 step, the expected-vs-actual, and the owning slice issue
// #558.

const SCENARIO = "jira-sources-scale-cut-list";
const NOW = "2026-05-21T13:00:00.000Z";

// Accessible names actually rendered by the shipped banner (slice #558). Kept as
// constants so the FR-020 failure messages and the locators cannot drift apart.
const STATUS_FILTER_LINK_NAME = "status filter";
const DISMISS_BUTTON_NAME = "Dismiss cut list notice";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TC-047: upgrade migration banner shows, routes to the status filter, and stays dismissed", async ({
  page,
  request,
}) => {
  // Precondition: an existing install booting after upgrade with the banner not
  // yet dismissed. Seed the real timestamp BEFORE loading the app so the
  // first `useMigrationStatus` fetch returns it (the marker is read at first
  // paint and the query never refetches). The returned `at` is the value the
  // banner uses for its localStorage dismissal key, reused by S004 to prove the
  // post-reload absence is dismissal-persistence and not a loading-window race.
  const seededAt = await seedOnlyToDoNotice(request);

  // S001: launch Roubo / open the cut list (the banner is mounted in the app
  // shell above the route outlet, so loading the shell renders it).
  await loadAppShell(page);

  const banner = page.getByRole("status", { name: "Cut list default changed" });
  await expect(
    banner,
    "TC-047 S001-O01/O02 (slice #558): expected the role='status' migration banner to be visible after an upgrade boot with the marker stamped, but it was not rendered",
  ).toBeVisible();

  const statusFilterLink = banner.getByRole("link", { name: STATUS_FILTER_LINK_NAME });
  await expect(
    statusFilterLink,
    `TC-047 S001-O02 (slice #558): expected the banner's status-filter affordance (shipped as a link named '${STATUS_FILTER_LINK_NAME}'; TC-047 names it 'Adjust status filter') to be visible, but it was not found`,
  ).toBeVisible();

  const dismissButton = banner.getByRole("button", { name: DISMISS_BUTTON_NAME });
  await expect(
    dismissButton,
    `TC-047 S001-O02 (slice #558): expected the banner's dismiss control (shipped as a button named '${DISMISS_BUTTON_NAME}'; TC-047 names it 'Dismiss') to be visible, but it was not found`,
  ).toBeVisible();

  // S002: activate the status-filter affordance and assert it reaches the status
  // filter. TC-047 expects an inline Status filter dialog; the shipped banner
  // instead routes to the status-filter settings (/settings#plugins), where the
  // Configure / status-exclusion dialog lives. We assert that route + the
  // Plugins tab being selected: the journey INTENT (the affordance reaches the
  // status filter) is satisfied.
  await statusFilterLink.click();
  await expect(
    page,
    "TC-047 S002 (slice #558): expected activating the status-filter affordance to reach the status filter settings at /settings#plugins (the shipped surface where the status-exclusion dialog lives; TC-047 expects an inline Status filter dialog), but the URL did not match",
  ).toHaveURL(/\/settings#plugins$/);
  await expect(
    page.getByRole("tab", { name: "Plugins", selected: true }),
    "TC-047 S002 (slice #558): expected the Plugins settings tab (which hosts the per-project status-exclusion / Configure dialog) to be selected after following the banner's status-filter affordance, but it was not selected",
  ).toBeVisible();

  // S003: return to the cut list and dismiss the banner; assert it disappears.
  await loadAppShell(page);
  const bannerAgain = page.getByRole("status", { name: "Cut list default changed" });
  await expect(
    bannerAgain,
    "TC-047 S003 (slice #558): expected the banner to still be visible on returning to the cut list before dismissal, but it was not rendered",
  ).toBeVisible();
  await bannerAgain.getByRole("button", { name: DISMISS_BUTTON_NAME }).click();
  await expect(
    bannerAgain,
    "TC-047 S003-O01 (slice #558): expected the banner to disappear after clicking Dismiss, but it was still visible",
  ).toHaveCount(0);

  // S004: reload the page in the SAME browser context (preserving localStorage,
  // which is how dismissal persistence is implemented; a true server restart is
  // not reproducible in this harness). A full reload drops the React Query
  // cache, so `useMigrationStatus` refetches from scratch: while that fetch is
  // in flight `data` is undefined, the banner returns null, and a bare
  // `toHaveCount(0)` could pass during that loading window regardless of whether
  // dismissal actually persisted. So wait for the post-reload
  // /api/migration/status response (past the loading window) and assert it still
  // carries the seeded marker: the banner WOULD render were it not dismissed, so
  // the only remaining reason it stays absent is the persisted localStorage
  // dismissal. That is what makes the negative assertion test persistence.
  const [migrationResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/migration/status") && r.ok()),
    page.reload(),
  ]);
  const migration = (await migrationResponse.json()) as { notices?: Record<string, string> };
  expect(
    Object.values(migration.notices ?? {}),
    "TC-047 S004 (slice #558): expected the post-reload /api/migration/status response to still carry the seeded notice timestamp (so the banner WOULD render were it not dismissed; this proves the next assertion exercises dismissal-persistence, not the loading window), but it did not",
  ).toContain(seededAt);
  await expect(page.locator("#root")).toBeAttached();
  await expect(
    page.getByRole("status", { name: "Cut list default changed" }),
    "TC-047 S004-O01 (slice #558): expected the banner to stay dismissed after a same-context reload (localStorage dismissal marker keyed on the timestamp should survive), but it reappeared",
  ).toHaveCount(0);
});
