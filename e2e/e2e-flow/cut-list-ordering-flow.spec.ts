import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";

// #570: the integration-level drift guard for the US-004 journey "deterministic
// ordering via the sort picker, stable across pages". It spans the sort slices
// #554, #556, #562, #563, #564 and asserts the integrated journey against the
// authoritative e2e_flow case CLI-TC-035, not whatever any single slice
// implemented.
//
// TC-035 is reconciled to the SHIPPED contract here (following the precedent
// #584 set for TC-032 in .specifications/cut-list-improvements/test-cases.json).
// Three+ TC-035 observations diverge from the shipped UI:
//
//   1. There is NO separate "direction toggle". The shipped picker
//      (client/src/components/CutListSortControl.tsx) is a single trigger button
//      + popover; direction flips by RE-SELECTING the active field. The trigger
//      aria-label becomes `Sort cut list by <label>, <dir>ending` (e.g. "Sort
//      cut list by Recently updated, descending"), NOT S003-O01's "Sort
//      direction: descending".
//
//   2. There is NO sort-specific live region. The only live region
//      (data-testid="cut-list-page-live", aria-live polite, in
//      client/src/components/IssueQueuePanel.tsx) announces "Page 1" on the
//      sort-driven reset, NOT S002-O03's "Sorted by Recently updated".
//
//   3. The pager renders "Page 2" with NO "of N" (forward-only cursors), NOT
//      S001-O02's "Page 2 of N" (the same reconciliation TC-032 already made:
//      PaginatedIssues exposes nextCursor only, so a total N is unknowable).
//
//   4. When no sort is active the trigger shows only an icon (aria-label "Sort
//      cut list"), so S001-O01's literal "selected value is 'Key', ascending"
//      is only observable after the user selects the explicit `key` field. The
//      scenario declares {id:"key",label:"Key",defaultDir:"asc"} for exactly
//      this; the stub's `sortKept` (e2e/fixtures/stubbed-plugin/src/contract.ts)
//      returns natural (externalId-ascending) order for any non-title/updated
//      sortBy, so selecting "Key" honours key-ascending as long as the scenario
//      issues are listed in externalId order.
//
// FR-020 failure-output contract: every assertion below carries a descriptive
// message naming the diverging e2e_flow step (S001..S004), the expected-vs-actual,
// and the owning slice issue(s) from this unit's blocked_by/covers set
// (#554/#556/#562/#563/#564), so a regression points straight at the step and
// the slice that broke it.
//
// The fixture project (e2e/fixtures/cut-list-ordering-project) pins
// `integration.pageSize: 2`, and the scenario seeds four To Do cuts with
// DISTINCT updatedAt values, so the cut list spans two Prev/Next pages and
// key-order, updated-ascending, and updated-descending are all observably
// distinct and dupe-free across the page boundary.

const SCENARIO = "cut-list-ordering";
const NOW = "2026-05-21T13:00:00.000Z";

// The slices this journey spans (issue blocked_by / covers set).
const SORT_SLICE = "#554/#562/#563/#564"; // sort RPC contract + picker UI + per-plugin sort impls
const PAGE_SLICE = "#556"; // pagination / cross-page boundary

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(__dirname, "..", "fixtures", "cut-list-ordering-project");
const PROJECT_ID = "e2e-cut-list-ordering";

// Deterministic page sets at pageSize 2, computed from the scenario's chosen
// updatedAt values. The stub sorts `updated` by localeCompare of the ISO
// updatedAt string (lexicographic == chronological here), and returns natural
// externalId-ascending order for the `key` field.
//
//   updatedAt: #301=05-12, #302=05-09 (oldest), #303=05-15 (newest), #304=05-11
//
// key-asc (externalId):        #301 #302 | #303 #304
// updated-asc (oldest first):  #302 #304 | #301 #303
// updated-desc (newest first): #303 #301 | #304 #302
const KEY_ASC_PAGE_1 = ["#301", "#302"] as const;
const KEY_ASC_PAGE_2 = ["#303", "#304"] as const;
const UPDATED_ASC_PAGE_1 = ["#302", "#304"] as const;
const UPDATED_DESC_PAGE_1 = ["#303", "#301"] as const;
const UPDATED_DESC_PAGE_2 = ["#304", "#302"] as const;

const indicator = (page: Page) => page.getByTestId("cut-list-page-indicator");
const liveRegion = (page: Page) => page.getByTestId("cut-list-page-live");
const prevButton = (page: Page) => page.getByRole("button", { name: "Previous page" });
const nextButton = (page: Page) => page.getByRole("button", { name: "Next page" });
const sortButton = (page: Page) => page.getByRole("button", { name: "Sort cut list" });

async function expectRefsVisible(
  page: Page,
  refs: readonly string[],
  step: string,
  slice: string,
): Promise<void> {
  for (const ref of refs) {
    await expect(
      page.getByText(ref, { exact: true }),
      `${step} (TC-035, slice ${slice}): expected cut ${ref} on this page`,
    ).toBeVisible();
  }
}

async function expectRefsAbsent(
  page: Page,
  refs: readonly string[],
  step: string,
  slice: string,
): Promise<void> {
  for (const ref of refs) {
    await expect(
      page.getByText(ref, { exact: true }),
      `${step} (TC-035, slice ${slice}): cut ${ref} should not be on this page`,
    ).toHaveCount(0);
  }
}

// Open the picker, select a field by its option label, then dismiss the
// popover. The shipped picker (CutListSortControl) does NOT auto-close on
// selection, so its React Aria dismiss underlay stays mounted over the body and
// would intercept the next pager click. An outside click clears the underlay.
// The option label is `exact` so "Recently updated" never matches a substring
// of another field.
async function selectSortField(page: Page, optionLabel: string): Promise<void> {
  await sortButton(page).click();
  const option = page.getByRole("option", { name: optionLabel, exact: true });
  await expect(option).toBeVisible();
  await option.click();
  // The shipped picker does not auto-close on selection, and its React Aria
  // dismiss underlay sits over the whole body (intercepting both the trigger and
  // the pager). Dismiss it with an outside click at a fixed body coordinate
  // (top-left, clear of the bottom-end popover): React Aria treats the underlay
  // click as an interact-outside and closes the popover, detaching the underlay
  // so the next pager click lands.
  await page.mouse.click(5, 5);
  // The popover is closed once its option list is no longer mounted.
  await expect(option).toHaveCount(0);
}

async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register cut-list-ordering fixture project").toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(PROJECT_ID);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
  await registerProject(request);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
});

test("TC-035: deterministic ordering via the sort picker, stable across pages", async ({
  page,
}) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  // S001: establish "page 2 sorted by Key ascending". When no sort is active the
  // trigger shows only an icon (aria-label "Sort cut list"), so we select the
  // explicit `Key` field to reach the literal "Key, ascending" selected state
  // (S001-O01, reconciled: the picker has no standalone selected-value readout).
  // Then click Next to reach page 2 (S001-O02, reconciled to the shipped "Page 2"
  // tracking with no "of N").
  await selectSortField(page, "Key");
  await expect(
    sortButton(page),
    `S001 (TC-035, slice ${SORT_SLICE}): after selecting "Key" the trigger aria-label must read "Sort cut list by Key, ascending"`,
  ).toBeVisible();
  // The trigger's aria-label now encodes the selected field + direction.
  await expect(
    page.getByRole("button", { name: "Sort cut list by Key, ascending" }),
    `S001 (TC-035, slice ${SORT_SLICE}): expected the sort trigger to show "Key" ascending after selection`,
  ).toBeVisible();
  await expectRefsVisible(page, KEY_ASC_PAGE_1, "S001 page 1 key-asc content", SORT_SLICE);

  await nextButton(page).click();
  await expect(
    indicator(page),
    `S001 (TC-035, slice ${PAGE_SLICE}): after one Next the indicator must read "Page 2", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 2");
  await expectRefsVisible(page, KEY_ASC_PAGE_2, "S001 page 2 key-asc content", PAGE_SLICE);
  await expectRefsAbsent(page, KEY_ASC_PAGE_1, "S001 page 2 excludes page 1", PAGE_SLICE);

  // S002: open the picker and select "Recently updated". The list reorders by
  // last-updated and paging resets to page 1 (S002-O01/O02). The reset is
  // announced through the only live region (cut-list-page-live), which reads
  // "Page 1" -- there is NO sort-specific announcement (S002-O03 reconciled).
  await selectSortField(page, "Recently updated");
  await expect(
    indicator(page),
    `S002 (TC-035, slice ${SORT_SLICE}): a sort-field change must reset paging to "Page 1", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 1");
  await expect(
    prevButton(page),
    `S002 (TC-035, slice ${SORT_SLICE}): Prev must be disabled after the reset to page 1`,
  ).toBeDisabled();
  await expect(
    liveRegion(page),
    `S002 (TC-035, slice ${SORT_SLICE}): the live region must announce the reset as "Page 1" (no sort-specific announcement is shipped)`,
  ).toHaveText("Page 1");
  // Page 1 is now in updated-ASCENDING order (oldest first): #302 then #304.
  await expectRefsVisible(page, UPDATED_ASC_PAGE_1, "S002 page 1 updated-asc content", SORT_SLICE);
  await expectRefsAbsent(
    page,
    UPDATED_DESC_PAGE_1,
    "S002 updated-asc differs from updated-desc on page 1",
    SORT_SLICE,
  );

  // S003: re-select "Recently updated" to toggle the direction to descending
  // (there is no standalone direction toggle; re-selecting the active field
  // flips it). The trigger aria-label becomes "Sort cut list by Recently
  // updated, descending" (S003-O01 reconciled), the order reverses vs S002, and
  // paging resets to page 1 again (S003-O02).
  await selectSortField(page, "Recently updated");
  await expect(
    page.getByRole("button", { name: "Sort cut list by Recently updated, descending" }),
    `S003 (TC-035, slice ${SORT_SLICE}): re-selecting the active field must toggle the trigger aria-label to "Sort cut list by Recently updated, descending"`,
  ).toBeVisible();
  await expect(
    indicator(page),
    `S003 (TC-035, slice ${SORT_SLICE}): toggling the direction must reset paging to "Page 1", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 1");
  await expect(
    prevButton(page),
    `S003 (TC-035, slice ${SORT_SLICE}): Prev must be disabled after the reset to page 1`,
  ).toBeDisabled();
  // Page 1 is now in updated-DESCENDING order (newest first): #303 then #301,
  // the reverse of S002's updated-ascending page 1.
  await expectRefsVisible(
    page,
    UPDATED_DESC_PAGE_1,
    "S003 page 1 updated-desc content (reversed vs S002)",
    SORT_SLICE,
  );
  await expectRefsAbsent(
    page,
    UPDATED_ASC_PAGE_1,
    "S003 updated-desc differs from updated-asc on page 1",
    SORT_SLICE,
  );

  // S004: click Next. Page 2 continues the updated-DESCENDING order (#304 then
  // #302), and NO page-1 cut reappears (ordering stable + dedupe holds across
  // the page boundary, the #556 cross-page invariant).
  await nextButton(page).click();
  await expect(
    indicator(page),
    `S004 (TC-035, slice ${PAGE_SLICE}): after Next the indicator must read "Page 2", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 2");
  await expectRefsVisible(
    page,
    UPDATED_DESC_PAGE_2,
    "S004 page 2 continues updated-desc order",
    PAGE_SLICE,
  );
  await expectRefsAbsent(
    page,
    UPDATED_DESC_PAGE_1,
    "S004 no page-1 cut reappears on page 2 (dedupe / stable ordering across the boundary)",
    PAGE_SLICE,
  );
});
