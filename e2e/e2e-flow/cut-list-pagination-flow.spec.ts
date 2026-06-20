import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";

// #569: the integration-level drift guard for the US-003/US-004 journey "page
// through the cut list and reset to page 1 on sort change". It spans the
// pagination slice #556 and the sort-picker slice #584 and asserts the
// integrated journey against the authoritative e2e_flow case CLI-TC-032, not
// whatever any single slice implemented.
//
// TC-032 (reconciled to the shipped contract by #584):
//
//   1. S001-O01 "Page 1 of N". The shipped pager
//      (client/src/components/IssueQueuePanel.tsx, testid
//      `cut-list-page-indicator`) renders `Page {n} · {count} item(s)` with NO
//      total N: cursors are forward-only (PaginatedIssues exposes nextCursor
//      only) and numbered-page jumps is a PRD non-goal, so a total page count
//      is unknowable. We assert the shipped "Page 1" / "Page 2" / "Page 3"
//      tracking, not "of N" (test-cases.json S001-O01 was updated to match).
//
//   2. S004 sort picker. #584 shipped the host-rendered sort picker
//      (CutListSortControl, populated from the plugin's `getSortFields`) and the
//      source-side sort RPC. We drive the FR-008 reset-to-page-1 invariant via
//      the real picker (the scenario's stub declares a `Title` sort field that
//      defaults to descending), and assert BOTH faithful behaviours: paging
//      resets to page 1 with Prev disabled AND the list reorders by the new
//      field (page 1 now shows the title-descending cuts, not the natural-order
//      page-1 cuts).
//
// FR-020 failure-output contract: every assertion below carries a descriptive
// message naming the diverging e2e_flow step, the expected-vs-actual, and the
// owning slice issue (#556 for paging, #584 for sort), so a regression points
// straight at the step and the slice that broke it.
//
// The fixture project (e2e/fixtures/cut-list-pagination-project) pins
// `integration.pageSize: 2`, and the scenario seeds six To Do cuts, so the cut
// list spans three Prev/Next pages and cursor retention is genuinely
// exercised. The stub's `listIssues` (e2e/fixtures/stubbed-plugin/src/
// contract.ts) pages the kept set by the host-supplied cursor + pageSize.

const SCENARIO = "cut-list-pagination";
const NOW = "2026-05-21T13:00:00.000Z";
const OWNING_SLICE = "#556";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(__dirname, "..", "fixtures", "cut-list-pagination-project");
const PROJECT_ID = "e2e-cut-list-pagination";

// Page 1/2/3 cuts at pageSize 2. The scenario's six To Do cuts page in stable
// externalId order, so the page-to-refs mapping is deterministic.
const PAGE_1_REFS = ["#201", "#202"] as const;
const PAGE_2_REFS = ["#203", "#204"] as const;
const PAGE_3_REFS = ["#205", "#206"] as const;

async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register cut-list-pagination fixture project").toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(PROJECT_ID);
}

// Title-descending page-1 cuts (#584). The scenario's six cuts sort by title:
// Alpha (#201/#202), Bravo (#203/#204), Charlie (#206 "fit" < #205 "wax").
// Descending reverses that, so page 1 at pageSize 2 is #205 then #206.
const SORT_DESC_PAGE_1_REFS = ["#205", "#206"] as const;

const indicator = (page: Page) => page.getByTestId("cut-list-page-indicator");
const prevButton = (page: Page) => page.getByRole("button", { name: "Previous page" });
const nextButton = (page: Page) => page.getByRole("button", { name: "Next page" });
const sortButton = (page: Page) => page.getByRole("button", { name: "Sort cut list" });

async function expectRefsVisible(page: Page, refs: readonly string[], step: string): Promise<void> {
  for (const ref of refs) {
    await expect(
      page.getByText(ref, { exact: true }),
      `${step} (TC-032, slice ${OWNING_SLICE}): expected cut ${ref} on this page`,
    ).toBeVisible();
  }
}

async function expectRefsAbsent(page: Page, refs: readonly string[], step: string): Promise<void> {
  for (const ref of refs) {
    await expect(
      page.getByText(ref, { exact: true }),
      `${step} (TC-032, slice ${OWNING_SLICE}): cut ${ref} should not be on this page`,
    ).toHaveCount(0);
  }
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
  await registerProject(request);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
});

test("TC-032: page through the cut list and reset to page 1 on a sort change", async ({ page }) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  // S001: a cached list of at least three pages. Page 1 shows the first page of
  // cuts, the page indicator tracks "Page 1", Prev is disabled and Next enabled.
  // (The shipped pager has no total N, so we assert the shipped "Page 1"
  // tracking; test-cases.json S001-O01 was reconciled to match by #584.)
  await expectRefsVisible(page, PAGE_1_REFS, "S001 page 1 content");
  await expectRefsAbsent(page, PAGE_2_REFS, "S001 page 1 excludes page 2");
  await expect(
    indicator(page),
    `S001 (TC-032, slice ${OWNING_SLICE}): expected the page indicator to read "Page 1", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 1");
  await expect(
    prevButton(page),
    `S001 (TC-032, slice ${OWNING_SLICE}): Prev must be disabled on page 1 (no prior page)`,
  ).toBeDisabled();
  await expect(
    nextButton(page),
    `S001 (TC-032, slice ${OWNING_SLICE}): Next must be enabled on page 1 (more pages remain)`,
  ).toBeEnabled();

  // S002: Next advances to page 2. The indicator tracks "Page 2", Prev becomes
  // enabled, and page-2 cuts differ from page-1 cuts.
  await nextButton(page).click();
  await expect(
    indicator(page),
    `S002 (TC-032, slice ${OWNING_SLICE}): after one Next the indicator must read "Page 2", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 2");
  await expectRefsVisible(page, PAGE_2_REFS, "S002 page 2 content");
  await expectRefsAbsent(page, PAGE_1_REFS, "S002 page 2 differs from page 1");
  await expect(
    prevButton(page),
    `S002 (TC-032, slice ${OWNING_SLICE}): Prev must be enabled on page 2`,
  ).toBeEnabled();

  // S003: Next advances to page 3 (its own cuts, Next now disabled as it is the
  // last page), then Prev replays the retained cursor for page 2 and shows the
  // SAME cuts seen on the forward pass (cursor retention, NFR-004).
  await nextButton(page).click();
  await expect(
    indicator(page),
    `S003 (TC-032, slice ${OWNING_SLICE}): after a second Next the indicator must read "Page 3", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 3");
  await expectRefsVisible(page, PAGE_3_REFS, "S003 page 3 content");
  await expectRefsAbsent(page, PAGE_2_REFS, "S003 page 3 differs from page 2");
  await expect(
    nextButton(page),
    `S003 (TC-032, slice ${OWNING_SLICE}): Next must be disabled on the last page (page 3)`,
  ).toBeDisabled();

  await prevButton(page).click();
  await expect(
    indicator(page),
    `S003 (TC-032, slice ${OWNING_SLICE}): Prev from page 3 must return to "Page 2", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 2");
  await expectRefsVisible(page, PAGE_2_REFS, "S003 Prev replays the retained page-2 cursor");
  await expectRefsAbsent(page, PAGE_3_REFS, "S003 page 2 differs from page 3 after Prev");

  // S004 (#584): change the sort field via the real sort picker. Advance to
  // page 3 first so the reset is observable as a jump back, then open the
  // picker and select the stub's `Title` field (it defaults to descending).
  // TC-032 S004 asserts BOTH faithful behaviours: paging resets to page 1 with
  // Prev disabled (CLI-FR-008), AND the items reorder by the new field
  // (CLI-FR-010): page 1 now shows the title-descending cuts (#205/#206), not
  // the natural-order page-1 cuts (#201/#202).
  const SORT_SLICE = "#584";
  await nextButton(page).click();
  await expect(
    indicator(page),
    `S004 setup (TC-032, slice ${SORT_SLICE}): expected to be on "Page 3" before the sort change, got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 3");

  await sortButton(page).click();
  await page.getByRole("option", { name: "Title" }).click();

  await expect(
    indicator(page),
    `S004 (TC-032, slice ${SORT_SLICE}): a sort-field change must reset paging to "Page 1", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 1");
  await expect(
    prevButton(page),
    `S004 (TC-032, slice ${SORT_SLICE}): Prev must be disabled after the reset to page 1`,
  ).toBeDisabled();
  // The items reordered by the new sort field: page 1 now shows the
  // title-descending cuts (#205/#206) and the original natural-order page-1
  // cuts (#201/#202) are gone.
  await expectRefsVisible(page, SORT_DESC_PAGE_1_REFS, "S004 sort reorders page 1 by title desc");
  await expectRefsAbsent(
    page,
    PAGE_1_REFS,
    "S004 sort moved the natural-order page-1 cuts off page 1",
  );
});
