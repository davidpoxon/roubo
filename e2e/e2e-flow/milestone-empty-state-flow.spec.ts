import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";

// roubo-development#425: the integration-level drift guard for CLI-TC-065, the
// exhausted-milestone empty state. It closes the S001-O03 fixture gap the
// cut-list-improvements verification run (test-results.json, PR #421) recorded
// as a fail: no stub scenario offered a still-live milestone whose To Do issues
// were all exhausted server-wide, so the "pager hidden" expectation could not be
// driven and the run approximated it with a zero-match search where hasNext
// stayed true and the pager stayed visible.
//
// The shipped pager (client/src/components/IssueQueuePanel.tsx) hides only when
// `filteredItems.length === 0 && !hasPrev && !hasNext`: a single server page (no
// next cursor) on page 1 with the selected milestone matching nothing loaded.
// When the current page's items are all filtered out client-side but another
// page exists (hasNext) or we paged in from a prior page (hasPrev), the pager is
// deliberately retained so Next/Prev stay reachable, which is why the multi-page
// cut-list-milestone-project (pageSize 2, five To Do issues) cannot exercise the
// hide. This spec runs against a SEPARATE single-page fixture instead.
//
// TC-065 reconciliations (mirroring how #572 reconciled CLI-TC-059 and #584
// reconciled CLI-TC-032 to the shipped signals). Two literal step texts in
// test-cases.json describe behaviour the shipped UI does not emit; this spec
// asserts the shipped observable signals instead, and test-cases.json was
// updated to match:
//
//   1. S001-O01 "The empty state is shown ('No To Do items match the current
//      filters')". The shipped empty state copy (IssueQueuePanel.tsx) is "No
//      cuts match the active filters" when items are loaded but the active
//      filter matches none. We assert that shipped copy (S001-O01 was reworded
//      to match).
//
//   2. S002 "Clear the milestone filter (select 'All milestones')". The shipped
//      filter popover (client/src/components/CutListFilterBar.tsx) has NO in-list
//      "All milestones" option. Clearing a facet is a dedicated affordance: the
//      per-facet `Clear {facet} filter` button (aria-label "Clear Milestone
//      filter"). We clear via that shipped button and assert the full To Do list
//      returns (S002 was reworded to match).
//
// Every assertion below carries a descriptive message naming the diverging
// TC-065 step, the expected-vs-actual, and the owning follow-up
// (roubo-development#425), so a regression points straight at the step that
// broke it.
//
// Mechanics. Milestone options in the dropdown come from the plugin's
// `getFacetOptions` (the scenario's `facetOptions.milestone`: the live sprint
// AND the exhausted "Hardening 1.0 (active)" milestone, which is still offered).
// Issue filtering matches each issue's `facetValues.milestone` client-side over
// the loaded page. The Hardening milestone's issues are all `statusCategory:
// "Done"`, which the stub excludes server-side under the manifest's [Done]
// default, so they never reach the loaded page: selecting Hardening filters the
// loaded To Do items to zero. The fixture project
// (e2e/fixtures/cut-list-milestone-empty-project) pins `integration.pageSize:
// 10` against two To Do issues, so the To Do list is provably one page
// (nextCursor null, hasNext=false) and, on page 1 (hasPrev=false), the pager
// genuinely hides once filteredItems drops to zero.

const SCENARIO = "cut-list-milestone-empty";
const NOW = "2026-05-21T13:00:00.000Z";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(__dirname, "..", "fixtures", "cut-list-milestone-empty-project");
const PROJECT_ID = "e2e-cut-list-milestone-empty";

// The still-offered but exhausted milestone (all its issues are Done, so they
// are excluded server-side and it matches zero loaded To Do items). Its live
// sibling "Sprint 30 (active)" backs the two To Do issues asserted by ref below.
const EMPTY_MILESTONE = "Hardening 1.0 (active)";

// The two To Do issues, both under the live sprint. They page in stable
// externalId order and fit one page at pageSize 10, so this is deterministic.
const TODO_REF_1 = "#401";
const TODO_REF_2 = "#402";

// The shipped empty-state copy (IssueQueuePanel.tsx) when items are loaded but
// the active filter matches none.
const EMPTY_STATE_COPY = "No cuts match the active filters";

// The owning follow-up for the failure-output contract.
const OWNING_ISSUE = "roubo-development#425";

const filterButton = (page: Page) => page.getByRole("button", { name: /^Filter cut list/ });
const popover = (page: Page) => page.getByRole("dialog");
const pager = (page: Page) => page.getByTestId("cut-list-pager");

async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register cut-list-milestone-empty fixture project").toBe(201);
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

test("TC-065: selecting a still-offered milestone with zero To Do items shows the empty state and hides the pager", async ({
  page,
}) => {
  await loadAppShell(page);

  // The cut list prefetches enum-async facet options on load, so watch for the
  // milestone facet-options request from the moment we navigate to the project.
  const facetOptionsResponse = page.waitForResponse(
    (resp) =>
      resp
        .url()
        .includes(`/api/projects/${PROJECT_ID}/integration/facet-options?facetId=milestone`) &&
      resp.status() === 200,
  );

  await page.goto(`/projects/${PROJECT_ID}`);

  // Precondition: the cut list is open showing the two To Do issues (both under
  // the live sprint), and the pager is present (single page, but rendered
  // because there are items). The pager going from present here to hidden after
  // the selection is what makes S001-O03 meaningful.
  await expect(
    page.getByText(TODO_REF_1, { exact: true }),
    `TC-065 precondition (${OWNING_ISSUE}): expected To Do issue ${TODO_REF_1} in the loaded cut list`,
  ).toBeVisible();
  await expect(
    page.getByText(TODO_REF_2, { exact: true }),
    `TC-065 precondition (${OWNING_ISSUE}): expected To Do issue ${TODO_REF_2} in the loaded cut list`,
  ).toBeVisible();
  await expect(
    pager(page),
    `TC-065 precondition (${OWNING_ISSUE}): the pager should be present while To Do items are loaded, so its later hide is observable`,
  ).toHaveCount(1);

  await facetOptionsResponse;

  // S001: open the filter popover and select the still-offered but exhausted
  // "Hardening 1.0 (active)" milestone. Keep the popover open: every S001
  // assertion is a DOM text / visibility / count check that an overlaying
  // popover does not affect, and the S002 clear button lives inside it.
  await filterButton(page).click();
  await expect(
    popover(page).getByText("Milestone", { exact: true }),
    `S001 (TC-065, ${OWNING_ISSUE}): expected the Milestone facet section in the filter popover`,
  ).toBeVisible();
  await expect(
    popover(page).getByRole("option", { name: EMPTY_MILESTONE }),
    `S001 (TC-065, ${OWNING_ISSUE}): the exhausted milestone "${EMPTY_MILESTONE}" must still be offered in the dropdown (CLI-FR-015: it is a live value)`,
  ).toBeVisible();
  await popover(page).getByRole("option", { name: EMPTY_MILESTONE }).click();

  // S001-O01 (reconciled): the shipped empty state is shown. The literal TC-065
  // copy "No To Do items match the current filters" is not a shipped string; the
  // shipped copy is "No cuts match the active filters" (see the header
  // reconciliation).
  await expect(
    page.getByText(EMPTY_STATE_COPY, { exact: true }),
    `S001-O01 (TC-065, ${OWNING_ISSUE}): selecting "${EMPTY_MILESTONE}" (zero To Do items) must show the shipped empty state "${EMPTY_STATE_COPY}", not a crash or a removed chip`,
  ).toBeVisible();
  // The previously-visible To Do issues are filtered out.
  await expect(
    page.getByText(TODO_REF_1, { exact: true }),
    `S001-O01 (TC-065, ${OWNING_ISSUE}): To Do issue ${TODO_REF_1} must be filtered out when "${EMPTY_MILESTONE}" is selected`,
  ).toHaveCount(0);

  // S001-O02: the Milestone chip still shows the active state, so the user
  // understands a filter is applied even though the list is empty. The shipped
  // filter trigger relabels to "Filter cut list, N active" with an active-count
  // badge.
  await expect(
    page.getByRole("button", { name: "Filter cut list, 1 active" }),
    `S001-O02 (TC-065, ${OWNING_ISSUE}): the filter chip must still show the active state (one active facet) while "${EMPTY_MILESTONE}" is selected and the list is empty`,
  ).toBeVisible();

  // S001-O03: the pagination footer is hidden. With a single server page
  // (hasNext=false) on page 1 (hasPrev=false) and zero filtered items, the pager
  // is not rendered at all. This is the assertion the missing fixture blocked.
  await expect(
    pager(page),
    `S001-O03 (TC-065, ${OWNING_ISSUE}): the pager must be hidden when the selected milestone has zero To Do items on a single server page (filteredItems=0, hasPrev=false, hasNext=false)`,
  ).toHaveCount(0);

  // S002 (reconciled): clear the milestone filter via the SHIPPED clear
  // affordance (the `Clear Milestone filter` button in the still-open popover),
  // NOT an in-list "All milestones" option (which the shipped UI does not have).
  await popover(page).getByRole("button", { name: "Clear Milestone filter" }).click();

  // S002-O01: the empty state is replaced by the full To Do list.
  await expect(
    page.getByText(TODO_REF_1, { exact: true }),
    `S002-O01 (TC-065, ${OWNING_ISSUE}): expected ${TODO_REF_1} back in the full To Do list after clearing the "${EMPTY_MILESTONE}" filter`,
  ).toBeVisible();
  await expect(
    page.getByText(TODO_REF_2, { exact: true }),
    `S002-O01 (TC-065, ${OWNING_ISSUE}): expected ${TODO_REF_2} back in the full To Do list after clearing the "${EMPTY_MILESTONE}" filter`,
  ).toBeVisible();
  await expect(
    page.getByText(EMPTY_STATE_COPY, { exact: true }),
    `S002-O01 (TC-065, ${OWNING_ISSUE}): the empty state "${EMPTY_STATE_COPY}" must be gone once the filter is cleared and the full To Do list returns`,
  ).toHaveCount(0);
  // The chip returns to its default (no-active-selection) state.
  await expect(
    page.getByRole("button", { name: "Filter cut list", exact: true }),
    `S002-O01 (TC-065, ${OWNING_ISSUE}): expected the filter chip to reset to its default state (no active facet) after clearing`,
  ).toBeVisible();
});
