import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  loadAppShell,
  readSpecManifest,
  registerFixtureProject,
  resetWithScenario,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  SATCA_TC045_ARCHIVE_REASON,
  SATCA_TC045_OWNING_SLICES,
  SATCA_TC045_SIBLING_ONE_PLAN,
  SATCA_TC045_SIBLING_ONE_SLUG,
  SATCA_TC045_SIBLING_TWO_PLAN,
  SATCA_TC045_SIBLING_TWO_SLUG,
  SATCA_TC045_SUBJECT_PLAN,
  SATCA_TC045_SUBJECT_SLUG,
} from "./_support/testbench-plan.js";

// E2E (#778): the authoritative `e2e_flow` drift guard for SATCA-TC-045, the
// spec archival JOURNEY (SATCA-FR-013/FR-015/FR-016, SATCA-US-004/US-005/US-011).
// It runs against the BUILT app and walks the case's S001-S005 in ONE continuous
// session: list the live specs, archive one with a reason, reveal it, load it
// into a bench, restore it.
//
// Deliberately a journey, not a slice re-test. Each transition is driven through
// the REAL UI (row kebab -> menu item -> confirm dialog), never through the API,
// because the point of the unit is that the slices compose: discovery's
// lifecycle read (#765), the picker's hide / reveal / label / select surface
// (#770) and the lifecycle write path all have to agree inside one session for
// the journey to hold. Its precondition ("several live specs and none archived")
// is why it seeds its own fixture: #770's guard starts from a spec already
// archived on disk, and #773's from varied starting manifests, so neither
// fixture can express "none archived".
//
// Drift guard: this spec walks .specifications/spec-and-test-case-archival case
// SATCA-TC-045 step for step (S001-S005). If that case changes, this changes.
//
// Failure-output contract (#778 AC7): every assertion below names the diverging
// step id, the expected-vs-actual at that step, and the owning slice, so a red
// run localises integration drift to one attributable slice. The owning-slice
// map (SATCA_TC045_OWNING_SLICES) documents the one reconciliation against this
// unit's declared blocked-by set: the archive / restore WRITES that S002 and
// S005 drive are owned by #773, which is not in that set, so those two steps
// name #773 alongside the in-set slice whose surface the failure appears on.
//
// Two reconciliations against the literal TC-045 script, both deliberate:
//   - S004 does not say whether the bench is newly created or re-pointed. This
//     takes the CREATE path, which is the picker mode the archived row is
//     already selectable in at that point in the journey, and re-opens the same
//     picker in re-point mode for S005.
//   - S004 asserts only that the spec "loads normally": the focused plan renders
//     with its case and its rollup. It deliberately does not assert the panel's
//     archived indicator, because the archive write of S002 is left UNCOMMITTED
//     by design (Roubo never invokes git), so the bench worktree, provisioned
//     from the fixture repo's HEAD, carries the spec without the record. The
//     panel's archived indicator is #770's own guard
//     (spec-picker-hide-archived.spec.ts), driven from a committed fixture.

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";
const PROJECT_ID = "satca-tc-045-archival-journey";

// The subject spec's single case, listed in the panel once the bench loads it.
const SUBJECT_CASE_ID = SATCA_TC045_SUBJECT_PLAN.cases[0].id;

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), "precondition: read settings").toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(res.status(), "precondition: PUT /api/settings testBench.enabled").toBe(200);
}

async function gotoBenchList(page: Page, projectId: string): Promise<void> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("SATCA-TC-045: archiving a spec removes it from the picker and the control brings it back", async ({
  page,
  request,
}) => {
  await test.step("Precondition: enable the TestBench feature", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying several LIVE specs and none archived", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so S004 can provision a real spec-bound worktree from
      // the fixture repo's HEAD without an origin remote.
      gitInit: true,
      // No `lifecycle` on any spec: each folder gets a plan and no manifest at
      // all, which is the live state the fail-open reader derives (SATCA-FR-017).
      seedSpecs: [
        { slug: SATCA_TC045_SUBJECT_SLUG, testCases: SATCA_TC045_SUBJECT_PLAN },
        { slug: SATCA_TC045_SIBLING_ONE_SLUG, testCases: SATCA_TC045_SIBLING_ONE_PLAN },
        { slug: SATCA_TC045_SIBLING_TWO_SLUG, testCases: SATCA_TC045_SIBLING_TWO_PLAN },
      ],
    });
    expect(projectId).toBe(PROJECT_ID);

    // The precondition asserted on disk before the journey starts: no spec
    // carries a manifest, so none of them is archived.
    for (const slug of [
      SATCA_TC045_SUBJECT_SLUG,
      SATCA_TC045_SIBLING_ONE_SLUG,
      SATCA_TC045_SIBLING_TWO_SLUG,
    ]) {
      const seeded = await readSpecManifest(request, { projectId: PROJECT_ID, slug });
      expect(
        seeded.manifest,
        `precondition diverged: expected ${slug} to start live with no manifest but one was present; owning slice ${SATCA_TC045_OWNING_SLICES.precondition}`,
      ).toBe(null);
    }
  });

  await loadAppShell(page);
  await test.step("Precondition: on the bench list view for the project", async () => {
    await gotoBenchList(page, PROJECT_ID);
    await expect(page.getByText("Bench 1")).toBeVisible();
  });

  // Scope to the spec-picker modal by its accessible name: the empty-slot popover
  // (DialogTrigger) also carries role="dialog". The archive confirm step replaces
  // the picker body inside the SAME dialog, so its heading (which is the dialog's
  // accessible name) changes with it; locating each by the name it then carries is
  // also the assertion that the right step is showing.
  const createDialog = page.getByRole("dialog", { name: "Create a TestBench" });
  const repointDialog = page.getByRole("dialog", { name: "Change focused spec" });
  const archiveDialog = page.getByRole("dialog", { name: "Archive this specification" });

  // A row in the picker's DEFAULT list, i.e. one that is not inside a disclosed
  // group. The archived group (like the all-passed one) is a role="group" child of
  // the selection group, so excluding those children is what distinguishes "listed
  // by default" from "revealed behind a control": once the reveal is on, an
  // archived row is still a visible radio, just not a default-list one.
  const defaultRow = (dialog: Locator, slug: string) =>
    dialog
      .locator('[role="radiogroup"] > div:not([role="group"])')
      .getByRole("radio", { name: new RegExp(`^${slug}`) });
  const revealControl = (dialog: Locator) => dialog.getByRole("button", { name: /^Show archived/ });
  const archivedRegion = (dialog: Locator) => dialog.locator('[aria-label="Archived specs"]');
  const archivedRow = (dialog: Locator, slug: string) =>
    archivedRegion(dialog).getByRole("radio", { name: new RegExp(`^${slug}`) });
  const actionsFor = (dialog: Locator, slug: string) =>
    dialog.getByRole("button", { name: `Actions for ${slug}` });

  // ── S001: open the spec picker and note the listed specs ─────────────────────
  await test.step("S001: open the spec picker and note the listed specs", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(
      createDialog,
      `S001 diverged: expected the spec picker to open but it did not; owning slice ${SATCA_TC045_OWNING_SLICES.s001}`,
    ).toBeVisible();

    // S001-O01: all specs are listed...
    for (const slug of [
      SATCA_TC045_SUBJECT_SLUG,
      SATCA_TC045_SIBLING_ONE_SLUG,
      SATCA_TC045_SIBLING_TWO_SLUG,
    ]) {
      await expect(
        defaultRow(createDialog, slug),
        `S001 diverged: expected ${slug} in the picker's default list but it was not listed; owning slice ${SATCA_TC045_OWNING_SLICES.s001}`,
      ).toBeVisible();
    }
    // ...and no archived group is shown. With nothing archived neither the
    // revealed region nor the control that discloses it is rendered at all, so
    // there is no archived group even to open.
    await expect(
      archivedRegion(createDialog),
      `S001 diverged: expected no archived group with nothing archived but the Archived specs region was present; owning slice ${SATCA_TC045_OWNING_SLICES.s001}`,
    ).toBeHidden();
    await expect(
      revealControl(createDialog),
      `S001 diverged: expected no show-archived control with nothing archived but one was present; owning slice ${SATCA_TC045_OWNING_SLICES.s001}`,
    ).toBeHidden();
  });

  // ── S002: archive one spec, giving a reason ──────────────────────────────────
  await test.step("S002: archive one spec, giving a reason", async () => {
    await actionsFor(createDialog, SATCA_TC045_SUBJECT_SLUG).click();
    await page.getByRole("menuitem", { name: /^Archive/ }).click();
    await expect(
      archiveDialog,
      `S002 diverged: expected the Archive confirm step to open but it did not; owning slice ${SATCA_TC045_OWNING_SLICES.s002}`,
    ).toBeVisible();
    await archiveDialog.getByLabel("Reason (optional)").fill(SATCA_TC045_ARCHIVE_REASON);
    await archiveDialog.getByRole("button", { name: "Archive", exact: true }).click();

    // S002-O01: it disappears from the default list IMMEDIATELY, with no reload
    // and no re-open of the picker.
    //
    // Wait for the confirm step to close and the picker body to come back BEFORE
    // asserting on the list, and assert the subject's absence LAST. The confirm
    // step replaces the picker body inside the same dialog rather than stacking a
    // second one (#773), so while it is up the dialog's accessible name is
    // "Archive this specification" and `createDialog` matches nothing at all:
    // asserting `defaultRow(createDialog, ...).toBeHidden()` here would pass
    // vacuously on a zero-match locator, before the archive had even round-tripped.
    // Ordering it after the sibling loop makes it a real check: the rows are back,
    // the mutation invalidates the spec list in onSettled (after the onSuccess that
    // dismisses the confirm step), so the list re-renders briefly STALE and this
    // assertion only passes once the refetch has actually dropped the subject.
    await expect(
      archiveDialog,
      `S002 diverged: expected the Archive confirm step to close on confirm but it stayed open; owning slice ${SATCA_TC045_OWNING_SLICES.s002}`,
    ).toBeHidden();
    await expect(
      createDialog,
      `S002 diverged: expected the picker body to return after the confirm step but it did not; owning slice ${SATCA_TC045_OWNING_SLICES.s002}`,
    ).toBeVisible();
    // The specs the journey did not touch are unaffected.
    for (const slug of [SATCA_TC045_SIBLING_ONE_SLUG, SATCA_TC045_SIBLING_TWO_SLUG]) {
      await expect(
        defaultRow(createDialog, slug),
        `S002 diverged: expected the untouched spec ${slug} to stay in the default list but it left it; owning slice ${SATCA_TC045_OWNING_SLICES.s002}`,
      ).toBeVisible();
    }
    await expect(
      defaultRow(createDialog, SATCA_TC045_SUBJECT_SLUG),
      `S002 diverged: expected ${SATCA_TC045_SUBJECT_SLUG} to leave the default list on archive but it was still listed; owning slice ${SATCA_TC045_OWNING_SLICES.s002}`,
    ).toBeHidden();

    // What landed on disk, which is what every later step reads back: the reason
    // the reviewer typed is recorded on the spec Roubo does not own.
    const after = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_TC045_SUBJECT_SLUG,
    });
    expect(
      after.manifest?.lifecycle,
      `S002 diverged: expected the manifest to record { archived: true, reason } but it recorded ${JSON.stringify(after.manifest?.lifecycle)}; owning slice ${SATCA_TC045_OWNING_SLICES.s002}`,
    ).toEqual({ archived: true, reason: SATCA_TC045_ARCHIVE_REASON });
  });

  // ── S003: activate the show-archived control ─────────────────────────────────
  await test.step("S003: activate the show-archived control", async () => {
    const control = revealControl(createDialog);
    await expect(
      control,
      `S003 diverged: expected a show-archived control once a spec is archived but none appeared; owning slice ${SATCA_TC045_OWNING_SLICES.s003}`,
    ).toBeVisible();
    await expect(
      control,
      `S003 diverged: expected the show-archived control to start off but it read as pressed; owning slice ${SATCA_TC045_OWNING_SLICES.s003}`,
    ).toHaveAttribute("aria-pressed", "false");
    await control.click();

    const row = archivedRow(createDialog, SATCA_TC045_SUBJECT_SLUG);
    // S003-O01: the archived spec appears...
    await expect(
      row,
      `S003 diverged: expected ${SATCA_TC045_SUBJECT_SLUG} to appear in the Archived specs group but it did not; owning slice ${SATCA_TC045_OWNING_SLICES.s003}`,
    ).toBeVisible();
    // ...labelled...
    await expect(
      row,
      `S003 diverged: expected the revealed row to be labelled "Archived" but that label was absent; owning slice ${SATCA_TC045_OWNING_SLICES.s003}`,
    ).toContainText("Archived");
    // ...with its reason, read back out of what S002 wrote.
    await expect(
      row,
      `S003 diverged: expected the revealed row to show the reason "${SATCA_TC045_ARCHIVE_REASON}" recorded at S002 but it did not; owning slice ${SATCA_TC045_OWNING_SLICES.s003}`,
    ).toContainText(SATCA_TC045_ARCHIVE_REASON);
  });

  // ── S004: load the archived spec into the bench ──────────────────────────────
  await test.step("S004: load the archived spec into the bench", async () => {
    const row = archivedRow(createDialog, SATCA_TC045_SUBJECT_SLUG);
    await row.click();
    await expect(
      row,
      `S004 diverged: expected the revealed archived row to be selectable but selecting it did not check it; owning slice ${SATCA_TC045_OWNING_SLICES.s004}`,
    ).toHaveAttribute("aria-checked", "true");

    const createButton = createDialog.getByRole("button", { name: "Create TestBench" });
    await expect(
      createButton,
      `S004 diverged: expected Create to be enabled for an archived spec but it was disabled; owning slice ${SATCA_TC045_OWNING_SLICES.s004}`,
    ).toBeEnabled();
    await createButton.click();

    // S004-O01: it loads normally. The picker closes, the bench detail view opens,
    // and the bench is bound to the archived spec's plan.
    await expect(
      createDialog,
      `S004 diverged: expected the picker to close on create but it stayed open; owning slice ${SATCA_TC045_OWNING_SLICES.s004}`,
    ).toBeHidden();
    await expect(
      page,
      `S004 diverged: expected to land on the new bench's detail view but the URL did not change; owning slice ${SATCA_TC045_OWNING_SLICES.s004}`,
    ).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/benches/\\d+$`));

    const benches = await request.get(`/api/projects/${PROJECT_ID}/benches`);
    expect(benches.status()).toBe(200);
    const list = (await benches.json()) as Array<{ variant?: string; focusedSpecPath?: string }>;
    const created = list.find((b) => b.variant === "testbench");
    expect(
      created?.focusedSpecPath,
      `S004 diverged: expected the bench to be bound to ${SATCA_TC045_SUBJECT_SLUG}'s test-cases.json but it was bound to ${created?.focusedSpecPath}; owning slice ${SATCA_TC045_OWNING_SLICES.s004}`,
    ).toMatch(new RegExp(`\\.specifications/${SATCA_TC045_SUBJECT_SLUG}/test-cases\\.json$`));

    // "Loads normally" at the surface the reviewer sees: the focused plan renders
    // in the TestBench panel with its case and its rollup, exactly as a live spec
    // would.
    await page
      .getByRole("tablist")
      .getByRole("tab", { name: /^TestBench/ })
      .click();
    const panel = page.getByRole("tabpanel");
    await expect(panel).toBeVisible();
    await showTestBenchCasesView(page);
    await expect(
      panel.getByText(SATCA_TC045_SUBJECT_SLUG, { exact: true }),
      `S004 diverged: expected the archived spec to be the focused spec in the panel header but it was not shown; owning slice ${SATCA_TC045_OWNING_SLICES.s004}`,
    ).toBeVisible();
    await expect(
      panel.getByText(SUBJECT_CASE_ID),
      `S004 diverged: expected the archived spec's case ${SUBJECT_CASE_ID} to be listed but the plan did not load; owning slice ${SATCA_TC045_OWNING_SLICES.s004}`,
    ).toBeVisible();
    await expect(
      panel.getByRole("img", { name: /Overall: 0 passed.*of 1/ }),
      `S004 diverged: expected the archived spec's rollup to render 0 passed of 1 but it did not; owning slice ${SATCA_TC045_OWNING_SLICES.s004}`,
    ).toBeVisible();
  });

  // ── S005: restore the spec from the picker ───────────────────────────────────
  await test.step("S005: restore the spec from the picker", async () => {
    // Re-open the picker from the bench, in re-point mode. It reopens with the
    // reveal off (the control resets on every close), so reaching the archived
    // row means driving the reveal again, from the other picker mode.
    await page.getByRole("button", { name: "Change focused spec" }).click();
    await expect(
      repointDialog,
      `S005 diverged: expected the picker to re-open from the bench but it did not; owning slice ${SATCA_TC045_OWNING_SLICES.s005}`,
    ).toBeVisible();
    await expect(
      defaultRow(repointDialog, SATCA_TC045_SUBJECT_SLUG),
      `S005 diverged: expected ${SATCA_TC045_SUBJECT_SLUG} to still be out of the default list on re-open but it was listed; owning slice ${SATCA_TC045_OWNING_SLICES.s005}`,
    ).toBeHidden();

    await revealControl(repointDialog).click();
    await expect(archivedRow(repointDialog, SATCA_TC045_SUBJECT_SLUG)).toBeVisible();
    await actionsFor(repointDialog, SATCA_TC045_SUBJECT_SLUG).click();
    await page.getByRole("menuitem", { name: /^Restore/ }).click();

    // S005-O01: it returns to the default list...
    await expect(
      defaultRow(repointDialog, SATCA_TC045_SUBJECT_SLUG),
      `S005 diverged: expected ${SATCA_TC045_SUBJECT_SLUG} back in the picker's default list after Restore but it was not listed; owning slice ${SATCA_TC045_OWNING_SLICES.s005}`,
    ).toBeVisible();
    // ...and the archived group empties, leaving the picker as S001 found it:
    // several live specs and none archived.
    await expect(
      archivedRegion(repointDialog),
      `S005 diverged: expected the Archived specs group to empty after the only archived spec was restored but it was still present; owning slice ${SATCA_TC045_OWNING_SLICES.s005}`,
    ).toBeHidden();
    await expect(
      revealControl(repointDialog),
      `S005 diverged: expected the show-archived control to go away with nothing archived but it was still present; owning slice ${SATCA_TC045_OWNING_SLICES.s005}`,
    ).toBeHidden();

    // The reversal landed on disk too: the record is removed, not set false.
    const restored = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_TC045_SUBJECT_SLUG,
    });
    expect(
      Object.prototype.hasOwnProperty.call(restored.manifest ?? {}, "lifecycle"),
      `S005 diverged: expected the lifecycle record to be removed from the manifest but it was still present as ${JSON.stringify(restored.manifest?.lifecycle)}; owning slice ${SATCA_TC045_OWNING_SLICES.s005}`,
    ).toBe(false);
  });
});
