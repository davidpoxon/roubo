import { expect, test, type Locator, type Page } from "@playwright/test";
import { registerTestProject } from "../project-settings/_support/test-project.js";
import { openConfigureDialog, save } from "./_support/picker.js";
import { loadAppShell, resetWithScenario } from "./_support/scenario.js";

// #573: the integration-level drift guard for the US-007 journey "per-project
// sort and status tunables persist and are plugin-scoped". This unit spans the
// slices #558 (status-category exclusion + only-to-do) and #566 (per-project
// sort + status persistence, validated against the active plugin) and asserts
// the integrated journey against the authoritative e2e_flow case CLI-TC-062,
// not whatever any single slice implemented.
//
// Traceability: implements CLI-FR-013 (status-category exclusion) and
// CLI-FR-017 (per-project persistence); verifies CLI-US-007 via CLI-TC-062.
// Blocked by #558 / #566 (both shipped; server-side persistence + validation
// landed in #637).
//
// TC-062 reconciled to the SHIPPED contract. Several of TC-062's prose
// observations describe surfaces that were not built the way the prose reads;
// per the issue's "issue is the source of truth, note divergence where the TC
// prose is ambiguous" rule, this spec asserts the behaviour the components
// actually ship and records each divergence inline:
//
//   - S001 direction aria-label. TC-062 S001-O01 expects
//     "Sort direction: descending". The shipped CutListSortControl
//     (client/src/components/CutListSortControl.tsx) emits a single combined
//     trigger aria-label "Sort cut list by <label>, <dir>ending", so we assert
//     "Sort cut list by Backlog rank, descending" / "..., ascending" (the real
//     shipped strings).
//
//   - S002 "Status filter saved" announcement. No such announcement string
//     exists. Status-category exclusion is configured through the Configure
//     dialog (PluginConfigureDialog status-exclusion section, #558/#435), and
//     the observable signal that the filter applied is the cut list dropping
//     the excluded issue plus the "N filtered out by status" preview note
//     (testid `excluded-count-note`). We assert those instead of a phantom
//     announcement.
//
//   - S003 picker hydration. TC-062 S003-O01 expects the sort PICKER to still
//     read "Backlog rank descending" after navigating away and back. The
//     shipped picker holds its selection in ephemeral component state (its
//     initial selection is always null) and does not hydrate from the persisted
//     per-project sort. The persistence that actually shipped (#566/#637) lives
//     at the integration boundary: the plugin-validated persisted sort drives
//     GET /issues when no live sort is passed, and the persisted status
//     exclusion survives a fresh navigation. We assert persistence there (GET
//     /issues ordering + GET /issues/sort-fields), the genuine drift guard.
//
//   - S004 plugin-scoped offerings. In the e2e harness every bundled plugin id
//     (e2e-stub / jira-self-hosted / github-com) delegates to the SAME stubbed
//     plugin process and one scenario, so getSortFields returns the same
//     declared set for every plugin id. A genuinely DIFFERING field list across
//     two live plugins is therefore not demonstrable end to end (it is covered
//     at the unit layer by CLI-TC-070 in
//     server/services/plugin-activation.test.ts). What IS genuinely
//     demonstrable, and is the substance of CLI-FR-017's per-project scoping, is
//     that Project B (a different plugin id with its own override) reports its
//     own active plugin's sort fields and an independent status config:
//     excluding "In Progress" on Project A must not leak into Project B.
//
// FR-020 failure-output contract (every observation below): each assertion
// carries a message naming the diverging TC-062 step (S001-S004), the
// expected-vs-actual, and the owning slice issue(s) (#558 status exclusion,
// #566 persistence), so a regression points straight at the step and slice.

const SCENARIO = "cut-list-sort-status-tunables";
const NOW = "2026-06-20T13:00:00.000Z";

const PROJECT_A = "tc-062-project-a";
const PROJECT_B = "tc-062-project-b";

// Slice ownership per TC-062 step, surfaced in every FR-020 failure message.
const SORT_SLICE = "#566"; // per-project sort persistence + validation
const STATUS_SLICE = "#558"; // status-category exclusion

const INSTANCE = "https://jira.stub.example";

// shortIssueRef(externalId) renders the trailing "#NNN" on each cut card; the
// scenario's acme/widgets#30N issues surface as these refs.
const REF_NEWEST = "#302"; // To Do, updated 2026-06-10 (latest)
const REF_UNDERWAY = "#304"; // In Progress, updated 2026-06-08
const REF_EARLIEST = "#301"; // To Do, updated 2026-06-01 (earliest)
const REF_DONE = "#305"; // Done, excluded by the stub's default ["Done"]

const sortTrigger = (page: Page): Locator => page.getByRole("button", { name: /^Sort cut list/ });
const cardRef = (page: Page, ref: string): Locator => page.getByText(ref, { exact: true });

// Read the vertical position of a cut card's ref so two refs can be ordered
// without a "before"/"after" matcher. The frozen scenario + flat (un-grouped)
// list make the y-positions deterministic.
async function refY(page: Page, ref: string): Promise<number> {
  const box = await cardRef(page, ref).boundingBox();
  if (!box) throw new Error(`cut card ${ref} has no bounding box (not visible?)`);
  return box.y;
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/api/projects/${PROJECT_A}?force=true`);
  await request.delete(`/api/projects/${PROJECT_B}?force=true`);
});

test("TC-062: per-project sort and status tunables persist and are plugin-scoped", async ({
  page,
  request,
}) => {
  // Project A is pinned to the e2e-stub plugin (whose manifest declares the Done
  // category as the default exclusion and whose scenario declares the single
  // "Backlog rank" sort field), with the per-project sort persisted to its
  // override as backlog-rank descending. The persisted sort is what the picker
  // WOULD persist if it hydrated; seeding it through the override is the only
  // production write path for a per-project sort (no HTTP endpoint accepts a
  // picker sort), so this is how the system actually stores it. The instance
  // override makes the connection pill resolve connected so the cut list and the
  // Configure dialog render.
  await registerTestProject(request, {
    projectId: PROJECT_A,
    plugin: "e2e-stub",
    // `projectRepo` writes `project.repo` into the fixture roubo.yaml so the
    // BenchesTab `hasGitHub` gate is satisfied and the cut-list panel renders
    // (the stub ignores `sources`, so the value is only the render gate).
    projectRepo: "acme/widgets",
    integrationConfig: { instance: INSTANCE, sortBy: "updated", sortDir: "desc" },
  });

  await loadAppShell(page);
  await page.goto(`/projects/${PROJECT_A}`);

  // Baseline: the open To Do / In Progress cuts are present and the Done cut is
  // dropped by the stub's default ["Done"] exclusion. The persisted backlog-rank
  // descending sort drives the first load (no live picker selection yet), so the
  // newest cut #302 renders above the earliest cut #301.
  await expect(
    cardRef(page, REF_NEWEST),
    `S001 baseline (TC-062, slice ${SORT_SLICE}): expected the newest To Do cut ${REF_NEWEST} in the list`,
  ).toBeVisible();
  await expect(
    cardRef(page, REF_UNDERWAY),
    `S001 baseline (TC-062, slice ${STATUS_SLICE}): expected the In Progress cut ${REF_UNDERWAY} visible before any status exclusion`,
  ).toBeVisible();
  await expect(
    cardRef(page, REF_DONE),
    `S001 baseline (TC-062, slice ${STATUS_SLICE}): the Done-category cut ${REF_DONE} must be excluded by the plugin default`,
  ).toHaveCount(0);

  // ---- S001: select "Backlog rank" descending, then drive a live reorder ----
  // The field's defaultDir is "desc", so the first selection applies descending
  // (CLI-FR-010) and the trigger reflects it. Then re-selecting the active field
  // toggles direction to ascending: the live picker selection wins over the
  // persisted sort and the list genuinely reorders (earliest cut #301 to the
  // top), proving the picker drives the order end to end.
  // The popover stays open after a selection, so the direction toggle below
  // re-clicks the option in the same open listbox rather than reopening the
  // trigger (whose overlay would otherwise intercept the click).
  await sortTrigger(page).click();
  await page.getByRole("option", { name: "Backlog rank" }).click();

  // Divergence note (see header): TC-062 S001-O01 expects
  // "Sort direction: descending"; the shipped trigger emits the combined
  // "Sort cut list by Backlog rank, descending".
  await expect(
    page.getByRole("button", { name: "Sort cut list by Backlog rank, descending" }),
    `S001 (TC-062, slice ${SORT_SLICE}): after selecting "Backlog rank" the sort trigger aria-label must read "Sort cut list by Backlog rank, descending"`,
  ).toBeVisible();
  const descNewestY = await refY(page, REF_NEWEST);
  const descEarliestY = await refY(page, REF_EARLIEST);
  expect(
    descNewestY,
    `S001 (TC-062, slice ${SORT_SLICE}): backlog-rank descending must order the list newest-first, so ${REF_NEWEST} (06-10) should render above ${REF_EARLIEST} (06-01) (y ${descNewestY} < ${descEarliestY})`,
  ).toBeLessThan(descEarliestY);

  // Re-select the active field (popover still open) to toggle the direction to
  // ascending; the list reorders oldest-first under the live selection.
  await page.getByRole("option", { name: "Backlog rank" }).click();
  await expect(
    page.getByRole("button", { name: "Sort cut list by Backlog rank, ascending" }),
    `S001 (TC-062, slice ${SORT_SLICE}): re-selecting "Backlog rank" must toggle the direction to ascending and the trigger aria-label must read "Sort cut list by Backlog rank, ascending"`,
  ).toBeVisible();
  const ascEarliestY = await refY(page, REF_EARLIEST);
  const ascNewestY = await refY(page, REF_NEWEST);
  expect(
    ascEarliestY,
    `S001 (TC-062, slice ${SORT_SLICE}): toggling to backlog-rank ascending must reorder the list oldest-first, so ${REF_EARLIEST} (06-01) should render above ${REF_NEWEST} (06-10) (y ${ascEarliestY} < ${ascNewestY})`,
  ).toBeLessThan(ascNewestY);

  // ---- S002: Configure, exclude "In Progress", Save ----
  // Divergence note (see header): there is no "Status filter saved"
  // announcement; the observable signal is the In Progress cut dropping out and
  // the "N filtered out by status" preview note climbing. Done stays excluded,
  // so excluding In Progress takes the count from 1 (Done) to 2 (Done +
  // In Progress).
  const configure = await openConfigureDialog(page, PROJECT_A, { waitForPicker: false });
  await expect(
    configure.dialog.getByTestId("status-exclusion-section"),
    `S002 (TC-062, slice ${STATUS_SLICE}): the Configure dialog must offer the status-category exclusion section for a plugin that declares default excluded categories`,
  ).toBeVisible();
  // force: React Aria renders the checkbox as a visually-hidden input wrapped in
  // a label, so the role element is not hit-testable; the native click still
  // fires its onChange (same pattern as the sibling cut-list / picker specs).
  await configure.dialog.getByRole("checkbox", { name: "In Progress" }).click({ force: true });
  await save(configure.dialog);

  await page.goto(`/projects/${PROJECT_A}`);
  await expect(
    cardRef(page, REF_EARLIEST),
    `S002 (TC-062, slice ${STATUS_SLICE}): To Do cuts must remain after excluding "In Progress" (${REF_EARLIEST} expected visible)`,
  ).toBeVisible();
  await expect(
    cardRef(page, REF_UNDERWAY),
    `S002 (TC-062, slice ${STATUS_SLICE}): excluding "In Progress" must drop the In Progress cut ${REF_UNDERWAY} from the list`,
  ).toHaveCount(0);
  await expect(
    page.getByTestId("excluded-count-note"),
    `S002 (TC-062, slice ${STATUS_SLICE}): excluding "In Progress" on top of the default Done exclusion must read "2 filtered out by status"`,
  ).toHaveText("2 filtered out by status");

  // ---- S003: persistence survives a fresh navigation ----
  // Navigate away (project list) and back; the persisted per-project sort and
  // the status exclusion from S002 both survive. The picker selection is
  // ephemeral (divergence note), so persistence is asserted at the integration
  // boundary: GET /issues with NO live sort returns the persisted backlog-rank
  // descending order with In Progress + Done excluded, and the active plugin
  // still declares the field.
  await page.goto("/");
  await page.goto(`/projects/${PROJECT_A}`);
  await expect(
    cardRef(page, REF_NEWEST),
    `S003 (TC-062, slice ${SORT_SLICE}): the cut list must reload after navigating away and back (${REF_NEWEST} expected visible)`,
  ).toBeVisible();
  await expect(
    cardRef(page, REF_UNDERWAY),
    `S003 (TC-062, slice ${STATUS_SLICE}): the persisted "In Progress" exclusion must survive navigation (${REF_UNDERWAY} must stay hidden)`,
  ).toHaveCount(0);

  // The persisted sort drives the cut-list query when the request carries no
  // live sortBy: GET /issues returns backlog-rank descending (newest first),
  // with In Progress and Done excluded. Cross-checked directly at the boundary,
  // the genuine #566/#637 drift guard.
  const issuesRes = await request.get(`/api/projects/${PROJECT_A}/issues?page=1&pageSize=10`);
  expect(
    issuesRes.status(),
    `S003 (TC-062, slice ${SORT_SLICE}): GET /issues must succeed when reading back the persisted sort`,
  ).toBe(200);
  const persistedRefs = (
    (await issuesRes.json()) as { items: Array<{ externalId: string }> }
  ).items.map((i) => i.externalId);
  expect(
    persistedRefs,
    `S003 (TC-062, slice ${SORT_SLICE}): the persisted backlog-rank-descending sort + status exclusions must yield [#302, #303, #301] (newest To Do first, In Progress + Done excluded), got ${JSON.stringify(persistedRefs)}`,
  ).toEqual(["acme/widgets#302", "acme/widgets#303", "acme/widgets#301"]);

  // The sort-fields offering for the active plugin is still discoverable.
  const fieldsRes = await request.get(`/api/projects/${PROJECT_A}/issues/sort-fields`);
  expect(
    fieldsRes.status(),
    `S003 (TC-062, slice ${SORT_SLICE}): GET /issues/sort-fields must succeed for the active plugin`,
  ).toBe(200);
  const fieldsBody = (await fieldsRes.json()) as Array<{ id: string; label: string }>;
  expect(
    fieldsBody.map((f) => f.id),
    `S003 (TC-062, slice ${SORT_SLICE}): Project A's active plugin must still declare the "Backlog rank" (id "updated") sort field, got ${JSON.stringify(fieldsBody)}`,
  ).toContain("updated");

  // ---- S004: Project B is plugin-scoped and independent ----
  // Project B is a different project pinned to a different plugin id
  // (jira-self-hosted). Its sort offering reflects its own active plugin, and
  // its status config is independent: Project A's "In Progress" exclusion must
  // NOT leak into Project B.
  await registerTestProject(request, {
    projectId: PROJECT_B,
    plugin: "jira-self-hosted",
    // Distinct port base so Project B's fixture roubo.yaml does not overlap
    // Project A's port range (the allocator rejects overlapping ranges).
    portBase: 39200,
    integrationConfig: { instance: INSTANCE },
  });

  const bFieldsRes = await request.get(`/api/projects/${PROJECT_B}/issues/sort-fields`);
  expect(
    bFieldsRes.status(),
    `S004 (TC-062, slice ${SORT_SLICE}): GET /issues/sort-fields must succeed for Project B's active plugin`,
  ).toBe(200);
  const bFieldsBody = (await bFieldsRes.json()) as Array<{ id: string; label: string }>;
  expect(
    bFieldsBody.map((f) => f.id),
    `S004 (TC-062, slice ${SORT_SLICE}): Project B's sort offering must come from its own active plugin's getSortFields, got ${JSON.stringify(bFieldsBody)}`,
  ).toContain("updated");

  // Independence: Project B never had "In Progress" excluded, so its cut list
  // still includes the In Progress cut even though Project A excluded it. The
  // load-bearing assertion is that #304 stays present for B.
  const bIssuesRes = await request.get(`/api/projects/${PROJECT_B}/issues?page=1&pageSize=10`);
  expect(
    bIssuesRes.status(),
    `S004 (TC-062, slice ${STATUS_SLICE}): GET /issues must succeed for Project B`,
  ).toBe(200);
  const bRefs = ((await bIssuesRes.json()) as { items: Array<{ externalId: string }> }).items.map(
    (i) => i.externalId,
  );
  expect(
    bRefs,
    `S004 (TC-062, slice ${STATUS_SLICE}): Project A's "In Progress" exclusion must not leak into Project B, so Project B's list must still contain acme/widgets#304, got ${JSON.stringify(bRefs)}`,
  ).toContain("acme/widgets#304");

  // Belt-and-braces: Project A's persisted exclusion is unchanged by reading B.
  const aRecheck = await request.get(`/api/projects/${PROJECT_A}/issues?page=1&pageSize=10`);
  expect(aRecheck.status()).toBe(200);
  const aRecheckRefs = (
    (await aRecheck.json()) as { items: Array<{ externalId: string }> }
  ).items.map((i) => i.externalId);
  expect(
    aRecheckRefs,
    `S004 (TC-062, slice ${STATUS_SLICE}): Project A's config must stay independent of Project B; its In Progress cut acme/widgets#304 must remain excluded, got ${JSON.stringify(aRecheckRefs)}`,
  ).not.toContain("acme/widgets#304");
});
