import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";

// #572: the integration-level drift guard for the US-006 journey "milestone
// filter offers only live values and filters the list". It spans the slices
// #555 (source-side facet-value exclusion / FR-015), #556 (cursor pagination /
// FR-008), and #565 (the milestone filter affordance / FR-008), and asserts the
// integrated journey against the authoritative e2e_flow case CLI-TC-059, not
// whatever any single slice implemented.
//
// TC-059 reconciliations (mirroring how #584 reconciled CLI-TC-032 S001-O01 to
// the shipped pager contract). Two literal step texts in test-cases.json
// describe behaviour the shipped UI does not emit; this spec asserts the
// shipped observable signals instead, and test-cases.json was updated to match:
//
//   1. S003 "select 'All milestones'". The shipped filter popover
//      (client/src/components/CutListFilterBar.tsx) has NO in-list "All
//      milestones" option. Clearing a facet is a dedicated affordance: the
//      per-facet `Clear {facet} filter` button (aria-label "Clear Milestone
//      filter") or the popover-level "Clear all" button. We clear via the
//      shipped `Clear Milestone filter` button and assert the full To Do list
//      returns and the chip resets (S003-O01 was reworded to match).
//
//   2. S002-O03 "...and a 'Filtered to milestone ...' announcement is made".
//      There is no shipped milestone-specific live-region announcement; the
//      only cut-list live region (`cut-list-page-live`, IssueQueuePanel.tsx)
//      announces paging ("Page 1"). Adding a milestone announcement would be
//      new slice behaviour, which is out of scope for this drift guard. We
//      assert the shipped observable signal for S002-O03 (pagination resets to
//      "Page 1" with Prev disabled) and drop the announcement clause (S002-O03
//      was reworded to match).
//
// FR-020 failure-output contract: every assertion below carries a descriptive
// message naming the diverging e2e_flow step, TC-059, the expected-vs-actual,
// and the owning slice issue(s) (#555 for only-live facet values, #556 for the
// page-1 reset, #565 for the milestone filter), so a regression points straight
// at the step and the slice that broke it.
//
// Mechanics. Milestone options in the dropdown come from the plugin's
// `getFacetOptions` (the scenario's `facetOptions.milestone`, only the two live
// sprints); issue filtering matches each issue's `facetValues.milestone`
// client-side over the loaded page. The fixture project
// (e2e/fixtures/cut-list-milestone-project) pins `integration.pageSize: 2`, and
// the scenario seeds five To Do issues, so the To Do list spans three Prev/Next
// pages and the page-1 reset on a milestone select is observable as a jump
// back. The closed sprint name ("Sprint 23 (closed)") is present in issue data
// (#305's `facetValues.milestone`) but deliberately omitted from
// `facetOptions.milestone`, so the dropdown provably never offers it (FR-015).

const SCENARIO = "cut-list-milestone-filter";
const NOW = "2026-05-21T13:00:00.000Z";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(__dirname, "..", "fixtures", "cut-list-milestone-project");
const PROJECT_ID = "e2e-cut-list-milestone";

// The two live sprints offered by the dropdown, and the closed sprint that is
// in issue data but never offered.
const LIVE_SPRINT_24 = "Sprint 24 (active)";
const LIVE_SPRINT_25 = "Sprint 25 (planned)";
const CLOSED_SPRINT = "Sprint 23 (closed)";

// Page 1 at pageSize 2: #301 (Sprint 24), #302 (Sprint 25). The five To Do
// issues page in stable externalId order, so this mapping is deterministic.
const PAGE_1_SPRINT_24_REF = "#301";
const PAGE_1_SPRINT_25_REF = "#302";
// Page 2 at pageSize 2: #303 (Sprint 24), #304 (Sprint 25).
const PAGE_2_REFS = ["#303", "#304"] as const;

// Owning slices for the FR-020 failure-output contract.
const SLICE_ONLY_LIVE = "#555";
const SLICE_PAGING = "#556";
const SLICE_FILTER = "#565";

const filterButton = (page: Page) => page.getByRole("button", { name: /^Filter cut list/ });
const popover = (page: Page) => page.getByRole("dialog");
const indicator = (page: Page) => page.getByTestId("cut-list-page-indicator");
const prevButton = (page: Page) => page.getByRole("button", { name: "Previous page" });
const nextButton = (page: Page) => page.getByRole("button", { name: "Next page" });

// Close the filter popover with Escape. A single Escape can be swallowed by an
// inner ListBox once a facet option holds focus (the first press clears the
// listbox context, the next closes the overlay), and re-clicking the trigger is
// blocked by React Aria's full-viewport dismiss underlay. So press Escape and
// poll, pressing again until the dialog is gone. The popover overlays the pager,
// so we close it before any pager click.
async function closeFilterPopover(page: Page, step: string): Promise<void> {
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0, { timeout: 1_000 });
  }).toPass({
    timeout: 5_000,
  });
  await expect(
    popover(page),
    `${step} (TC-059, slice ${SLICE_FILTER}): the filter popover should close`,
  ).toHaveCount(0);
}

async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register cut-list-milestone fixture project").toBe(201);
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

test("TC-059: milestone filter offers only live values, filters the list, and resets to page 1", async ({
  page,
}) => {
  await loadAppShell(page);

  // The cut-list prefetches enum-async facet options on load, so watch for the
  // milestone facet-options request from the moment we navigate to the project.
  const facetOptionsResponse = page.waitForResponse(
    (resp) =>
      resp
        .url()
        .includes(`/api/projects/${PROJECT_ID}/integration/facet-options?facetId=milestone`) &&
      resp.status() === 200,
  );

  await page.goto(`/projects/${PROJECT_ID}`);

  // Precondition: the cut list is open showing To Do items. Page 1 shows the
  // first two To Do issues.
  await expect(
    page.getByText(PAGE_1_SPRINT_24_REF, { exact: true }),
    `TC-059 precondition (slice ${SLICE_FILTER}): expected To Do issue ${PAGE_1_SPRINT_24_REF} on page 1`,
  ).toBeVisible();
  await expect(
    page.getByText(PAGE_1_SPRINT_25_REF, { exact: true }),
    `TC-059 precondition (slice ${SLICE_FILTER}): expected To Do issue ${PAGE_1_SPRINT_25_REF} on page 1`,
  ).toBeVisible();

  await facetOptionsResponse;

  // S001 (AC1): open the filter popover and assert the Milestone dropdown lists
  // only the live sprints; the closed sprint name appears zero times (only-live
  // values, the FR-015 drift guard owned by slice #555).
  await filterButton(page).click();
  // Scope to the popover dialog so the "Milestone" header isn't confused with
  // any issue text in the cut list.
  await expect(
    popover(page).getByText("Milestone", { exact: true }),
    `S001 (TC-059, slice ${SLICE_FILTER}): expected the Milestone facet section in the filter popover`,
  ).toBeVisible();

  await expect(
    popover(page).getByRole("option", { name: LIVE_SPRINT_24 }),
    `S001-O01 (TC-059, slice ${SLICE_ONLY_LIVE}): expected the live milestone "${LIVE_SPRINT_24}" to be offered in the dropdown`,
  ).toBeVisible();
  await expect(
    popover(page).getByRole("option", { name: LIVE_SPRINT_25 }),
    `S001-O01 (TC-059, slice ${SLICE_ONLY_LIVE}): expected the live milestone "${LIVE_SPRINT_25}" to be offered in the dropdown`,
  ).toBeVisible();
  await expect(
    popover(page).getByRole("option", { name: CLOSED_SPRINT }),
    `S001-O01 (TC-059, slice ${SLICE_ONLY_LIVE}): the closed milestone "${CLOSED_SPRINT}" must never be offered (FR-015 only-live values); expected count 0`,
  ).toHaveCount(0);

  // Close the popover before paging so it does not overlay the pager controls.
  await closeFilterPopover(page, "S001");

  // S002 (AC2): FIRST advance to page 2 (so the page-1 reset is observable as a
  // jump back), THEN select "Sprint 24 (active)".
  await nextButton(page).click();
  await expect(
    indicator(page),
    `S002 setup (TC-059, slice ${SLICE_PAGING}): expected to be on "Page 2" before selecting the milestone, got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 2");
  for (const ref of PAGE_2_REFS) {
    await expect(
      page.getByText(ref, { exact: true }),
      `S002 setup (TC-059, slice ${SLICE_PAGING}): expected page-2 issue ${ref} before selecting the milestone`,
    ).toBeVisible();
  }

  await filterButton(page).click();
  // Select the live sprint and keep the popover open: an Escape close would be
  // swallowed by (or clear the selection in) the single-select ListBox. Every
  // S002 assertion below is a DOM text / property / visibility check that an
  // overlaying popover does not affect, so closing first is unnecessary.
  await popover(page).getByRole("option", { name: LIVE_SPRINT_24 }).click();

  // S002-O01: the Milestone chip shows the selected/active state. The shipped
  // filter trigger relabels to "Filter cut list, N active" and renders an active
  // count badge when a facet selection is active.
  await expect(
    page.getByRole("button", { name: "Filter cut list, 1 active" }),
    `S002-O01 (TC-059, slice ${SLICE_FILTER}): expected the filter chip to show the selected/active state (one active facet) after selecting "${LIVE_SPRINT_24}"`,
  ).toBeVisible();

  // S002-O02: the list filters to "Sprint 24 (active)" issues only. After the
  // page-1 reset the loaded page is page 1 (#301 Sprint 24, #302 Sprint 25); the
  // Sprint 24 issue stays and the Sprint 25 issue is filtered out.
  await expect(
    page.getByText(PAGE_1_SPRINT_24_REF, { exact: true }),
    `S002-O02 (TC-059, slice ${SLICE_FILTER}): expected the "${LIVE_SPRINT_24}" issue ${PAGE_1_SPRINT_24_REF} to remain after filtering`,
  ).toBeVisible();
  await expect(
    page.getByText(PAGE_1_SPRINT_25_REF, { exact: true }),
    `S002-O02 (TC-059, slice ${SLICE_FILTER}): the "${LIVE_SPRINT_25}" issue ${PAGE_1_SPRINT_25_REF} must be filtered out when "${LIVE_SPRINT_24}" is selected`,
  ).toHaveCount(0);

  // S002-O03 (reconciled): pagination resets to page 1 with Prev disabled. (The
  // literal TC-059 "Filtered to milestone ..." live-region announcement is not a
  // shipped signal; see the header reconciliation. The shipped observable is the
  // FR-008 page-1 reset, owned by slice #556.)
  await expect(
    indicator(page),
    `S002-O03 (TC-059, slice ${SLICE_PAGING}): a milestone selection must reset paging to "Page 1", got "${await indicator(page).textContent()}"`,
  ).toContainText("Page 1");
  await expect(
    prevButton(page),
    `S002-O03 (TC-059, slice ${SLICE_PAGING}): Prev must be disabled after the reset to page 1`,
  ).toBeDisabled();

  // S003 (AC3): clear the milestone filter via the SHIPPED clear affordance (the
  // `Clear Milestone filter` button), NOT an in-list "All milestones" option;
  // assert the full To Do list returns and the chip resets. The popover is still
  // open from S002, so the clear button is reachable without re-opening it.
  await popover(page).getByRole("button", { name: "Clear Milestone filter" }).click();

  // S003-O01: the filter clears and the full To Do list (page 1) is shown again,
  // including the previously-filtered "Sprint 25 (planned)" issue.
  await expect(
    page.getByText(PAGE_1_SPRINT_24_REF, { exact: true }),
    `S003-O01 (TC-059, slice ${SLICE_FILTER}): expected ${PAGE_1_SPRINT_24_REF} back in the full To Do list after clearing the filter`,
  ).toBeVisible();
  await expect(
    page.getByText(PAGE_1_SPRINT_25_REF, { exact: true }),
    `S003-O01 (TC-059, slice ${SLICE_FILTER}): expected the previously-filtered ${PAGE_1_SPRINT_25_REF} back in the full To Do list after clearing the filter`,
  ).toBeVisible();

  // S003-O01: the chip returns to its default (no-active-selection) state.
  await expect(
    page.getByRole("button", { name: "Filter cut list", exact: true }),
    `S003-O01 (TC-059, slice ${SLICE_FILTER}): expected the filter chip to reset to its default state (no active facet) after clearing`,
  ).toBeVisible();
});
