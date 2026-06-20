import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";

// #569: the integration-level drift guard for the US-003 journey "page through
// the cut list and reset to page 1 on sort change". It spans the pagination
// slice #556 and asserts the integrated journey against the authoritative
// e2e_flow case CLI-TC-032, not whatever any single slice implemented.
//
// TC-032 DIVERGENCES (decided: adapt to the shipped contract, tracked by #584):
//
//   1. S001-O01 "Page 1 of N". The shipped pager
//      (client/src/components/IssueQueuePanel.tsx, testid
//      `cut-list-page-indicator`) renders `Page {n} · {count} item(s)` with NO
//      total N: cursors are forward-only (PaginatedIssues exposes nextCursor
//      only) and numbered-page jumps is a PRD non-goal, so a total page count
//      is unknowable. We assert the shipped "Page 1" / "Page 2" / "Page 3"
//      tracking, not "of N". Reconciling TC-032's wording is deferred to #584.
//
//   2. S004 sort picker. There is no sort picker in the client and no sort RPC
//      (FR-009/FR-010/US-004 are unbuilt). We drive the FR-008 reset-to-page-1
//      invariant via a SHIPPED query-input change (the cut-list search filter)
//      as a stand-in for the sort trigger: any change to the paging signature
//      (project / filters / grouping) resets to page 1 and discards forward
//      cursor history. We assert reset to page 1 + Prev disabled + the list
//      content changes. We do NOT assert "items reorder by sort field" (not
//      observable without a sort); that is deferred to #584.
//
// FR-020 failure-output contract: every assertion below carries a descriptive
// message naming the diverging e2e_flow step, the expected-vs-actual, and the
// owning slice issue #556, so a regression points straight at the step and the
// slice that broke it.
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

const indicator = (page: Page) => page.getByTestId("cut-list-page-indicator");
const prevButton = (page: Page) => page.getByRole("button", { name: "Previous page" });
const nextButton = (page: Page) => page.getByRole("button", { name: "Next page" });

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

test("TC-032: page through the cut list and reset to page 1 on a query-input change", async ({
  page,
}) => {
  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  // S001: a cached list of at least three pages. Page 1 shows the first page of
  // cuts, the page indicator tracks "Page 1", Prev is disabled and Next enabled.
  // (TC-032 S001-O01 says "Page 1 of N"; the shipped pager has no total N, so we
  // assert the shipped "Page 1" tracking instead. Divergence tracked by #584.)
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

  // S004 (adapted): a query-input change resets paging to page 1. TC-032 drives
  // this with a sort-field change; there is no sort picker in the shipped client
  // (divergence tracked by #584), so we drive the same FR-008 reset invariant
  // via the shipped cut-list search filter. Advance to page 3 first so the reset
  // is observable as a jump back, then type a search term matching only a page-1
  // cut. The paging signature changes, paging resets to page 1, and the visible
  // list content changes (now the filtered page-1 cut, not the page-3 cuts).
  await nextButton(page).click();
  await expect(
    indicator(page),
    `S004 setup (TC-032, slice ${OWNING_SLICE}): expected to be on "Page 3" before the reset, got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 3");

  await page.getByRole("textbox", { name: "Search cuts by title or number" }).fill("Alpha");

  await expect(
    indicator(page),
    `S004 (TC-032, slice ${OWNING_SLICE}): a query-input change (the sort-picker stand-in) must reset paging to "Page 1", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 1");
  await expect(
    prevButton(page),
    `S004 (TC-032, slice ${OWNING_SLICE}): Prev must be disabled after the reset to page 1`,
  ).toBeDisabled();
  // The list content changed: the page-1 "Alpha" cut is now visible and the
  // page-3 cuts are gone. (TC-032 also expects "items reorder by sort field";
  // that is not observable without a sort and is deferred to #584.)
  await expectRefsVisible(page, ["#201"], "S004 reset shows filtered page-1 content");
  await expectRefsAbsent(page, PAGE_3_REFS, "S004 reset cleared the page-3 cuts");
});
